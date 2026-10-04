use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::net::IpAddr;
use time::Duration;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    admin,
    auth::extractor::SessionUser,
    client_ip::ClientIp,
    email_verify,
    error::{ApiError, ApiJson, ApiResponse, ApiResult},
    mail, password, rate_limit, session,
    state::AppState,
    totp,
};

/// Invalidates the session the request arrived with, if any.
///
/// Called before issuing a new one on register and login: without it a token an
/// attacker planted in the victim's browser stays valid after the victim
/// authenticates, which is session fixation.
pub(super) async fn drop_presented_session(state: &mut AppState, jar: &CookieJar) {
    if let Some(cookie) = jar.get("__Host-session") {
        let _ = session::delete_session(&mut state.redis, cookie.value()).await;
    }
}

pub(super) fn cleared_session_cookie() -> Cookie<'static> {
    Cookie::build(("__Host-session", ""))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Lax)
        .build()
}

#[derive(Deserialize)]
pub struct RegisterBody {
    email: String,
    verifier: String,
    /// The language the browser is showing, for the mail and the account.
    /// Anything but a supported code is English.
    #[serde(default)]
    language: Option<String>,
}

/// A verifier is always 32 bytes, base64url without padding, as produced by
/// libsodium's `to_base64` default in packages/crypto.
const VERIFIER_BYTES: usize = 32;

/// Rejects anything that is not a well-formed verifier.
///
/// Called before the rate limiter on every route that takes one, so a garbage
/// body cannot spend an account's or an address's budget. It says nothing
/// about whether the credential is correct.
pub(super) fn validate_verifier(raw: &str) -> Result<(), ApiError> {
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| ApiError::BadRequest("Invalid request".into()))?;
    if decoded.len() != VERIFIER_BYTES {
        return Err(ApiError::BadRequest("Invalid request".into()));
    }
    Ok(())
}

/// A wrapped account key is `crypto_secretbox` over 32 bytes: a 24-byte nonce,
/// the 32 bytes, and a 16-byte Poly1305 tag.
const WRAPPED_ACCOUNT_KEY_BYTES: usize = 24 + 32 + 16;

/// Rejects anything that is not a well-formed wrapper.
///
/// This is a shape check and nothing more. The server cannot open a wrapper and
/// must never learn whether one opens: that is a browser-local fact.
pub(super) fn validate_wrapped_account_key(raw: &str) -> Result<(), ApiError> {
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| ApiError::BadRequest("Invalid request".into()))?;
    if decoded.len() != WRAPPED_ACCOUNT_KEY_BYTES {
        return Err(ApiError::BadRequest("Invalid request".into()));
    }
    Ok(())
}

/// The account key sealed under the caller's password-derived unlock key.
///
/// Every authenticated response carries it, because the browser needs it to
/// open form keys and holds nothing that can reconstruct it. An account with no
/// wrapper cannot decrypt anything, so its absence is treated as unauthorized
/// rather than reported as a distinct condition.
async fn password_wrapper(db: &sqlx::PgPool, user_id: Uuid) -> Result<String, ApiError> {
    sqlx::query_scalar!(
        "SELECT wrapped_account_key FROM account_key_wrappers \
         WHERE user_id = $1 AND method = 'password'",
        user_id,
    )
    .fetch_optional(db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)
}

pub async fn register(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    ApiJson(body): ApiJson<RegisterBody>,
) -> Result<Response, ApiError> {
    // Note what cannot be checked here any more: password length. The server
    // sees a fixed-size verifier, never the password behind it, so that rule is
    // client-side only, the same limitation as every other content rule under
    // zero knowledge.
    validate_verifier(&body.verifier)?;
    // Canonical before anything is keyed, looked up or mailed, so the limit
    // below, the account lookup and the recipient all name the same inbox.
    let email = mail::canonical_address(&body.email)
        .ok_or_else(|| ApiError::BadRequest("Enter a valid email address".to_string()))?;

    let instance_settings = admin::settings::load(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    if !instance_settings.registration_enabled {
        return Err(ApiError::BadRequest("Registration is closed".to_string()));
    }

    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("register:{}", client_ip),
        u32::try_from(instance_settings.register_rate_limit_per_hour)
            .map_err(|error| ApiError::Internal(error.into()))?,
        3600,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    // A second limit keyed on the address, so rotating IPs cannot mail-bomb
    // one inbox. The key holds a hash rather than the address itself: Redis
    // should not accumulate a list of who has ever tried to sign up.
    let mut hasher = Sha256::new();
    hasher.update(email.as_bytes());
    let email_key = format!("register_email:{:x}", hasher.finalize());
    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &email_key,
        state.config.register_email_rate_limit,
        3600,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let existing = sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let decoy = existing.is_some();

    // Hashed even in the decoy case: skipping it would make the duplicate
    // response measurably faster, which is the enumeration oracle this whole
    // path exists to close.
    let verifier_hash = password::hash_auth_verifier(&body.verifier).map_err(ApiError::Internal)?;

    let lang = mail::Language::from_code(body.language.as_deref());
    let code = email_verify::generate_code();
    let now = OffsetDateTime::now_utc();
    let record = email_verify::PendingSignup {
        email: email.clone(),
        verifier_hash,
        code_hash: email_verify::hash_code(&code),
        attempts: 0,
        resends: 0,
        decoy,
        language: lang.code().to_string(),
        verified_user_id: None,
        resend_reservation: None,
        expires_at: now + Duration::seconds(state.config.verify_code_ttl_seconds as i64),
        last_sent_at: now,
        last_sent_at_unix: now.unix_timestamp(),
    };
    let pending_token = email_verify::create_pending(&mut state.redis, &record)
        .await
        .map_err(ApiError::Internal)?;

    let mail = if decoy {
        mail::account_exists_mail(&email, lang)
    } else {
        mail::verification_mail(
            &email,
            &code,
            state.config.verify_code_ttl_seconds / 60,
            lang,
        )
    };
    if let Err(err) = state.mailer.send(mail).await {
        // Leaving the record behind would strand the user holding a handle for
        // a code that was never delivered.
        let _ = email_verify::delete_pending(&mut state.redis, &pending_token).await;
        log_mail_failure("register", &err);
        return Err(ApiError::Internal(anyhow::anyhow!("mail send failed")));
    }

    Ok(ApiResponse::ok(json!({
        "verification_required": true,
        "pending_token": pending_token,
    }))
    .into_response())
}

#[derive(Deserialize)]
pub struct VerifyEmailBody {
    pending_token: String,
    code: String,
    /// The account key wrapped under the password-derived unlock key, produced
    /// in the browser. The server stores it and can never open it.
    wrapped_account_key_password: String,
    /// The same account key wrapped under the recovery-code-derived unlock key.
    /// The raw recovery code never reaches the server, so this is the only
    /// thing that opens the vault when the password is gone.
    wrapped_account_key_recovery: String,
    /// `deriveRecoveryVerifier` over that unlock key. Hashed again server-side
    /// before storage, so a database read yields neither the code nor anything
    /// replayable.
    recovery_verifier: String,
}

/// Everything the browser produces at signup so an account is never created
/// half-enrolled.
///
/// Grouped rather than passed as five positional `&str`s: two of these are
/// wrappers of the same shape and a third is a verifier, and a transposed pair
/// would compile silently while storing the wrong bytes under the wrong method.
struct AccountKeyMaterial<'a> {
    wrapped_password: &'a str,
    wrapped_recovery: &'a str,
    recovery_verifier: &'a str,
}

pub async fn verify_email(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    jar: CookieJar,
    ApiJson(body): ApiJson<VerifyEmailBody>,
) -> Result<Response, ApiError> {
    // Before the rate limiter, like the verifier check: a malformed body must
    // not spend an address's budget, and must not burn the pending signup.
    validate_wrapped_account_key(&body.wrapped_account_key_password)?;
    validate_wrapped_account_key(&body.wrapped_account_key_recovery)?;
    validate_verifier(&body.recovery_verifier)?;

    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("verify_email:{}", client_ip),
        state.config.verify_rate_limit,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let (record, user_id) = match email_verify::verify_code(
        &mut state.redis,
        &body.pending_token,
        &body.code,
        state.config.verify_max_attempts,
        Uuid::now_v7(),
    )
    .await
    .map_err(ApiError::Internal)?
    {
        email_verify::VerifyCodeResult::Authorized { record, user_id } => (record, user_id),
        email_verify::VerifyCodeResult::Rejected => return Err(ApiError::Unauthorized),
    };

    ensure_verified_user(
        &state.db,
        state.config.initial_admin_email.as_deref(),
        user_id,
        &record,
        AccountKeyMaterial {
            wrapped_password: &body.wrapped_account_key_password,
            wrapped_recovery: &body.wrapped_account_key_recovery,
            recovery_verifier: &body.recovery_verifier,
        },
    )
    .await?;

    // Same fixation defence as login: whatever session was presented is
    // dropped before a new one is issued.
    drop_presented_session(&mut state, &jar).await;
    let session_generation = load_active_session_generation(&state.db, user_id).await?;
    let token = session::create_session(
        &mut state.redis,
        user_id,
        session_generation,
        session::SecondFactor::NotVerified,
    )
    .await
    .map_err(ApiError::Internal)?;
    let jar = jar.add(session_cookie(token));

    let wrapped_account_key = password_wrapper(&state.db, user_id).await?;
    Ok(auth_success(jar, user_id, &wrapped_account_key))
}

#[derive(Deserialize)]
pub struct ResendBody {
    pending_token: String,
}

/// Issues a fresh code for an existing pending signup.
///
/// The record's expiry is untouched: extending it on every resend would let a
/// client keep a verifier hash alive in Redis indefinitely.
pub async fn resend_verification(
    State(mut state): State<AppState>,
    ApiJson(body): ApiJson<ResendBody>,
) -> Result<Response, ApiError> {
    let reservation_id = Uuid::now_v7().to_string();
    let (code, record) = loop {
        let code = email_verify::generate_code();
        match email_verify::begin_resend(
            &mut state.redis,
            email_verify::ResendAttempt {
                token: &body.pending_token,
                code: &code,
                reservation_id: &reservation_id,
            },
            OffsetDateTime::now_utc(),
            state.config.resend_cooldown_seconds,
            3,
        )
        .await
        .map_err(ApiError::Internal)?
        {
            email_verify::BeginResendResult::Reserved(record) => break (code, record),
            email_verify::BeginResendResult::RetryWithDifferentCode => continue,
            email_verify::BeginResendResult::Missing => return Err(ApiError::Unauthorized),
            email_verify::BeginResendResult::Unavailable => return Err(ApiError::RateLimited),
        }
    };

    let lang = mail::Language::from_code(Some(&record.language));
    let mail = if record.decoy {
        mail::account_exists_mail(&record.email, lang)
    } else {
        mail::verification_mail(
            &record.email,
            &code,
            remaining_verification_minutes(&record),
            lang,
        )
    };
    if let Err(err) = state.mailer.send(mail).await {
        if email_verify::rollback_resend(&mut state.redis, &body.pending_token, &reservation_id)
            .await
            .is_err()
        {
            tracing::error!(
                correlation_id = %Uuid::now_v7(),
                failure_kind = "redis_resend_rollback",
                operation = "resend",
                "verification mail operation failed"
            );
        }
        log_mail_failure("resend", &err);
        return Err(ApiError::Internal(anyhow::anyhow!("mail send failed")));
    }

    email_verify::commit_resend(&mut state.redis, &body.pending_token, &reservation_id)
        .await
        .map_err(ApiError::Internal)?;

    Ok(ApiResponse::ok(json!({ "sent": true })).into_response())
}

async fn ensure_verified_user(
    db: &sqlx::PgPool,
    configured_email: Option<&str>,
    user_id: Uuid,
    record: &email_verify::PendingSignup,
    keys: AccountKeyMaterial<'_>,
) -> Result<(), ApiError> {
    let mut transaction = db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    let inserted = sqlx::query_scalar!(
        "INSERT INTO users (id, email, password_hash, email_verified_at, language) \
         VALUES ($1, $2, $3, now(), $4) \
         ON CONFLICT DO NOTHING RETURNING id",
        user_id,
        record.email,
        record.verifier_hash,
        mail::Language::from_code(Some(&record.language)).code(),
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if inserted != Some(user_id) {
        let belongs_to_receipt = sqlx::query_scalar!(
            "SELECT EXISTS( \
                SELECT 1 FROM users \
                WHERE id = $1 AND email = $2 AND password_hash = $3 \
             ) AS \"exists!\"",
            user_id,
            record.email,
            record.verifier_hash,
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        if !belongs_to_receipt {
            // A different pending signup won the email uniqueness race. A conflict
            // is never enough to authorize this receipt to claim that account.
            return Err(ApiError::Unauthorized);
        }
    }

    // Same transaction as the user row, so no account can exist without a way
    // to open its vault. `ON CONFLICT DO NOTHING` because the retryable
    // verification receipt can re-run this path for the same fixed UUIDv7
    // after a transient failure; re-running has to converge, not fail.
    //
    // The unique index this infers, `account_key_wrappers_user_method_idx`, is
    // partial (live non-passkey wrappers only: `WHERE credential_id IS NULL`).
    // PostgreSQL cannot infer a partial index for conflict resolution unless
    // the statement's own predicate matches it, so the `WHERE` clause below is
    // load-bearing, not decorative: drop it and every signup starts failing
    // with "there is no unique or exclusion constraint matching the ON
    // CONFLICT specification".
    sqlx::query!(
        "INSERT INTO account_key_wrappers (id, user_id, method, wrapped_account_key) \
         VALUES ($1, $2, 'password', $3) \
         ON CONFLICT (user_id, method) WHERE credential_id IS NULL DO NOTHING",
        Uuid::now_v7(),
        user_id,
        keys.wrapped_password,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    // The second unlock method, written here rather than offered later, so
    // "every account has a recovery method" is structural instead of a UI
    // convention. Nothing has to repair an account that skipped this step,
    // because no such account can be committed.
    //
    // Same partial-index caveat as the password wrapper insert above: the
    // `WHERE credential_id IS NULL` predicate has to be repeated here for
    // PostgreSQL to infer `account_key_wrappers_user_method_idx` at all.
    sqlx::query!(
        "INSERT INTO account_key_wrappers (id, user_id, method, wrapped_account_key) \
         VALUES ($1, $2, 'recovery_code', $3) \
         ON CONFLICT (user_id, method) WHERE credential_id IS NULL DO NOTHING",
        Uuid::now_v7(),
        user_id,
        keys.wrapped_recovery,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    // Hashed server-side so a database read yields neither the code nor a
    // replayable verifier. The browser already turned the code into an unlock
    // key and that key into this verifier; this is the second, salted hash.
    let recovery_hash =
        password::hash_secret(keys.recovery_verifier).map_err(ApiError::Internal)?;

    // Unqualified `ON CONFLICT DO NOTHING` because the conflict this has to
    // absorb is on the partial unique index over live rows, not on the primary
    // key: a retried receipt brings a fresh UUIDv7 but must not mint a second
    // live code. The browser sends the same material on a retry, so the row
    // already stored is the one whose code was displayed.
    sqlx::query!(
        "INSERT INTO vault_recovery_codes (id, user_id, verifier_hash) \
         VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING",
        Uuid::now_v7(),
        user_id,
        recovery_hash,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    admin::claim_initial_admin(&mut transaction, configured_email, user_id, &record.email).await?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))
}

fn remaining_verification_minutes(record: &email_verify::PendingSignup) -> u64 {
    let seconds = (record.expires_at - OffsetDateTime::now_utc())
        .whole_seconds()
        .max(1) as u64;
    seconds.div_ceil(60)
}

fn log_mail_failure(operation: &'static str, _error: &anyhow::Error) {
    tracing::error!(
        correlation_id = %Uuid::now_v7(),
        failure_kind = "smtp_delivery",
        operation,
        "verification mail operation failed"
    );
}

pub(super) async fn load_active_session_generation(
    db: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<i64, ApiError> {
    sqlx::query_scalar::<_, i64>(
        "SELECT session_generation
         FROM users
         WHERE id = $1
           AND suspended_at IS NULL
           AND deletion_started_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)
}

#[derive(Deserialize)]
pub struct LoginBody {
    email: String,
    verifier: String,
}

#[derive(Deserialize)]
pub struct ReauthenticateBody {
    verifier: String,
}

async fn check_reauthentication_rate_limit(
    redis: &mut redis::aio::ConnectionManager,
    ip: IpAddr,
    user_id: Uuid,
    max_attempts: u32,
) -> anyhow::Result<bool> {
    rate_limit::check_rate_limit(
        redis,
        &format!("reauthenticate:{ip}:{user_id}"),
        max_attempts,
        60,
    )
    .await
}

/// The address is hashed after lowercasing, never used raw. `users.email` is
/// CITEXT, so `Alice@example.com` and `alice@example.com` are the same account;
/// a limiter keyed on the raw string would hand an attacker a fresh counter per
/// capitalisation, which for a fifteen-letter address is tens of thousands of
/// counters against one account from one IP.
pub(super) fn login_rate_limit_key(ip: IpAddr, email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.trim().to_lowercase().as_bytes());
    format!("login:{ip}:{:x}", hasher.finalize())
}

const TOTP_ATTEMPTS_PER_MINUTE: u32 = 10;

/// Caps code checks per account, not only per IP. Six digits with a skew of one
/// step means roughly one guess in 333,000 succeeds, which an unmetered caller
/// rotating addresses exhausts in hours; a per-account counter closes that
/// regardless of how many addresses the caller has. Every path that checks a
/// TOTP or TOTP recovery code goes through this: enable, disable, the login
/// second step, and vault recovery.
pub(super) async fn check_totp_attempt_rate_limit(
    state: &mut AppState,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("totp_attempts:{user_id}"),
        TOTP_ATTEMPTS_PER_MINUTE,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }
    Ok(())
}

async fn load_login_rate_limit(db: &sqlx::PgPool) -> Result<u32, ApiError> {
    let settings = admin::settings::load(db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    u32::try_from(settings.login_rate_limit_per_minute)
        .map_err(|error| ApiError::Internal(error.into()))
}

/// Proves the current user's password-derived verifier without minting or
/// replacing a session.
///
/// This is intentionally distinct from login: an already-authenticated TOTP
/// user needs to authorize a local vault operation, not start a new login.
pub async fn reauthenticate(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    jar: CookieJar,
    user: SessionUser,
    ApiJson(body): ApiJson<ReauthenticateBody>,
) -> ApiResult<serde_json::Value> {
    validate_verifier(&body.verifier)?;

    let login_rate_limit = load_login_rate_limit(&state.db).await?;
    let allowed = check_reauthentication_rate_limit(
        &mut state.redis,
        client_ip,
        user.user_id,
        login_rate_limit,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let row = sqlx::query!(
        "SELECT password_hash FROM users WHERE id = $1",
        user.user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;

    let valid = password::verify_auth_verifier(&body.verifier, &row.password_hash)
        .map_err(ApiError::Internal)?;
    if !valid {
        return Err(ApiError::Unauthorized);
    }

    let session_token = crate::admin::account_lifecycle::presented_session_token(&jar)?;
    let reauthentication_receipt = crate::admin::account_lifecycle::issue_reauthentication_receipt(
        &mut state.redis,
        user.user_id,
        &session_token,
    )
    .await
    .map_err(ApiError::Internal)?;

    Ok(ApiResponse::ok(json!({
        "user_id": user.user_id,
        "reauthentication_receipt": reauthentication_receipt,
        "wrapped_account_key": password_wrapper(&state.db, user.user_id).await?,
    })))
}

pub async fn login(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    jar: CookieJar,
    // `ApiJson` rather than axum's `Json`, so a malformed body is refused with
    // the standard envelope instead of a bare 422.
    ApiJson(body): ApiJson<LoginBody>,
) -> Result<Response, ApiError> {
    validate_verifier(&body.verifier)?;

    let login_rate_limit = load_login_rate_limit(&state.db).await?;
    let allowed = rate_limit::check_rate_limit(
        &mut state.redis,
        &login_rate_limit_key(client_ip, &body.email),
        login_rate_limit,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let row = sqlx::query(
        "SELECT id, password_hash, totp_enabled, session_generation
         FROM users
         WHERE email = $1
           AND suspended_at IS NULL
           AND deletion_started_at IS NULL",
    )
    .bind(&body.email)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    // No live account for this address. Pay the Argon2 cost a wrong password
    // pays before answering, or the unknown-address reply comes back
    // measurably faster and tells anyone probing which addresses have
    // accounts: the oracle registration's decoy, recovery's decoy and
    // discoverable passkey login each exist to close.
    let Some(row) = row else {
        password::spend_verification_cost(&body.verifier);
        return Err(ApiError::Unauthorized);
    };

    let valid = password::verify_auth_verifier(
        &body.verifier,
        row.get::<String, _>("password_hash").as_str(),
    )
    .map_err(ApiError::Internal)?;
    if !valid {
        return Err(ApiError::Unauthorized);
    }

    drop_presented_session(&mut state, &jar).await;

    // With a second factor enrolled the password alone earns no session, only
    // the right to present a code. The account key wrapper is withheld too: it
    // is only useful alongside the password, but there is no reason to hand it
    // over early.
    if row.get::<bool, _>("totp_enabled") {
        let pending = totp::create_pending(
            &mut state.redis,
            row.get::<Uuid, _>("id"),
            row.get::<i64, _>("session_generation"),
        )
        .await
        .map_err(ApiError::Internal)?;
        return Ok(ApiResponse::ok(json!({
            "totp_required": true,
            "pending_token": pending,
        }))
        .into_response());
    }

    let token = session::create_session(
        &mut state.redis,
        row.get::<Uuid, _>("id"),
        row.get::<i64, _>("session_generation"),
        session::SecondFactor::NotVerified,
    )
    .await
    .map_err(ApiError::Internal)?;
    let jar = jar.add(session_cookie(token));

    let wrapped_account_key = password_wrapper(&state.db, row.get::<Uuid, _>("id")).await?;
    Ok(auth_success(
        jar,
        row.get::<Uuid, _>("id"),
        &wrapped_account_key,
    ))
}

pub async fn me(State(state): State<AppState>, user: SessionUser) -> ApiResult<serde_json::Value> {
    let row = sqlx::query!(
        "SELECT email, instance_admin, totp_enabled FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    Ok(ApiResponse::ok(json!({
        "user_id": user.user_id,
        "email": row.email,
        "instance_admin": row.instance_admin,
        "totp_enabled": row.totp_enabled,
        "second_factor_verified": user.second_factor_verified,
        "wrapped_account_key": password_wrapper(&state.db, user.user_id).await?,
    })))
}

pub async fn logout(State(mut state): State<AppState>, jar: CookieJar) -> Response {
    if let Some(cookie) = jar.get("__Host-session") {
        let _ = session::delete_session(&mut state.redis, cookie.value()).await;
    }
    let jar = jar.remove(cleared_session_cookie());
    (jar, ApiResponse::ok(json!({}))).into_response()
}

#[derive(Deserialize)]
pub struct LanguageBody {
    language: String,
}

/// Sets the language the caller's mail is written in. Anything but a supported
/// code is refused rather than coerced: unlike a signup hint, this is an
/// explicit choice, and a typo should be an error rather than English.
pub async fn set_language(
    State(state): State<AppState>,
    user: SessionUser,
    Json(body): Json<LanguageBody>,
) -> Result<Response, ApiError> {
    if !matches!(body.language.as_str(), "en" | "ar") {
        return Err(ApiError::BadRequest("Invalid request".to_string()));
    }
    sqlx::query!(
        "UPDATE users SET language = $2 WHERE id = $1",
        user.user_id,
        body.language,
    )
    .execute(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(ApiResponse::ok(json!({ "language": body.language })).into_response())
}

/// Revokes every session for the caller, including the one making the request.
pub async fn logout_all(
    State(mut state): State<AppState>,
    user: SessionUser,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    let revoked = session::delete_all_sessions_for_user(&mut state.redis, user.user_id)
        .await
        .map_err(ApiError::Internal)?;

    let jar = jar.remove(cleared_session_cookie());
    Ok((jar, ApiResponse::ok(json!({ "revoked": revoked }))).into_response())
}

pub(super) fn session_cookie(token: String) -> Cookie<'static> {
    session_cookie_for(token, Duration::days(90))
}

/// The session cookie with an explicit lifetime.
///
/// A recovery session lives for minutes, not months, so it gets a cookie whose
/// `Max-Age` matches its Redis TTL. The cookie's lifetime is a convenience for
/// the browser and never an authority (the server-side record is what expires),
/// but handing out a 90-day cookie for a 15-minute handle would leave a dead
/// credential sitting in the jar long after it stopped meaning anything.
pub(super) fn session_cookie_for(token: String, max_age: Duration) -> Cookie<'static> {
    Cookie::build(("__Host-session", token))
        .path("/")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .max_age(max_age)
        .build()
}

fn auth_success(jar: CookieJar, user_id: Uuid, wrapped_account_key: &str) -> Response {
    let body = ApiResponse::ok(json!({
        "user_id": user_id,
        "wrapped_account_key": wrapped_account_key,
    }));
    (jar, body).into_response()
}

#[derive(Deserialize)]
pub struct TotpCodeBody {
    code: String,
}

/// Starts enrolment: mints a secret and returns the URI to scan.
///
/// The secret is stored but `totp_enabled` stays false, so an abandoned
/// enrolment cannot lock anyone out. Only `enable` flips it on, and only after
/// a code proves the authenticator actually holds the same secret.
pub async fn totp_setup(
    State(mut state): State<AppState>,
    user: SessionUser,
) -> ApiResult<serde_json::Value> {
    let row = sqlx::query!(
        "SELECT email, totp_enabled FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    if row.totp_enabled {
        return Err(ApiError::BadRequest(
            "Two-factor authentication is already enabled".into(),
        ));
    }

    let secret = totp::generate_secret();
    let uri = totp::provisioning_uri(&secret, &row.email).map_err(ApiError::Internal)?;
    let qr = totp::provisioning_qr(&secret, &row.email).map_err(ApiError::Internal)?;

    sqlx::query!(
        "UPDATE users SET totp_secret = $1 WHERE id = $2",
        &secret,
        user.user_id
    )
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    let _ = &mut state.redis;
    Ok(ApiResponse::ok(
        json!({ "provisioning_uri": uri, "qr_data_uri": qr }),
    ))
}

#[derive(Deserialize)]
pub struct TotpEnableBody {
    code: String,
    reauthentication_receipt: String,
}

/// Confirms enrolment and hands back the recovery codes, once.
///
/// Requires a fresh password proof, not only the session. Enrolling a factor
/// adds a gate the account holder does not control: from a stolen session it
/// would lock the real owner out at their next login, and nothing but the
/// factor itself can turn it off again. Turning a factor off already demands a
/// code; turning one on now demands the password.
pub async fn totp_enable(
    State(mut state): State<AppState>,
    jar: CookieJar,
    user: SessionUser,
    Json(body): Json<TotpEnableBody>,
) -> ApiResult<serde_json::Value> {
    crate::admin::account_lifecycle::require_reauthentication(
        &mut state.redis,
        user.user_id,
        &jar,
        &body.reauthentication_receipt,
    )
    .await?;

    let row = sqlx::query!(
        "SELECT email, totp_secret, totp_enabled FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    if row.totp_enabled {
        return Err(ApiError::BadRequest(
            "Two-factor authentication is already enabled".into(),
        ));
    }
    let Some(secret) = row.totp_secret else {
        return Err(ApiError::BadRequest("Start setup first".into()));
    };

    check_totp_attempt_rate_limit(&mut state, user.user_id).await?;
    let ok = totp::verify_code(
        &mut state.redis,
        user.user_id,
        &secret,
        &row.email,
        &body.code,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !ok {
        return Err(ApiError::BadRequest("That code is not valid".into()));
    }

    let codes = totp::generate_recovery_codes().map_err(ApiError::Internal)?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    sqlx::query!(
        "UPDATE users SET totp_enabled = TRUE WHERE id = $1",
        user.user_id
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    // Replace rather than append, so re-enrolling never leaves an old code live.
    sqlx::query!(
        "DELETE FROM totp_recovery_codes WHERE user_id = $1",
        user.user_id
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    for (_, hash) in &codes {
        sqlx::query!(
            "INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)",
            Uuid::now_v7(),
            user.user_id,
            hash
        )
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    }
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    let plaintexts: Vec<&String> = codes.iter().map(|(code, _)| code).collect();
    Ok(ApiResponse::ok(json!({ "recovery_codes": plaintexts })))
}

/// Turns the second factor off. Requires a current code, so a hijacked session
/// cannot quietly remove the protection it is meant to be gated by.
pub async fn totp_disable(
    State(mut state): State<AppState>,
    user: SessionUser,
    Json(body): Json<TotpCodeBody>,
) -> ApiResult<serde_json::Value> {
    let row = sqlx::query!(
        "SELECT email, totp_secret, totp_enabled FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    if !row.totp_enabled {
        return Err(ApiError::BadRequest(
            "Two-factor authentication is not enabled".into(),
        ));
    }
    let Some(secret) = row.totp_secret else {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "totp enabled without a secret"
        )));
    };

    let ok =
        verify_totp_or_recovery(&mut state, user.user_id, &secret, &row.email, &body.code).await?;
    if !ok {
        return Err(ApiError::BadRequest("That code is not valid".into()));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    sqlx::query!(
        "UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1",
        user.user_id
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    sqlx::query!(
        "DELETE FROM totp_recovery_codes WHERE user_id = $1",
        user.user_id
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    Ok(ApiResponse::ok(json!({})))
}

#[derive(Deserialize)]
pub struct TotpVerifyBody {
    pending_token: String,
    code: String,
}

/// Second step of login: exchanges the pending handle plus a code for a session.
pub async fn totp_verify(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    jar: CookieJar,
    Json(body): Json<TotpVerifyBody>,
) -> Result<Response, ApiError> {
    // Six digits fall quickly to a brute force, so attempts are capped by IP as
    // well as by the single-use pending handle.
    let allowed =
        rate_limit::check_rate_limit(&mut state.redis, &format!("totp:{}", client_ip), 10, 60)
            .await
            .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let Some(pending_login) = totp::take_pending(&mut state.redis, &body.pending_token)
        .await
        .map_err(ApiError::Internal)?
    else {
        return Err(ApiError::Unauthorized);
    };

    let row = sqlx::query(
        "SELECT email, totp_secret, session_generation
         FROM users
         WHERE id = $1
           AND suspended_at IS NULL
           AND deletion_started_at IS NULL
           AND session_generation = $2",
    )
    .bind(pending_login.user_id)
    .bind(pending_login.generation)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?
    .ok_or(ApiError::Unauthorized)?;

    let Some(secret) = row.get::<Option<Vec<u8>>, _>("totp_secret") else {
        return Err(ApiError::Unauthorized);
    };

    let ok = verify_totp_or_recovery(
        &mut state,
        pending_login.user_id,
        &secret,
        row.get::<String, _>("email").as_str(),
        &body.code,
    )
    .await?;
    if !ok {
        return Err(ApiError::Unauthorized);
    }

    drop_presented_session(&mut state, &jar).await;
    let token = session::create_session(
        &mut state.redis,
        pending_login.user_id,
        row.get::<i64, _>("session_generation"),
        session::SecondFactor::Verified,
    )
    .await
    .map_err(ApiError::Internal)?;
    let jar = jar.add(session_cookie(token));

    let wrapped_account_key = password_wrapper(&state.db, pending_login.user_id).await?;
    Ok(auth_success(
        jar,
        pending_login.user_id,
        &wrapped_account_key,
    ))
}

/// Accepts either a current TOTP code or an unused recovery code.
///
/// A matched recovery code is marked used in the same breath, so each one works
/// exactly once.
pub(super) async fn verify_totp_or_recovery(
    state: &mut AppState,
    user_id: Uuid,
    secret: &[u8],
    account: &str,
    code: &str,
) -> Result<bool, ApiError> {
    check_totp_attempt_rate_limit(state, user_id).await?;
    if totp::verify_code(&mut state.redis, user_id, secret, account, code)
        .await
        .map_err(ApiError::Internal)?
    {
        return Ok(true);
    }

    let candidates = sqlx::query!(
        "SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL",
        user_id
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    for candidate in candidates {
        // A TOTP recovery code is not a verifier: it is typed straight into the
        // login form and never passes through the browser's unlock-key
        // derivation. It restores account access; it decrypts nothing.
        let matches =
            password::verify_secret(code, &candidate.code_hash).map_err(ApiError::Internal)?;
        if !matches {
            continue;
        }
        // Guarded on used_at so two racing requests cannot both spend it.
        let spent = sqlx::query!(
            "UPDATE totp_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL",
            candidate.id
        )
        .execute(&state.db)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
        return Ok(spent.rows_affected() == 1);
    }

    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::aio::ConnectionManager;
    use sqlx::PgPool;

    #[test]
    fn the_login_limiter_does_not_hand_out_a_counter_per_capitalisation() {
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let canonical = login_rate_limit_key(ip, "alice@example.com");

        assert_eq!(login_rate_limit_key(ip, "Alice@Example.com"), canonical);
        assert_eq!(login_rate_limit_key(ip, "  alice@example.com "), canonical);
        assert_ne!(login_rate_limit_key(ip, "bob@example.com"), canonical);
        assert_ne!(
            login_rate_limit_key("203.0.113.8".parse().unwrap(), "alice@example.com"),
            canonical
        );
        assert!(
            !canonical.contains("alice"),
            "the address itself must not appear in a Redis key"
        );
    }

    async fn test_redis() -> ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        ConnectionManager::new(client).await.unwrap()
    }

    async fn test_db() -> PgPool {
        crate::test_db::pool().await
    }

    fn pending(email: String) -> email_verify::PendingSignup {
        let now = OffsetDateTime::now_utc();
        email_verify::PendingSignup {
            email,
            verifier_hash: password::hash_auth_verifier("correct horse battery staple").unwrap(),
            code_hash: email_verify::hash_code("123456"),
            attempts: 0,
            resends: 0,
            decoy: false,
            language: "en".to_string(),
            verified_user_id: None,
            resend_reservation: None,
            expires_at: now + Duration::minutes(15),
            last_sent_at: now,
            last_sent_at_unix: now.unix_timestamp(),
        }
    }

    async fn authorize(
        redis: &mut ConnectionManager,
        token: &str,
    ) -> (email_verify::PendingSignup, Uuid) {
        match email_verify::verify_code(redis, token, "123456", 5, Uuid::now_v7())
            .await
            .unwrap()
        {
            email_verify::VerifyCodeResult::Authorized { record, user_id } => (*record, user_id),
            email_verify::VerifyCodeResult::Rejected => panic!("receipt was not retryable"),
        }
    }

    /// A shape-valid wrapper. These tests call `ensure_verified_user` directly,
    /// below the handler that validates, and never open the value.
    const TEST_WRAPPED_ACCOUNT_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0BBQkNERUZH";
    const TEST_RECOVERY_VERIFIER: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    /// The same material a retried receipt would resend.
    fn test_keys() -> AccountKeyMaterial<'static> {
        AccountKeyMaterial {
            wrapped_password: TEST_WRAPPED_ACCOUNT_KEY,
            wrapped_recovery: TEST_WRAPPED_ACCOUNT_KEY,
            recovery_verifier: TEST_RECOVERY_VERIFIER,
        }
    }

    async fn cleanup(db: &PgPool, redis: &mut ConnectionManager, token: &str, user_id: Uuid) {
        email_verify::delete_pending(redis, token).await.unwrap();
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retry_completes_after_failure_immediately_after_receipt_transition() {
        let db = test_db().await;
        let mut redis = test_redis().await;
        let email = format!("receipt-failure-{}@example.com", Uuid::now_v7());
        let token = email_verify::create_pending(&mut redis, &pending(email))
            .await
            .unwrap();

        let (_, user_id) = authorize(&mut redis, &token).await;
        // Inject the failure by abandoning the workflow at this exact durable
        // boundary, then replaying the same verified request.
        let (record, retry_user_id) = authorize(&mut redis, &token).await;
        assert_eq!(retry_user_id, user_id);
        ensure_verified_user(&db, None, retry_user_id, &record, test_keys())
            .await
            .unwrap();
        let session_token = session::create_session(
            &mut redis,
            retry_user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        assert!(
            session::get_session(&mut redis, &session_token)
                .await
                .unwrap()
                .is_some()
        );

        cleanup(&db, &mut redis, &token, user_id).await;
    }

    #[tokio::test]
    async fn the_account_keeps_the_language_it_signed_up_in() {
        let db = test_db().await;
        let mut redis = test_redis().await;
        let mut record = pending(format!("language-{}@example.com", Uuid::now_v7()));
        record.language = "ar".to_string();
        let token = email_verify::create_pending(&mut redis, &record)
            .await
            .unwrap();
        let (record, user_id) = authorize(&mut redis, &token).await;
        ensure_verified_user(&db, None, user_id, &record, test_keys())
            .await
            .unwrap();

        let stored = sqlx::query_scalar!("SELECT language FROM users WHERE id = $1", user_id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(stored, "ar");
        assert_eq!(
            crate::mail::language_for_email(&db, &record.email).await,
            crate::mail::Language::Ar
        );

        cleanup(&db, &mut redis, &token, user_id).await;
    }

    #[test]
    fn resend_mail_rounds_the_original_remaining_lifetime_up_to_minutes() {
        let mut record = pending("remaining@example.com".to_string());
        record.expires_at = OffsetDateTime::now_utc() + Duration::seconds(119);
        assert_eq!(remaining_verification_minutes(&record), 2);
    }

    #[tokio::test]
    async fn reauthentication_rate_limit_is_scoped_and_enforced_per_user_and_ip() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let address = "127.0.0.77".parse().unwrap();

        assert!(
            check_reauthentication_rate_limit(&mut redis, address, user_id, 1)
                .await
                .unwrap()
        );
        assert!(
            !check_reauthentication_rate_limit(&mut redis, address, user_id, 1)
                .await
                .unwrap()
        );
        assert!(
            check_reauthentication_rate_limit(&mut redis, address, Uuid::now_v7(), 1)
                .await
                .unwrap(),
            "one account's failures must not consume another account's allowance"
        );
    }

    #[tokio::test]
    async fn retry_completes_after_failure_immediately_after_user_insert() {
        let db = test_db().await;
        let mut redis = test_redis().await;
        let email = format!("insert-failure-{}@example.com", Uuid::now_v7());
        let token = email_verify::create_pending(&mut redis, &pending(email))
            .await
            .unwrap();
        let (record, user_id) = authorize(&mut redis, &token).await;

        ensure_verified_user(&db, None, user_id, &record, test_keys())
            .await
            .unwrap();
        // The first request disappears after PostgreSQL commits. A replay must
        // recognize this receipt's exact UUID rather than treating the email
        // conflict as authorization for a different pending signup.
        let (retry_record, retry_user_id) = authorize(&mut redis, &token).await;
        assert_eq!(retry_user_id, user_id);
        ensure_verified_user(&db, None, retry_user_id, &retry_record, test_keys())
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let session_token = session::create_session(
            &mut redis,
            retry_user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        assert!(
            session::get_session(&mut redis, &session_token)
                .await
                .unwrap()
                .is_some()
        );

        cleanup(&db, &mut redis, &token, user_id).await;
    }

    #[tokio::test]
    async fn a_different_verified_pending_signup_cannot_claim_an_existing_user() {
        let db = test_db().await;
        let mut redis = test_redis().await;
        let email = format!("competing-pending-{}@example.com", Uuid::now_v7());
        let first_token = email_verify::create_pending(&mut redis, &pending(email.clone()))
            .await
            .unwrap();
        let second_token = email_verify::create_pending(&mut redis, &pending(email))
            .await
            .unwrap();
        let (first_record, first_user_id) = authorize(&mut redis, &first_token).await;
        let (second_record, second_user_id) = authorize(&mut redis, &second_token).await;
        assert_ne!(first_user_id, second_user_id);

        ensure_verified_user(&db, None, first_user_id, &first_record, test_keys())
            .await
            .unwrap();
        assert!(matches!(
            ensure_verified_user(&db, None, second_user_id, &second_record, test_keys()).await,
            Err(ApiError::Unauthorized)
        ));
        let stored_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
            .bind(&first_record.email)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(stored_id, first_user_id);

        email_verify::delete_pending(&mut redis, &second_token)
            .await
            .unwrap();
        cleanup(&db, &mut redis, &first_token, first_user_id).await;
    }

    #[tokio::test]
    async fn retry_completes_after_failure_immediately_after_session_creation() {
        let db = test_db().await;
        let mut redis = test_redis().await;
        let email = format!("session-failure-{}@example.com", Uuid::now_v7());
        let token = email_verify::create_pending(&mut redis, &pending(email))
            .await
            .unwrap();
        let (record, user_id) = authorize(&mut redis, &token).await;
        ensure_verified_user(&db, None, user_id, &record, test_keys())
            .await
            .unwrap();
        let lost_session = session::create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();

        let (retry_record, retry_user_id) = authorize(&mut redis, &token).await;
        assert_eq!(retry_user_id, user_id);
        ensure_verified_user(&db, None, retry_user_id, &retry_record, test_keys())
            .await
            .unwrap();
        let retry_session = session::create_session(
            &mut redis,
            retry_user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        assert_ne!(lost_session, retry_session);
        assert!(
            session::get_session(&mut redis, &lost_session)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            session::get_session(&mut redis, &retry_session)
                .await
                .unwrap()
                .is_some()
        );

        session::delete_session(&mut redis, &lost_session)
            .await
            .unwrap();
        session::delete_session(&mut redis, &retry_session)
            .await
            .unwrap();
        cleanup(&db, &mut redis, &token, user_id).await;
    }
}
