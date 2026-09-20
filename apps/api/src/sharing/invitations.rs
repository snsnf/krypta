//! Inviting someone to a form, and their side of accepting it.
//!
//! Two actors in one lifecycle. The owner's half mints a capability, mails it
//! and can revoke it; the recipient's half exchanges the emailed token for an
//! HttpOnly cookie and decides. They are kept together because they share the
//! `form_invitations` state machine, and apart from membership and form
//! lifecycle because they share nothing else.

use axum::{
    extract::State,
    response::{IntoResponse, Response},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use time::Duration;
use uuid::Uuid;

use crate::sharing::access::{lock_and_require_owner, require_owner};
use crate::{
    auth::extractor::SessionUser,
    client_ip::ClientIp,
    error::{ApiError, ApiJson, ApiPath, ApiResponse, ApiResult},
    mail,
    sharing::{
        continuation,
        keys::SHARING_KEY_VERSION,
        models::{
            ContinueInvitationBody, CurrentInvitationResponse, FormRole,
            InvitationAcceptanceResponse, InvitationBody, InvitationResponse, RecipientKeyBody,
            RecipientKeyResponse,
        },
    },
    state::AppState,
};

const INVITATION_CONTINUATION_SECONDS: i64 = 30 * 60;

fn invitation_cookie(value: String) -> Cookie<'static> {
    Cookie::build(("__Host-invite", value))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(Duration::seconds(INVITATION_CONTINUATION_SECONDS))
        .build()
}

fn cleared_invitation_cookie() -> Cookie<'static> {
    Cookie::build(("__Host-invite", ""))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(Duration::seconds(0))
        .build()
}

fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "***".to_string();
    };
    let first = local.chars().next().unwrap_or('*');
    format!("{first}***@{domain}")
}

async fn invitation_from_continuation(
    state: &AppState,
    jar: &CookieJar,
) -> Result<(String, Uuid), ApiError> {
    let cookie = jar
        .get("__Host-invite")
        .map(|cookie| cookie.value().to_string())
        .ok_or(ApiError::NotFound)?;
    let mut redis = state.redis.clone();
    let invitation_id = continuation::load(&mut redis, &cookie)
        .await
        .map_err(ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;
    Ok((cookie, invitation_id))
}

async fn exact_invited_account(
    transaction: &mut Transaction<'_, Postgres>,
    invitation_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    sqlx::query_scalar!(
        "SELECT EXISTS(
            SELECT 1
            FROM users
            JOIN form_invitations ON form_invitations.id = $2
            WHERE users.id = $1 AND users.email = form_invitations.invited_email
         )",
        user_id,
        invitation_id,
    )
    .fetch_one(&mut **transaction)
    .await
    .map(|matches| matches.unwrap_or(false))
    .map_err(|error| ApiError::Internal(error.into()))
}

/// The invited address in the one form it is stored, limited and mailed in.
///
/// Surrounding whitespace is trimmed here, unlike at registration, because no
/// key is derived from an invited address: it is only compared with the
/// recipient's account address and mailed. Anything else `canonical_address`
/// would refuse, such as a display name, is still refused, so every spelling
/// that reaches one inbox shares one rate-limit counter.
fn normalized_email(email: &str) -> Result<String, ApiError> {
    crate::mail::canonical_address(email.trim())
        .ok_or_else(|| ApiError::BadRequest("Invalid request".into()))
}

fn validate_invitation_body(body: &InvitationBody) -> Result<(), ApiError> {
    if matches!(body.role, FormRole::Owner) {
        return Err(ApiError::BadRequest("Invalid request".into()));
    }

    let ciphertexts_complete = matches!(
        (
            body.encrypted_form_data_key.as_ref(),
            body.encrypted_form_private_key.as_ref(),
        ),
        (Some(_), Some(_)) | (None, None)
    );
    let ciphertexts_need_public_key =
        body.encrypted_form_data_key.is_some() && body.recipient_sharing_public_key.is_none();
    if !ciphertexts_complete || ciphertexts_need_public_key {
        return Err(ApiError::BadRequest("Invalid request".into()));
    }
    Ok(())
}

async fn check_invitation_limits(
    state: &mut AppState,
    owner_id: Uuid,
    form_id: Uuid,
    invited_email: &str,
) -> Result<(), ApiError> {
    let recipient_hash = format!("{:x}", Sha256::digest(invited_email.as_bytes()));
    let limits = [
        (
            format!("invite_owner_hour:{owner_id}"),
            state.config.invite_rate_limit_per_hour,
            60 * 60,
        ),
        (
            format!("invite_owner_day:{owner_id}"),
            state.config.invite_rate_limit_per_day,
            24 * 60 * 60,
        ),
        (
            format!("invite_recipient_hour:{form_id}:{recipient_hash}"),
            state.config.invite_recipient_rate_limit_per_hour,
            60 * 60,
        ),
    ];
    for (key, maximum, window) in limits {
        let allowed = crate::rate_limit::check_rate_limit(&mut state.redis, &key, maximum, window)
            .await
            .map_err(ApiError::Internal)?;
        if !allowed {
            return Err(ApiError::RateLimited);
        }
    }
    Ok(())
}

pub async fn recipient_key(
    State(mut state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    user: SessionUser,
    ApiJson(body): ApiJson<RecipientKeyBody>,
) -> ApiResult<RecipientKeyResponse> {
    require_owner(&state.db, form_id, user.user_id).await?;
    // This answers "does an account exist for this address" to any Owner, which
    // is the enumeration oracle the rest of the API is careful not to expose.
    // Sharing needs it, so it stays, but metered at the same hourly rate as the
    // invitations it exists to prepare: nobody legitimately looks up more
    // recipients than they can invite.
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("recipient_key_owner_hour:{}", user.user_id),
        state.config.invite_rate_limit_per_hour,
        60 * 60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }
    let email = normalized_email(&body.invited_email)?;
    let recipient = sqlx::query!(
        "SELECT sharing_public_key, sharing_key_version FROM users WHERE email = $1",
        email,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(RecipientKeyResponse {
        sharing_public_key: recipient
            .as_ref()
            .and_then(|row| row.sharing_public_key.clone()),
        sharing_key_version: recipient.and_then(|row| row.sharing_key_version),
    }))
}

pub async fn create_invitation(
    State(mut state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    user: SessionUser,
    ApiJson(body): ApiJson<InvitationBody>,
) -> ApiResult<InvitationResponse> {
    send_invitation(&mut state, form_id, None, user.user_id, body).await
}

pub async fn resend_invitation(
    State(mut state): State<AppState>,
    ApiPath((form_id, invitation_id)): ApiPath<(Uuid, Uuid)>,
    user: SessionUser,
    ApiJson(body): ApiJson<InvitationBody>,
) -> ApiResult<InvitationResponse> {
    send_invitation(&mut state, form_id, Some(invitation_id), user.user_id, body).await
}

/// The key material an invitation carries, or nothing.
///
/// This was six interdependent bindings in the middle of `send_invitation`'s
/// transaction, so the rule that makes it safe had to be reassembled from a
/// conjunction spread over ten lines. The rule is: a grant travels only when
/// it was sealed to the exact key the recipient still holds, at the current
/// key version, and only when both halves are present. Anything else stores
/// nothing, so a recipient who rotated their key mid-flight is never handed a
/// grant they cannot open. All three fields move together by construction.
#[derive(Default)]
struct SealedGrant {
    public_key: Option<String>,
    data_key: Option<String>,
    private_key: Option<String>,
}

fn sealed_grant_for(
    body: &InvitationBody,
    recipient_public_key: Option<&str>,
    recipient_key_version: Option<i16>,
) -> SealedGrant {
    let sealed_to_the_key_they_hold = body.recipient_sharing_public_key.is_some()
        && body.recipient_sharing_public_key.as_deref() == recipient_public_key
        && recipient_key_version == Some(SHARING_KEY_VERSION);
    let both_halves_present =
        body.encrypted_form_data_key.is_some() && body.encrypted_form_private_key.is_some();

    if !(sealed_to_the_key_they_hold && both_halves_present) {
        return SealedGrant::default();
    }
    SealedGrant {
        public_key: body.recipient_sharing_public_key.clone(),
        data_key: body.encrypted_form_data_key.clone(),
        private_key: body.encrypted_form_private_key.clone(),
    }
}

async fn send_invitation(
    state: &mut AppState,
    form_id: Uuid,
    requested_invitation_id: Option<Uuid>,
    owner_id: Uuid,
    body: InvitationBody,
) -> ApiResult<InvitationResponse> {
    validate_invitation_body(&body)?;
    let email = normalized_email(&body.invited_email)?;

    // Fast authorization prevents unrelated callers from consuming an
    // Owner's limits. The transaction repeats it under locks before mutation.
    require_owner(&state.db, form_id, owner_id).await?;
    check_invitation_limits(state, owner_id, form_id, &email).await?;

    let mut token_bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));

    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    lock_and_require_owner(&mut transaction, form_id, owner_id).await?;

    if let Some(invitation_id) = requested_invitation_id {
        let requested = sqlx::query!(
            "SELECT invited_email::text AS invited_email, status
             FROM form_invitations
             WHERE id = $1 AND form_id = $2
             FOR UPDATE",
            invitation_id,
            form_id,
        )
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        let Some(requested) = requested else {
            return Err(ApiError::NotFound);
        };
        if requested.invited_email.as_deref() != Some(email.as_str())
            || !matches!(
                requested.status.as_str(),
                "pending" | "delivery_failed" | "expired"
            )
        {
            return Err(ApiError::NotFound);
        }

        // The addressed pending row remains eligible even when its expiry has
        // elapsed. Expire only other overdue rows before checking whether a
        // still-open invitation would conflict with reviving this exact ID.
        sqlx::query!(
            "UPDATE form_invitations
             SET status = 'expired', token_hash = NULL, updated_at = now()
             WHERE form_id = $1 AND invited_email = $2 AND id <> $3
               AND status = 'pending' AND expires_at <= now()",
            form_id,
            email,
            invitation_id,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

        let conflicting_open_invitation = sqlx::query_scalar!(
            "SELECT EXISTS(
                SELECT 1 FROM form_invitations
                WHERE form_id = $1 AND invited_email = $2 AND id <> $3
                  AND status IN ('sending', 'pending', 'delivery_failed')
             )",
            form_id,
            email,
            invitation_id,
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .unwrap_or(false);
        if conflicting_open_invitation {
            return Err(ApiError::Conflict);
        }
    } else {
        sqlx::query!(
            "UPDATE form_invitations
             SET status = 'expired', token_hash = NULL, updated_at = now()
             WHERE form_id = $1 AND invited_email = $2
               AND status = 'pending' AND expires_at <= now()",
            form_id,
            email,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    }

    let active_collaborator = sqlx::query_scalar!(
        "SELECT EXISTS(
            SELECT 1 FROM form_members members
            JOIN users ON users.id = members.user_id
            WHERE members.form_id = $1 AND users.email = $2
              AND members.state = 'active'
         )",
        form_id,
        email,
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .unwrap_or(false);
    if active_collaborator {
        return Err(ApiError::Conflict);
    }

    let recipient = sqlx::query!(
        "SELECT id, sharing_public_key, sharing_key_version
         FROM users WHERE email = $1",
        email,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let recipient_user_id = recipient.as_ref().map(|row| row.id);
    let grant = sealed_grant_for(
        &body,
        recipient
            .as_ref()
            .and_then(|row| row.sharing_public_key.as_deref()),
        recipient.as_ref().and_then(|row| row.sharing_key_version),
    );

    let invitation_id = if let Some(invitation_id) = requested_invitation_id {
        sqlx::query_scalar!(
            "UPDATE form_invitations
             SET role = $1,
                 status = 'sending',
                 token_hash = $2,
                 recipient_user_id = $3,
                 recipient_sharing_public_key = $4,
                 encrypted_form_data_key = $5,
                 encrypted_form_private_key = $6,
                 expires_at = now() + interval '7 days',
                 accepted_at = NULL,
                 updated_at = now()
             WHERE id = $7 AND form_id = $8 AND invited_email = $9
               AND status IN ('pending', 'delivery_failed', 'expired')
             RETURNING id",
            body.role.as_str(),
            token_hash,
            recipient_user_id,
            grant.public_key,
            grant.data_key,
            grant.private_key,
            invitation_id,
            form_id,
            email,
        )
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or(ApiError::NotFound)?
    } else {
        let invitation_id = Uuid::now_v7();
        sqlx::query_scalar!(
            "INSERT INTO form_invitations (
                id, form_id, invited_email, role, status, token_hash,
                recipient_user_id, recipient_sharing_public_key,
                encrypted_form_data_key, encrypted_form_private_key, expires_at
             ) VALUES (
                $1, $2, $3, $4, 'sending', $5, $6, $7, $8, $9,
                now() + interval '7 days'
             )
             ON CONFLICT (form_id, invited_email)
               WHERE status IN ('sending', 'pending', 'delivery_failed')
             DO UPDATE SET
                role = EXCLUDED.role,
                status = 'sending',
                token_hash = EXCLUDED.token_hash,
                recipient_user_id = EXCLUDED.recipient_user_id,
                recipient_sharing_public_key = EXCLUDED.recipient_sharing_public_key,
                encrypted_form_data_key = EXCLUDED.encrypted_form_data_key,
                encrypted_form_private_key = EXCLUDED.encrypted_form_private_key,
                expires_at = EXCLUDED.expires_at,
                accepted_at = NULL,
                updated_at = now()
             RETURNING id",
            invitation_id,
            form_id,
            email,
            body.role.as_str(),
            token_hash,
            recipient_user_id,
            grant.public_key,
            grant.data_key,
            grant.private_key,
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
    };
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    let invitation_url = format!(
        "{}/invitations/accept#token={token}",
        state.config.web_base_url
    );
    if state
        .mailer
        .send(mail::invitation_mail(
            &email,
            body.role.as_str(),
            &invitation_url,
            7,
        ))
        .await
        .is_err()
    {
        if sqlx::query!(
            "UPDATE form_invitations
             SET status = 'delivery_failed', token_hash = NULL, updated_at = now()
             WHERE id = $1 AND form_id = $2 AND status = 'sending'
               AND token_hash = $3",
            invitation_id,
            form_id,
            token_hash,
        )
        .execute(&state.db)
        .await
        .is_err()
        {
            tracing::error!(
                form_id = %form_id,
                invitation_id = %invitation_id,
                failure_kind = "database_transition",
                "invitation delivery cleanup failed"
            );
        }
        tracing::error!(
            form_id = %form_id,
            invitation_id = %invitation_id,
            failure_kind = "mail_delivery",
            "invitation delivery failed"
        );
        return Err(ApiError::Internal(anyhow::anyhow!(
            "invitation delivery failed"
        )));
    }

    sqlx::query!(
        "UPDATE form_invitations
         SET status = 'pending', updated_at = now()
         WHERE id = $1 AND form_id = $2 AND status = 'sending'
           AND token_hash = $3",
        invitation_id,
        form_id,
        token_hash,
    )
    .execute(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(InvitationResponse { id: invitation_id }))
}

pub async fn revoke_invitation(
    State(state): State<AppState>,
    ApiPath((form_id, invitation_id)): ApiPath<(Uuid, Uuid)>,
    user: SessionUser,
) -> ApiResult<serde_json::Value> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    lock_and_require_owner(&mut transaction, form_id, user.user_id).await?;
    let revoked = sqlx::query!(
        "UPDATE form_invitations
         SET status = 'revoked', token_hash = NULL, updated_at = now()
         WHERE id = $1 AND form_id = $2
           AND status IN ('sending', 'pending', 'delivery_failed', 'expired')",
        invitation_id,
        form_id,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if revoked.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(ApiResponse::ok(serde_json::json!({})))
}

pub async fn continue_invitation(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    jar: CookieJar,
    ApiJson(body): ApiJson<ContinueInvitationBody>,
) -> Result<Response, ApiError> {
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("invite_continuation:source:{}", client_ip),
        state.config.invite_continuation_rate_limit_per_hour,
        60 * 60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let token_hash = format!("{:x}", Sha256::digest(body.token.as_bytes()));
    let invitation_id = sqlx::query_scalar!(
        "SELECT id FROM form_invitations
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()",
        token_hash,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;

    let cookie = continuation::create(&mut state.redis, invitation_id)
        .await
        .map_err(ApiError::Internal)?;
    let jar = jar.add(invitation_cookie(cookie));
    Ok((
        jar,
        ApiResponse::ok(serde_json::json!({ "continued": true })),
    )
        .into_response())
}

pub async fn current_invitation(
    State(state): State<AppState>,
    _user: SessionUser,
    jar: CookieJar,
) -> ApiResult<CurrentInvitationResponse> {
    let (_, invitation_id) = invitation_from_continuation(&state, &jar).await?;
    let invitation = sqlx::query!(
        "SELECT invited_email::text AS invited_email, role,
                encrypted_form_data_key, encrypted_form_private_key
         FROM form_invitations
         WHERE id = $1 AND status = 'pending' AND expires_at > now()",
        invitation_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;
    let invited_email = invitation.invited_email.ok_or_else(|| {
        ApiError::Internal(anyhow::anyhow!("invitation email projection was null"))
    })?;
    let role = FormRole::try_from(invitation.role.as_str()).map_err(ApiError::Internal)?;
    Ok(ApiResponse::ok(CurrentInvitationResponse {
        role,
        status: "pending",
        masked_email: mask_email(&invited_email),
        grant_ready: invitation.encrypted_form_data_key.is_some()
            && invitation.encrypted_form_private_key.is_some(),
    }))
}

pub async fn accept_invitation(
    State(state): State<AppState>,
    user: SessionUser,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    decide_invitation(state, user.user_id, jar, true).await
}

pub async fn decline_invitation(
    State(state): State<AppState>,
    user: SessionUser,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    decide_invitation(state, user.user_id, jar, false).await
}

async fn decide_invitation(
    state: AppState,
    user_id: Uuid,
    jar: CookieJar,
    accept: bool,
) -> Result<Response, ApiError> {
    let (cookie, invitation_id) = invitation_from_continuation(&state, &jar).await?;
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Every invitation mutation takes the parent form first. Owner workflows
    // already use this order, so recipient decisions must not lock the child
    // invitation before an FK-backed membership insert reaches for the form.
    let form_id = sqlx::query_scalar!(
        "SELECT form_id FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;
    let form_exists = sqlx::query_scalar!(
        "SELECT id FROM forms
         WHERE id = $1 AND deletion_started_at IS NULL
         FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if form_exists.is_none() {
        return Err(ApiError::NotFound);
    }

    // Reload under lock after the unlocked identity lookup. A concurrent
    // revoke, resend, expiry, or accept must win cleanly rather than allowing
    // a stale continuation to mutate a changed invitation.
    let invitation = sqlx::query!(
        "SELECT form_id, role, encrypted_form_data_key, encrypted_form_private_key
         FROM form_invitations
         WHERE id = $1 AND form_id = $2
           AND status = 'pending' AND expires_at > now()
         FOR UPDATE",
        invitation_id,
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;
    if !exact_invited_account(&mut transaction, invitation_id, user_id).await? {
        return Err(ApiError::WrongAccount);
    }

    let existing_member = sqlx::query_scalar!(
        "SELECT id FROM form_members
         WHERE form_id = $1 AND user_id = $2
         FOR UPDATE",
        invitation.form_id,
        user_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if existing_member.is_some() {
        return Err(ApiError::NotFound);
    }

    let membership_state = if accept {
        let grant_ready = invitation.encrypted_form_data_key.is_some()
            && invitation.encrypted_form_private_key.is_some();
        let state = if grant_ready {
            "active"
        } else {
            "awaiting_keys"
        };
        let key_scheme = grant_ready.then_some("account_sealed_box_v1");
        sqlx::query!(
            "INSERT INTO form_members (
                id, form_id, user_id, role, state, key_scheme,
                encrypted_form_data_key, encrypted_form_private_key
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            Uuid::now_v7(),
            invitation.form_id,
            user_id,
            invitation.role,
            state,
            key_scheme,
            invitation.encrypted_form_data_key,
            invitation.encrypted_form_private_key,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        sqlx::query!(
            "UPDATE form_invitations
             SET status = 'accepted', token_hash = NULL,
                 recipient_user_id = $1, accepted_at = now(), updated_at = now()
             WHERE id = $2 AND status = 'pending'",
            user_id,
            invitation_id,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        Some(state)
    } else {
        sqlx::query!(
            "UPDATE form_invitations
             SET status = 'revoked', token_hash = NULL, updated_at = now()
             WHERE id = $1 AND status = 'pending'",
            invitation_id,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        None
    };

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    let mut redis = state.redis.clone();
    if continuation::delete(&mut redis, &cookie).await.is_err() {
        tracing::error!(
            invitation_id = %invitation_id,
            failure_kind = "continuation_cleanup",
            "invitation continuation cleanup failed after decision commit"
        );
    }
    let jar = jar.remove(cleared_invitation_cookie());
    let response = match membership_state {
        Some(membership_state) => ApiResponse::ok(InvitationAcceptanceResponse {
            form_id: invitation.form_id,
            membership_state,
        })
        .into_response(),
        None => ApiResponse::ok(serde_json::json!({})).into_response(),
    };
    Ok((jar, response).into_response())
}

/// Invitations that did not reach their recipient.
///
/// `sending` is a send that never resolved: the row was moved out of that
/// state on success and on failure alike, so anything left in it is a
/// process that died mid-send.
// No caller outside the test module yet; a later task wires this into the
// admin health report.
pub(crate) struct InvitationBacklog {
    pub sending: i64,
    pub delivery_failed: i64,
}

pub(crate) async fn delivery_backlog(db: &PgPool) -> sqlx::Result<InvitationBacklog> {
    let row = sqlx::query!(
        r#"SELECT
             count(*) FILTER (WHERE status = 'sending') AS "sending!",
             count(*) FILTER (WHERE status = 'delivery_failed') AS "delivery_failed!"
           FROM form_invitations"#,
    )
    .fetch_one(db)
    .await?;

    Ok(InvitationBacklog {
        sending: row.sending,
        delivery_failed: row.delivery_failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant_body(
        public_key: Option<&str>,
        data_key: Option<&str>,
        private_key: Option<&str>,
    ) -> InvitationBody {
        InvitationBody {
            invited_email: "recipient@example.com".to_string(),
            role: FormRole::Editor,
            recipient_sharing_public_key: public_key.map(str::to_string),
            encrypted_form_data_key: data_key.map(str::to_string),
            encrypted_form_private_key: private_key.map(str::to_string),
        }
    }

    #[test]
    fn a_grant_travels_only_when_it_was_sealed_to_the_key_the_recipient_holds() {
        let body = grant_body(Some("their-key"), Some("data"), Some("private"));
        let grant = sealed_grant_for(&body, Some("their-key"), Some(SHARING_KEY_VERSION));
        assert_eq!(grant.public_key.as_deref(), Some("their-key"));
        assert_eq!(grant.data_key.as_deref(), Some("data"));
        assert_eq!(grant.private_key.as_deref(), Some("private"));
    }

    #[test]
    fn a_recipient_who_rotated_their_key_is_handed_nothing() {
        let body = grant_body(Some("old-key"), Some("data"), Some("private"));
        let grant = sealed_grant_for(&body, Some("new-key"), Some(SHARING_KEY_VERSION));
        assert!(grant.public_key.is_none());
        assert!(grant.data_key.is_none());
        assert!(grant.private_key.is_none());
    }

    #[test]
    fn a_key_at_another_version_is_handed_nothing() {
        let body = grant_body(Some("their-key"), Some("data"), Some("private"));
        let grant = sealed_grant_for(&body, Some("their-key"), Some(SHARING_KEY_VERSION + 1));
        assert!(grant.public_key.is_none());
    }

    #[test]
    fn half_a_grant_is_no_grant() {
        let body = grant_body(Some("their-key"), Some("data"), None);
        let grant = sealed_grant_for(&body, Some("their-key"), Some(SHARING_KEY_VERSION));
        assert!(grant.data_key.is_none());
    }

    #[test]
    fn an_invitation_carrying_no_key_stores_nothing() {
        let body = grant_body(None, None, None);
        let grant = sealed_grant_for(&body, None, None);
        assert!(grant.public_key.is_none());
    }
    use crate::sharing::access::test_support::insert_owner_form;
    use axum::{body::to_bytes, response::IntoResponse};
    use redis::AsyncCommands;

    async fn test_state(mailer: crate::mail::Mailer) -> AppState {
        AppState::for_tests(mailer).await
    }

    fn invitation_body(email: String) -> InvitationBody {
        InvitationBody {
            invited_email: email,
            role: FormRole::Viewer,
            recipient_sharing_public_key: None,
            encrypted_form_data_key: None,
            encrypted_form_private_key: None,
        }
    }

    #[tokio::test]
    async fn mail_failure_clears_the_capability_and_returns_a_generic_error() {
        let mut state = test_state(crate::mail::Mailer::failing()).await;
        let (owner_id, form_id) = insert_owner_form(&state.db).await;
        let invited_email = format!("mail-failure-{}@example.com", Uuid::now_v7());

        let error = match send_invitation(
            &mut state,
            form_id,
            None,
            owner_id,
            invitation_body(invited_email.clone()),
        )
        .await
        {
            Ok(_) => panic!("failing mail delivery unexpectedly succeeded"),
            Err(error) => error,
        };
        let response = error.into_response();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "internal_error");
        assert_eq!(body["error"]["message"], "Something went wrong");

        let invitation = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations
             WHERE form_id = $1 AND invited_email = $2",
            form_id,
            invited_email,
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(invitation.status, "delivery_failed");
        assert!(invitation.token_hash.is_none());
    }

    #[tokio::test]
    async fn owner_hourly_invitation_limit_is_enforced() {
        let mut state = test_state(crate::mail::Mailer::capture())
            .await
            .with_config(|config| config.invite_rate_limit_per_hour = 1);
        let owner_id = Uuid::now_v7();
        let form_id = Uuid::now_v7();
        let email = format!("hour-limit-{}@example.com", Uuid::now_v7());

        assert!(
            check_invitation_limits(&mut state, owner_id, form_id, &email)
                .await
                .is_ok()
        );
        assert!(matches!(
            check_invitation_limits(&mut state, owner_id, Uuid::now_v7(), &email).await,
            Err(ApiError::RateLimited)
        ));
    }

    #[tokio::test]
    async fn owner_daily_invitation_limit_is_enforced() {
        let mut state = test_state(crate::mail::Mailer::capture())
            .await
            .with_config(|config| config.invite_rate_limit_per_day = 1);
        let owner_id = Uuid::now_v7();
        let email = format!("day-limit-{}@example.com", Uuid::now_v7());

        assert!(
            check_invitation_limits(&mut state, owner_id, Uuid::now_v7(), &email)
                .await
                .is_ok()
        );
        assert!(matches!(
            check_invitation_limits(&mut state, owner_id, Uuid::now_v7(), &email).await,
            Err(ApiError::RateLimited)
        ));
    }

    #[tokio::test]
    async fn recipient_invitation_limit_uses_only_a_hash_in_redis_keys() {
        let mut state = test_state(crate::mail::Mailer::capture())
            .await
            .with_config(|config| config.invite_recipient_rate_limit_per_hour = 1);
        let owner_id = Uuid::now_v7();
        let form_id = Uuid::now_v7();
        let email = format!("  RECIPIENT-LIMIT-{}@EXAMPLE.COM  ", Uuid::now_v7());
        let normalized = normalized_email(&email).unwrap();

        assert!(
            check_invitation_limits(&mut state, owner_id, form_id, &normalized)
                .await
                .is_ok()
        );
        assert!(matches!(
            check_invitation_limits(&mut state, owner_id, form_id, &normalized).await,
            Err(ApiError::RateLimited)
        ));

        let owner_pattern = format!("ratelimit:invite_owner_*:{owner_id}");
        let mut keys: Vec<String> = state.redis.keys(owner_pattern).await.unwrap();
        let recipient_pattern = format!("ratelimit:invite_recipient_hour:{form_id}:*");
        let recipient_keys: Vec<String> = state.redis.keys(recipient_pattern).await.unwrap();
        assert_eq!(recipient_keys.len(), 1);
        keys.extend(recipient_keys.iter().cloned());
        assert_eq!(keys.len(), 3);
        assert!(keys.iter().all(|key| !key.contains(&normalized)));
        let suffix = recipient_keys[0].rsplit(':').next().unwrap_or_default();
        assert_eq!(suffix.len(), 64);
        assert!(
            suffix
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        );
    }

    #[tokio::test]
    async fn revoke_while_resend_mail_is_in_flight_cannot_restore_the_capability() {
        let mut state = test_state(crate::mail::Mailer::capture()).await;
        let (owner_id, form_id) = insert_owner_form(&state.db).await;
        let invited_email = format!("mail-race-{}@example.com", Uuid::now_v7());
        send_invitation(
            &mut state,
            form_id,
            None,
            owner_id,
            invitation_body(invited_email.clone()),
        )
        .await
        .unwrap();
        let original = sqlx::query!(
            "SELECT id, token_hash FROM form_invitations
             WHERE form_id = $1 AND invited_email = $2",
            form_id,
            invited_email,
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        let original_hash = original.token_hash.unwrap();

        let (blocking_mailer, delivery) = crate::mail::Mailer::blocking();
        state.mailer = blocking_mailer;
        let mut resend_state = state.clone();
        let resend_email = invited_email.clone();
        let invitation_id = original.id;
        let resend = tokio::spawn(async move {
            send_invitation(
                &mut resend_state,
                form_id,
                Some(invitation_id),
                owner_id,
                invitation_body(resend_email),
            )
            .await
        });

        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            delivery.wait_until_send_started(),
        )
        .await
        .expect("resend did not reach mail delivery");
        let in_flight = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations WHERE id = $1",
            invitation_id,
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(in_flight.status, "sending");
        assert_eq!(in_flight.token_hash.as_deref().map(str::len), Some(64));
        let in_flight_hash = in_flight.token_hash.unwrap();
        assert_ne!(in_flight_hash, original_hash);

        let revoke = revoke_invitation(
            State(state.clone()),
            ApiPath((form_id, invitation_id)),
            SessionUser {
                user_id: owner_id,
                second_factor_verified: false,
            },
        )
        .await;
        assert!(revoke.is_ok());
        let revoked_while_sending = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations WHERE id = $1",
            invitation_id,
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(revoked_while_sending.status, "revoked");
        assert!(revoked_while_sending.token_hash.is_none());

        delivery.release();
        let resend_result = tokio::time::timeout(std::time::Duration::from_secs(2), resend)
            .await
            .expect("resend did not finish after mail release")
            .unwrap();
        assert!(resend_result.is_ok());

        let final_row = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations WHERE id = $1",
            invitation_id,
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(final_row.status, "revoked");
        assert!(final_row.token_hash.is_none());
        let stale_capability_count: i64 = sqlx::query_scalar!(
            "SELECT count(*) FROM form_invitations
             WHERE token_hash = $1 OR token_hash = $2",
            original_hash,
            in_flight_hash,
        )
        .fetch_one(&state.db)
        .await
        .unwrap()
        .unwrap_or(0);
        assert_eq!(stale_capability_count, 0);
    }

    #[tokio::test]
    async fn delivery_backlog_counts_stuck_and_failed_invitations() {
        let state = test_state(crate::mail::Mailer::capture()).await;
        let before = delivery_backlog(&state.db).await.unwrap();

        let (_owner_id, form_id) =
            crate::sharing::access::test_support::insert_owner_form(&state.db).await;
        // `token_hash` is only NOT NULL for 'sending'/'pending' rows; the
        // table's CHECK constraint requires it to be NULL for
        // 'delivery_failed' (and 'accepted'/'revoked'/'expired').
        for status in ["sending", "delivery_failed"] {
            let token_hash = if status == "sending" {
                Some(format!("hash-{}", Uuid::now_v7()))
            } else {
                None
            };
            sqlx::query(
                "INSERT INTO form_invitations (
                     id, form_id, invited_email, role, token_hash, status, expires_at
                 ) VALUES ($1, $2, $3, 'viewer', $4, $5, now() + interval '7 days')",
            )
            .bind(Uuid::now_v7())
            .bind(form_id)
            .bind(format!("backlog-{}@example.com", Uuid::now_v7()))
            .bind(token_hash)
            .bind(status)
            .execute(&state.db)
            .await
            .unwrap();
        }

        let after = delivery_backlog(&state.db).await.unwrap();
        assert_eq!(after.sending, before.sending + 1);
        assert_eq!(after.delivery_failed, before.delivery_failed + 1);
    }
}
