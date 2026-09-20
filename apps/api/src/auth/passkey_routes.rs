use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
use webauthn_rs::prelude::{
    DiscoverableAuthentication, DiscoverableKey, Passkey, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential,
};

use crate::{
    auth::{
        extractor::SessionUser,
        routes::{drop_presented_session, session_cookie, validate_wrapped_account_key},
    },
    client_ip::ClientIp,
    error::{ApiError, ApiJson, ApiPath, ApiResponse, ApiResult},
    passkey, rate_limit, session,
    state::AppState,
};

const REGISTER_CEREMONY: &str = "register";

#[derive(Deserialize)]
pub struct RegisterStartBody {
    reauthentication_receipt: String,
}

/// Begins enrolment.
///
/// `user_unique_id` is the krypta user id and must stay that way:
/// `identify_discoverable_authentication` returns exactly this value at login,
/// and it is the only thing that names the account. It is written onto the
/// authenticator and is readable by anyone holding the device, which is
/// acceptable because a UUIDv7 identifies no person and grants no access, but
/// it means the value must never be treated as a secret.
///
/// A fresh password proof is required to begin, for the same reason as TOTP
/// enrolment: a passkey is a standing way into the account and the vault, so a
/// session alone must not be able to add one. The ceremony token issued here
/// is bound to this user and consumed by `register_finish`, so gating the
/// start gates the whole ceremony.
pub async fn register_start(
    State(mut state): State<AppState>,
    jar: CookieJar,
    user: SessionUser,
    ApiJson(body): ApiJson<RegisterStartBody>,
) -> ApiResult<serde_json::Value> {
    crate::admin::account_lifecycle::require_reauthentication(
        &mut state.redis,
        user.user_id,
        &jar,
        &body.reauthentication_receipt,
    )
    .await?;

    let row = sqlx::query!("SELECT email FROM users WHERE id = $1", user.user_id)
        .fetch_one(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Excluding what is already enrolled stops a device silently replacing its
    // own credential, which would orphan the wrapper that opens the vault.
    let existing = sqlx::query_scalar!(
        "SELECT credential FROM passkey_credentials WHERE user_id = $1",
        user.user_id
    )
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let exclude: Vec<_> = existing
        .into_iter()
        .filter_map(|value| serde_json::from_value::<Passkey>(value).ok())
        .map(|key| key.cred_id().clone())
        .collect();

    let (options, registration) = state
        .webauthn
        .start_passkey_registration(
            user.user_id,
            &row.email,
            &row.email,
            if exclude.is_empty() {
                None
            } else {
                Some(exclude)
            },
        )
        .map_err(|error| ApiError::Internal(anyhow::anyhow!("webauthn start: {error}")))?;

    // The stashed state carries the session's user id alongside the
    // registration state, so `register_finish` can refuse a handle minted for
    // someone else even though Redis keys purely on the token hash.
    let ceremony_token = passkey::stash(
        &mut state.redis,
        REGISTER_CEREMONY,
        &(user.user_id, registration),
    )
    .await
    .map_err(ApiError::Internal)?;

    Ok(ApiResponse::ok(json!({
        "ceremony_token": ceremony_token,
        "options": options,
    })))
}

#[derive(Deserialize)]
pub struct RegisterFinishBody {
    ceremony_token: String,
    credential: RegisterPublicKeyCredential,
    /// The account key sealed under the passkey unlock key, wrapped in the
    /// browser. The server stores it and can never open it.
    wrapped_account_key: String,
    nickname: Option<String>,
}

pub async fn register_finish(
    State(mut state): State<AppState>,
    user: SessionUser,
    ApiJson(body): ApiJson<RegisterFinishBody>,
) -> ApiResult<serde_json::Value> {
    // Checked before the ceremony token is consumed: a request that cannot
    // possibly succeed should not burn the user's ceremony.
    validate_wrapped_account_key(&body.wrapped_account_key)?;

    // Consumed before verification, so a failed attempt cannot be retried
    // against the same challenge.
    let Some((owner_id, registration)): Option<(Uuid, PasskeyRegistration)> =
        passkey::take(&mut state.redis, REGISTER_CEREMONY, &body.ceremony_token)
            .await
            .map_err(ApiError::Internal)?
    else {
        return Err(ApiError::Unauthorized);
    };

    // The handle only ever redeems for the session that started the ceremony.
    // Same response as an unknown handle: telling the two apart would leak
    // whether a live handle exists for another account.
    if owner_id != user.user_id {
        return Err(ApiError::Unauthorized);
    }

    let passkey_credential = state
        .webauthn
        .finish_passkey_registration(&body.credential, &registration)
        // Generic on purpose: the library's error text describes exactly which
        // check failed, which is a gift to anyone probing the endpoint.
        .map_err(|_| ApiError::Unauthorized)?;

    let credential_id = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        passkey_credential.cred_id(),
    );
    let credential_json = serde_json::to_value(&passkey_credential)
        .map_err(|error| ApiError::Internal(error.into()))?;
    let credential_row_id = Uuid::now_v7();
    let nickname = body
        .nickname
        .map(|value| value.trim().chars().take(64).collect::<String>())
        .filter(|value| !value.is_empty());

    // Both rows in one transaction, the idiom `ensure_verified_user` uses for
    // the first two wrappers. A credential without its wrapper would be a
    // passkey that logs in and cannot open the vault.
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    sqlx::query!(
        "INSERT INTO passkey_credentials (id, user_id, credential_id, credential, nickname)
         VALUES ($1, $2, $3, $4, $5)",
        credential_row_id,
        user.user_id,
        credential_id,
        credential_json,
        nickname,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| match &error {
        // The exclude-credentials list sent to the authenticator is only a
        // client-side hint, so a non-compliant client can still submit a
        // credential id that is already enrolled, on this account or another.
        // Refuse rather than upsert: silently rebinding a credential that
        // belongs to a different account must never happen.
        sqlx::Error::Database(db_err)
            if db_err.is_unique_violation()
                && db_err.constraint() == Some("passkey_credentials_credential_id_idx") =>
        {
            ApiError::Conflict
        }
        _ => ApiError::Internal(error.into()),
    })?;

    sqlx::query!(
        "INSERT INTO account_key_wrappers (id, user_id, method, wrapped_account_key, credential_id)
         VALUES ($1, $2, 'passkey', $3, $4)",
        Uuid::now_v7(),
        user.user_id,
        body.wrapped_account_key,
        credential_row_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    tx.commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(json!({ "id": credential_row_id })))
}

const LOGIN_CEREMONY: &str = "login";

pub async fn login_start(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
) -> ApiResult<serde_json::Value> {
    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("passkey_login:{}", client_ip),
        state.config.passkey_rate_limit,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    // Issued for nobody in particular. An email-first flow would need an
    // endpoint that reports whether an address has an account and how many
    // passkeys it holds, which is the enumeration oracle migration 0015
    // removed when it dropped users.master_key_salt.
    let (options, authentication) = state
        .webauthn
        .start_discoverable_authentication()
        .map_err(|error| ApiError::Internal(anyhow::anyhow!("webauthn start: {error}")))?;

    let ceremony_token = passkey::stash(&mut state.redis, LOGIN_CEREMONY, &authentication)
        .await
        .map_err(ApiError::Internal)?;

    Ok(ApiResponse::ok(json!({
        "ceremony_token": ceremony_token,
        "options": options,
    })))
}

#[derive(Deserialize)]
pub struct LoginFinishBody {
    ceremony_token: String,
    credential: PublicKeyCredential,
}

/// Completes a passkey login: session and wrapper in one response.
///
/// No TOTP step. A passkey assertion with user verification is possession of
/// the authenticator plus a biometric or device PIN, and it is
/// phishing-resistant in a way TOTP is not, so it is strictly stronger than
/// password plus code. `second_factor_verified` is therefore true, which is
/// what admin/guard.rs reads.
pub async fn login_finish(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    jar: CookieJar,
    ApiJson(body): ApiJson<LoginFinishBody>,
) -> Result<Response, ApiError> {
    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("passkey_login:{}", client_ip),
        state.config.passkey_rate_limit,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let Some(authentication): Option<DiscoverableAuthentication> =
        passkey::take(&mut state.redis, LOGIN_CEREMONY, &body.ceremony_token)
            .await
            .map_err(ApiError::Internal)?
    else {
        return Err(ApiError::Unauthorized);
    };

    // The user comes from the WebAuthn user handle, which is the users.id
    // supplied at registration. The credential id only selects which of that
    // user's passkeys to verify against.
    let (user_id, credential_id) = state
        .webauthn
        .identify_discoverable_authentication(&body.credential)
        .map_err(|_| ApiError::Unauthorized)?;
    let credential_id = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        credential_id,
    );

    let stored = sqlx::query!(
        "SELECT c.id, c.credential, u.session_generation
         FROM passkey_credentials c
         JOIN users u ON u.id = c.user_id
         WHERE c.user_id = $1
           AND c.credential_id = $2
           AND u.suspended_at IS NULL
           AND u.deletion_started_at IS NULL",
        user_id,
        credential_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    // Same error an invalid signature produces. Distinguishing them would tell
    // a caller whether a credential id names a real account.
    .ok_or(ApiError::Unauthorized)?;

    let mut stored_passkey: Passkey = serde_json::from_value(stored.credential)
        .map_err(|error| ApiError::Internal(error.into()))?;

    let result = state
        .webauthn
        .finish_discoverable_authentication(
            &body.credential,
            authentication,
            &[DiscoverableKey::from(&stored_passkey)],
        )
        .map_err(|_| ApiError::Unauthorized)?;

    // Without this the signature counter stays frozen and the crate's
    // cloned-authenticator detection silently stops working.
    if stored_passkey.update_credential(&result) == Some(true) {
        let updated = serde_json::to_value(&stored_passkey)
            .map_err(|error| ApiError::Internal(error.into()))?;
        sqlx::query!(
            "UPDATE passkey_credentials SET credential = $2, last_used_at = now() WHERE id = $1",
            stored.id,
            updated,
        )
        .execute(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    } else {
        sqlx::query!(
            "UPDATE passkey_credentials SET last_used_at = now() WHERE id = $1",
            stored.id,
        )
        .execute(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    }

    let wrapped_account_key = sqlx::query_scalar!(
        "SELECT wrapped_account_key FROM account_key_wrappers WHERE credential_id = $1",
        stored.id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;

    // Closes session fixation, matching login and verify-email.
    drop_presented_session(&mut state, &jar).await;

    let token = session::create_session(
        &mut state.redis,
        user_id,
        stored.session_generation,
        session::SecondFactor::Verified,
    )
    .await
    .map_err(ApiError::Internal)?;
    let jar = jar.add(session_cookie(token));

    Ok((
        jar,
        ApiResponse::ok(json!({
            "user_id": user_id,
            "wrapped_account_key": wrapped_account_key,
        })),
    )
        .into_response())
}

pub async fn list(
    State(state): State<AppState>,
    user: SessionUser,
) -> ApiResult<serde_json::Value> {
    let rows = sqlx::query!(
        "SELECT id, nickname, created_at, last_used_at
         FROM passkey_credentials
         WHERE user_id = $1
         ORDER BY created_at",
        user.user_id
    )
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    // RFC3339 explicitly. `time`'s default Serialize emits a numeric array,
    // which shipped once as "Invalid Date" in the owner's close date field.
    let format = &time::format_description::well_known::Rfc3339;
    let passkeys: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id,
                "nickname": row.nickname,
                "created_at": row.created_at.format(format).ok(),
                "last_used_at": row.last_used_at.and_then(|at| at.format(format).ok()),
            })
        })
        .collect();

    Ok(ApiResponse::ok(json!({ "passkeys": passkeys })))
}

/// Removes a passkey. The wrapper cascades with it.
///
/// Always safe: the `password` wrapper is written by `ensure_verified_user` and
/// cannot be deleted, so there is no state in which a user deletes their way
/// out of their own vault.
pub async fn delete(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath(id): ApiPath<Uuid>,
) -> ApiResult<serde_json::Value> {
    // Scoped by user_id, so another account's credential is Not Found rather
    // than Forbidden and the endpoint does not confirm the id exists.
    let deleted = sqlx::query!(
        "DELETE FROM passkey_credentials WHERE id = $1 AND user_id = $2",
        id,
        user.user_id
    )
    .execute(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if deleted.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(ApiResponse::ok(json!({})))
}
