//! Vault recovery: opening the account key with the printed recovery code when
//! the password is gone, then re-wrapping it under a new one.
//!
//! The account key never changes here. Recovery replaces the two wrappers over
//! it and rotates the recovery code; every form data key, form private key,
//! collaborator grant, and the account sharing private key stay valid and
//! untouched, because none of them was ever tied to the password. This is a
//! two-row update, not a vault migration.
//!
//! What the server sees is unchanged too: verifiers and opaque wrapped blobs.
//! The recovery code, the unlock keys derived from it, and the account key
//! itself never leave the browser.

use axum::{
    extract::State,
    response::{IntoResponse, Response},
};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::{
    admin::account_lifecycle::{consume_reauthentication_receipt, presented_session_token},
    auth::extractor::{RecoverySessionUser, SessionUser},
    auth::routes::{
        cleared_session_cookie, drop_presented_session, session_cookie_for, validate_verifier,
        validate_wrapped_account_key, verify_totp_or_recovery,
    },
    client_ip::ClientIp,
    error::{ApiError, ApiJson, ApiResponse, ApiResult},
    mail, password, rate_limit, recovery, session,
    state::AppState,
};

/// How long a pending recovery stays redeemable. The same window the pending
/// signup uses, and long enough to find a printed code.
const PENDING_TTL_SECONDS: i64 = 15 * 60;

#[derive(Deserialize)]
pub struct RecoverStartBody {
    email: String,
}

/// Step one: mail a six-digit code and hand back the handle that ties the rest
/// of the flow together.
///
/// The response is identical for an address with no account. A real record and
/// a decoy are built the same way, stored the same way, and answered with the
/// same body; only the mail differs, and only the address's owner sees that.
/// The decoy is not an optimisation to skip: an unknown address answering
/// faster or differently is the account-enumeration oracle this whole shape
/// exists to close.
pub async fn recover_start(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    ApiJson(body): ApiJson<RecoverStartBody>,
) -> Result<Response, ApiError> {
    // Canonical before anything is keyed, looked up or mailed, so the limit
    // below, the account lookup and the recipient all name the same inbox.
    let email = mail::canonical_address(&body.email)
        .ok_or_else(|| ApiError::BadRequest("Enter a valid email address".to_string()))?;

    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("recover_start:{}", client_ip),
        state.config.recover_start_rate_limit,
        3600,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    // A second limit keyed on the address, so rotating IPs cannot mail-bomb one
    // inbox. The key holds a hash rather than the address: Redis should not
    // accumulate a list of who has ever tried to recover an account.
    let mut hasher = Sha256::new();
    hasher.update(email.as_bytes());
    let email_key = format!("recover_start_email:{:x}", hasher.finalize());
    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &email_key,
        state.config.recover_start_rate_limit,
        3600,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    // A suspended or deleting account is treated exactly like an absent one.
    // Recovery must not become a way to learn that an address is in either
    // state, and must not resurrect an account an operator has stopped.
    let user_id = sqlx::query_scalar!(
        "SELECT id FROM users \
         WHERE email = $1 AND suspended_at IS NULL AND deletion_started_at IS NULL",
        email,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let decoy = user_id.is_none();

    let code = crate::email_verify::generate_code();
    let record = recovery::PendingRecovery {
        email: email.clone(),
        user_id,
        code_hash: crate::email_verify::hash_code(&code),
        attempts: 0,
        decoy,
        expires_at: OffsetDateTime::now_utc() + Duration::seconds(PENDING_TTL_SECONDS),
    };
    let pending_token = recovery::create_pending(&mut state.redis, &record)
        .await
        .map_err(ApiError::Internal)?;

    let mail = if decoy {
        mail::no_account_mail(&email)
    } else {
        mail::recovery_code_mail(&email, &code, (PENDING_TTL_SECONDS / 60) as u64)
    };
    if let Err(error) = state.mailer.send(mail).await {
        // Leaving the record behind would strand the caller holding a handle
        // for a code that was never delivered.
        let _ = recovery::delete_pending(&mut state.redis, &pending_token).await;
        log_mail_failure(&error);
        return Err(ApiError::Internal(anyhow::anyhow!("mail send failed")));
    }

    Ok(ApiResponse::ok(json!({ "pending_token": pending_token })).into_response())
}

fn log_mail_failure(_error: &anyhow::Error) {
    tracing::error!(
        correlation_id = %Uuid::now_v7(),
        failure_kind = "smtp_delivery",
        operation = "recover_start",
        "recovery mail operation failed"
    );
}

#[derive(Deserialize)]
pub struct RecoverVerifyBody {
    pending_token: String,
    email_code: String,
    /// `deriveRecoveryVerifier` over the unlock key the browser derived from
    /// the printed code. The code itself never reaches the server.
    recovery_verifier: String,
    /// Required when the account has TOTP enrolled, ignored otherwise.
    #[serde(default)]
    totp_code: Option<String>,
}

/// Step two: check every factor, then mint a recovery-scoped session and hand
/// back the wrapper the recovery code opens.
///
/// Every failure below answers with the same generic `Unauthorized`. A wrong
/// emailed code, a wrong recovery verifier, an account with no live recovery
/// code, and a wrong TOTP code are indistinguishable to the caller: which
/// factor failed is not something the response may reveal.
pub async fn recover_verify(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    jar: CookieJar,
    ApiJson(body): ApiJson<RecoverVerifyBody>,
) -> Result<Response, ApiError> {
    // Before the rate limiter, so a garbage body cannot spend an IP's budget.
    validate_verifier(&body.recovery_verifier)?;

    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("recover_verify:{}", client_ip),
        state.config.recover_verify_rate_limit,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let record = match recovery::verify_code(
        &mut state.redis,
        &body.pending_token,
        &body.email_code,
        state.config.recover_max_attempts,
    )
    .await
    .map_err(ApiError::Internal)?
    {
        recovery::VerifyCodeResult::Authorized(record) => record,
        recovery::VerifyCodeResult::Rejected => return Err(ApiError::Unauthorized),
    };
    // A decoy never authorizes, so a record without a user id here would be a
    // bug rather than a reachable state; refuse it as unauthorized regardless.
    let Some(user_id) = record.user_id else {
        return Err(ApiError::Unauthorized);
    };

    let stored = sqlx::query!(
        "SELECT id, verifier_hash FROM vault_recovery_codes \
         WHERE user_id = $1 AND used_at IS NULL",
        user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let Some(stored) = stored else {
        // No live recovery code for this user. Verify against a dummy hash
        // anyway (discarding the result) so this path pays the same Argon2
        // cost as a real verifier mismatch below, because otherwise the faster
        // response here leaks "this account has no unused recovery code" to
        // anyone holding a valid emailed code.
        password::spend_verification_cost(&body.recovery_verifier);
        return Err(ApiError::Unauthorized);
    };
    if !password::verify_secret(&body.recovery_verifier, &stored.verifier_hash)
        .map_err(ApiError::Internal)?
    {
        return Err(ApiError::Unauthorized);
    }

    // The second factor still applies. Recovery replaces the password, so
    // without this an attacker holding a leaked recovery code would bypass the
    // very control the account enrolled to stop exactly that.
    let account = sqlx::query(
        "SELECT email, totp_secret, totp_enabled, session_generation
         FROM users
         WHERE id = $1
           AND suspended_at IS NULL
           AND deletion_started_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;

    if account.get::<bool, _>("totp_enabled") {
        let Some(secret) = account.get::<Option<Vec<u8>>, _>("totp_secret") else {
            return Err(ApiError::Unauthorized);
        };
        let Some(code) = body.totp_code.as_deref() else {
            return Err(ApiError::Unauthorized);
        };
        // Shared with the login path, so the accepted timestep is claimed with
        // SET NX here too and an observed code is dead for the rest of its 30
        // seconds. A TOTP recovery code is accepted as well, which is the case
        // where the phone is gone along with the password.
        let ok = verify_totp_or_recovery(
            &mut state,
            user_id,
            &secret,
            account.get::<String, _>("email").as_str(),
            code,
        )
        .await?;
        if !ok {
            return Err(ApiError::Unauthorized);
        }
    }

    // Read before anything is minted, so a failure here cannot leave a live
    // recovery session behind for a response that never arrives.
    let wrapped_account_key = sqlx::query_scalar!(
        "SELECT wrapped_account_key FROM account_key_wrappers \
         WHERE user_id = $1 AND method = 'recovery_code'",
        user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;

    // The handle has done its work; the session below carries the flow from
    // here, scoped to the completion route alone. A failed delete is not worth
    // failing the request over: the record still expires on its own, and every
    // factor above is required again to get anything out of it.
    let _ = recovery::delete_pending(&mut state.redis, &body.pending_token).await;

    drop_presented_session(&mut state, &jar).await;
    let token = session::create_scoped_session(
        &mut state.redis,
        user_id,
        account.get::<i64, _>("session_generation"),
        session::SecondFactor::Verified,
        session::SessionScope::Recovery,
        session::RECOVERY_SESSION_TTL_SECS,
    )
    .await
    .map_err(ApiError::Internal)?;
    let jar = jar.add(session_cookie_for(
        token,
        Duration::seconds(session::RECOVERY_SESSION_TTL_SECS),
    ));

    Ok((
        jar,
        ApiResponse::ok(json!({ "wrapped_account_key": wrapped_account_key })),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct RecoverCompleteBody {
    new_password_verifier: String,
    wrapped_account_key_password: String,
    new_recovery_verifier: String,
    wrapped_account_key_recovery: String,
}

/// Step three: install the new password and the new recovery code.
///
/// Both wrappers hold the *same* account key the browser just opened, sealed
/// under two new unlock keys. Nothing else in the vault moves, which is the
/// entire reason this flow is cheap: no form key, no collaborator grant, and no
/// stored ciphertext is touched or re-encrypted.
///
/// One transaction, so a half-rotated account cannot exist. If it rolls back,
/// the old password and the old recovery code both still work and the client
/// can retry with the account key it is still holding in memory.
pub async fn recover_complete(
    State(mut state): State<AppState>,
    user: RecoverySessionUser,
    jar: CookieJar,
    ApiJson(body): ApiJson<RecoverCompleteBody>,
) -> Result<Response, ApiError> {
    validate_verifier(&body.new_password_verifier)?;
    validate_verifier(&body.new_recovery_verifier)?;
    validate_wrapped_account_key(&body.wrapped_account_key_password)?;
    validate_wrapped_account_key(&body.wrapped_account_key_recovery)?;

    // Hashed outside the transaction: Argon2 is deliberately slow, and holding
    // row locks across it for no reason would be a self-inflicted contention
    // problem.
    let password_hash =
        password::hash_auth_verifier(&body.new_password_verifier).map_err(ApiError::Internal)?;
    let recovery_hash =
        password::hash_secret(&body.new_recovery_verifier).map_err(ApiError::Internal)?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Bumping the generation is what revokes every existing session, this
    // recovery session included: the extractors compare against this column.
    let rotated = sqlx::query!(
        "UPDATE users \
         SET password_hash = $2, session_generation = session_generation + 1 \
         WHERE id = $1 AND suspended_at IS NULL AND deletion_started_at IS NULL",
        user.user_id,
        password_hash,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if rotated.rows_affected() != 1 {
        return Err(ApiError::Unauthorized);
    }

    // Both wrappers must already exist: an account is created with exactly two,
    // and this flow replaces rather than enrols. Updating zero rows would leave
    // the account holding a wrapper for the password that was just replaced,
    // which is a locked-out vault, so it fails the whole transaction instead.
    update_wrapper(
        &mut tx,
        user.user_id,
        "password",
        &body.wrapped_account_key_password,
    )
    .await?;
    update_wrapper(
        &mut tx,
        user.user_id,
        "recovery_code",
        &body.wrapped_account_key_recovery,
    )
    .await?;

    // Marked spent before the replacement is inserted: the partial unique index
    // is over (user_id) WHERE used_at IS NULL, so inserting first would collide
    // with the row being retired. The used_at guard also means two racing
    // completions cannot both spend the same code: the loser updates no rows.
    let spent = sqlx::query!(
        "UPDATE vault_recovery_codes SET used_at = now() \
         WHERE user_id = $1 AND used_at IS NULL",
        user.user_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if spent.rows_affected() != 1 {
        return Err(ApiError::Unauthorized);
    }

    sqlx::query!(
        "INSERT INTO vault_recovery_codes (id, user_id, verifier_hash) VALUES ($1, $2, $3)",
        Uuid::now_v7(),
        user.user_id,
        recovery_hash,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    tx.commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // The generation bump already invalidated every session; this sweeps the
    // Redis index rather than leaving dead records to expire on their own.
    session::delete_all_sessions_for_user(&mut state.redis, user.user_id)
        .await
        .map_err(ApiError::Internal)?;

    // No session is issued here. The account has a new password now, and the
    // user signs in with it like anyone else; minting one would hand a full
    // session to a flow that only ever proved a recovery code. The dead cookie
    // is cleared so the browser is not left presenting a revoked handle.
    Ok((
        jar.remove(cleared_session_cookie()),
        ApiResponse::ok(json!({ "ok": true })),
    )
        .into_response())
}

async fn update_wrapper(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    method: &str,
    wrapped_account_key: &str,
) -> Result<(), ApiError> {
    let updated = sqlx::query!(
        "UPDATE account_key_wrappers \
         SET wrapped_account_key = $3, updated_at = now() \
         WHERE user_id = $1 AND method = $2",
        user_id,
        method,
        wrapped_account_key,
    )
    .execute(&mut **tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "account key wrapper missing for a recovering account"
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct RegenerateRecoveryCodeBody {
    reauthentication_receipt: String,
    recovery_verifier: String,
    wrapped_account_key_recovery: String,
}

/// Mints a replacement vault recovery code for an already-signed-in user.
///
/// A recovery code is shown exactly once at signup; if it is lost there was
/// previously no way to get another, since the only thing that mints one is
/// completing a recovery, which needs the code the user no longer has. This
/// closes that gap the same way `recover_complete` rotates the code, minus the
/// password wrapper and the session bump: the account key itself is unchanged,
/// so nothing else in the vault moves and the user's session stays valid.
///
/// Requires a reauthentication receipt rather than the session alone: without
/// it, anyone with a moment at an unlocked browser could mint themselves a
/// standing way back into the vault that survives a later password change.
pub async fn regenerate_recovery_code(
    State(state): State<AppState>,
    user: SessionUser,
    jar: CookieJar,
    ApiJson(body): ApiJson<RegenerateRecoveryCodeBody>,
) -> ApiResult<serde_json::Value> {
    validate_verifier(&body.recovery_verifier)?;
    validate_wrapped_account_key(&body.wrapped_account_key_recovery)?;

    let session_token = presented_session_token(&jar)?;
    let mut redis = state.redis.clone();
    let receipt_valid = consume_reauthentication_receipt(
        &mut redis,
        user.user_id,
        &session_token,
        &body.reauthentication_receipt,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !receipt_valid {
        return Err(ApiError::Unauthorized);
    }

    let recovery_hash =
        password::hash_secret(&body.recovery_verifier).map_err(ApiError::Internal)?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    update_wrapper(
        &mut tx,
        user.user_id,
        "recovery_code",
        &body.wrapped_account_key_recovery,
    )
    .await?;

    // Marked spent before the replacement is inserted: the partial unique
    // index is over (user_id) WHERE used_at IS NULL, so inserting first would
    // collide with the row being retired. The used_at guard also makes two
    // racing regenerations mutually exclusive.
    let spent = sqlx::query!(
        "UPDATE vault_recovery_codes SET used_at = now() \
         WHERE user_id = $1 AND used_at IS NULL",
        user.user_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if spent.rows_affected() != 1 {
        return Err(ApiError::Unauthorized);
    }

    sqlx::query!(
        "INSERT INTO vault_recovery_codes (id, user_id, verifier_hash) VALUES ($1, $2, $3)",
        Uuid::now_v7(),
        user.user_id,
        recovery_hash,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    tx.commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Session generation is deliberately not bumped: the password and every
    // session are unchanged, so revoking sessions here would be gratuitous.
    Ok(ApiResponse::ok(json!({ "ok": true })))
}
