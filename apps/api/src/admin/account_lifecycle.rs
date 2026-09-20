use axum::{extract::State, response::IntoResponse};
use axum_extra::extract::CookieJar;
use base64::Engine;
use rand::RngCore;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    admin::{
        guard::InstanceAdmin,
        routes::{AuditAction, AuditResult, record_audit},
    },
    error::{ApiError, ApiJson, ApiPath, ApiResponse, ApiResult},
    forms::lifecycle,
    session,
    sharing::models::TransferOwnershipBody,
    state::AppState,
};

const REAUTHENTICATION_RECEIPT_TTL_SECONDS: u64 = 5 * 60;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteAccountBody {
    reauthentication_receipt: String,
}

#[derive(Serialize, Deserialize)]
struct ReauthenticationReceiptRecord {
    user_id: Uuid,
    session_token_hash: String,
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn receipt_key(receipt: &str) -> String {
    format!("reauthentication_receipt:{}", sha256_hex(receipt))
}

pub fn presented_session_token(jar: &CookieJar) -> Result<String, ApiError> {
    jar.get("__Host-session")
        .map(|cookie| cookie.value().to_string())
        .ok_or(ApiError::Unauthorized)
}

pub async fn issue_reauthentication_receipt(
    redis: &mut redis::aio::ConnectionManager,
    user_id: Uuid,
    session_token: &str,
) -> anyhow::Result<String> {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let receipt = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let record = ReauthenticationReceiptRecord {
        user_id,
        session_token_hash: sha256_hex(session_token),
    };
    let value = serde_json::to_string(&record)?;
    let _: () = redis
        .set_ex(
            receipt_key(&receipt),
            value,
            REAUTHENTICATION_RECEIPT_TTL_SECONDS,
        )
        .await?;
    Ok(receipt)
}

pub async fn consume_reauthentication_receipt(
    redis: &mut redis::aio::ConnectionManager,
    user_id: Uuid,
    session_token: &str,
    receipt: &str,
) -> anyhow::Result<bool> {
    let key = receipt_key(receipt);
    let Some(value): Option<String> = redis::cmd("GETDEL").arg(&key).query_async(redis).await?
    else {
        return Ok(false);
    };
    let record: ReauthenticationReceiptRecord = serde_json::from_str(&value)?;
    if record.user_id != user_id || record.session_token_hash != sha256_hex(session_token) {
        return Ok(false);
    }
    Ok(true)
}

/// Requires a fresh password proof from the caller's own session.
///
/// For an operation a stolen session alone must not be able to perform: one
/// that mints standing access or a new way in, rather than using what the
/// session already has. The receipt comes from `/auth/reauthenticate`, is
/// single use, and is bound to the session that asked for it.
pub async fn require_reauthentication(
    redis: &mut redis::aio::ConnectionManager,
    user_id: Uuid,
    jar: &CookieJar,
    receipt: &str,
) -> Result<(), ApiError> {
    let session_token = presented_session_token(jar)?;
    let valid = consume_reauthentication_receipt(redis, user_id, &session_token, receipt)
        .await
        .map_err(ApiError::Internal)?;
    if valid {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

async fn count_other_admins(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, ApiError> {
    sqlx::query_scalar::<_, i64>(
        "SELECT count(*)
         FROM users
         WHERE instance_admin = TRUE
           AND id <> $1",
    )
    .bind(user_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))
}

async fn audit_and_commit(
    mut transaction: Transaction<'_, Postgres>,
    actor_user_id: Uuid,
    target_user_id: Option<Uuid>,
    action: AuditAction,
    result: AuditResult,
) -> Result<(), ApiError> {
    record_audit(
        &mut transaction,
        actor_user_id,
        target_user_id,
        action,
        result,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))
}

/// Records that a deletion failed after its barrier had committed.
///
/// By then the account is already marked and its sessions revoked, and some of
/// its forms may be gone, so the attempt must be visible in the append-only
/// log even though the handler is about to return an error. Written in its own
/// transaction because the one that failed may not be usable. Best effort: a
/// failure to write it is logged, and the caller's error is still returned.
async fn record_deletion_failure(state: &AppState, actor_user_id: Uuid, target_user_id: Uuid) {
    let result = async {
        let transaction = state
            .db
            .begin()
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
        audit_and_commit(
            transaction,
            actor_user_id,
            Some(target_user_id),
            AuditAction::AccountDeleted,
            AuditResult::Failed,
        )
        .await
    }
    .await;
    if result.is_err() {
        tracing::error!(
            user_id = %target_user_id,
            failure_kind = "account_deletion_audit",
            "could not record a failed account deletion"
        );
    }
}

async fn fetch_locked_user(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Option<(bool, bool, bool)>, ApiError> {
    let row = sqlx::query(
        "SELECT
            instance_admin,
            suspended_at IS NOT NULL AS suspended,
            deletion_started_at IS NOT NULL AS deletion_started
         FROM users
         WHERE id = $1
         FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(row.map(|row| {
        (
            row.get::<bool, _>("instance_admin"),
            row.get::<bool, _>("suspended"),
            row.get::<bool, _>("deletion_started"),
        )
    }))
}

async fn advance_session_generation_for_suspension(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE users
         SET session_generation = session_generation + 1
         WHERE id = $1",
    )
    .bind(user_id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

async fn mark_account_deletion_started(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE users
         SET deletion_started_at = now(),
             session_generation = session_generation + 1
         WHERE id = $1
           AND deletion_started_at IS NULL",
    )
    .bind(user_id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

async fn move_bootstrap_claim_if_needed(
    transaction: &mut Transaction<'_, Postgres>,
    deleted_user_id: Uuid,
) -> Result<(), ApiError> {
    let claimed = sqlx::query_scalar::<_, Uuid>(
        "SELECT claimed_user_id
         FROM instance_bootstrap
         WHERE id = TRUE AND claimed_user_id = $1
         FOR UPDATE",
    )
    .bind(deleted_user_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if claimed.is_none() {
        return Ok(());
    }

    let replacement_admin = sqlx::query_scalar::<_, Uuid>(
        "SELECT id
         FROM users
         WHERE instance_admin = TRUE
           AND id <> $1
         ORDER BY created_at, id
         LIMIT 1",
    )
    .bind(deleted_user_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    sqlx::query(
        "UPDATE instance_bootstrap
         SET claimed_user_id = $1
         WHERE id = TRUE",
    )
    .bind(replacement_admin)
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

pub async fn suspend_account(
    State(state): State<AppState>,
    ApiPath(target_user_id): ApiPath<Uuid>,
    admin: InstanceAdmin,
) -> Result<impl IntoResponse, ApiError> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let Some((instance_admin, suspended, _)) =
        fetch_locked_user(&mut transaction, target_user_id).await?
    else {
        return Err(ApiError::NotFound);
    };

    if admin.user_id == target_user_id
        || (instance_admin && count_other_admins(&mut transaction, target_user_id).await? == 0)
    {
        audit_and_commit(
            transaction,
            admin.user_id,
            Some(target_user_id),
            AuditAction::AccountSuspended,
            AuditResult::Rejected,
        )
        .await?;
        return Err(ApiError::Conflict);
    }

    if !suspended {
        sqlx::query(
            "UPDATE users
             SET suspended_at = COALESCE(suspended_at, now())
             WHERE id = $1",
        )
        .bind(target_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        advance_session_generation_for_suspension(&mut transaction, target_user_id).await?;
    }

    audit_and_commit(
        transaction,
        admin.user_id,
        Some(target_user_id),
        AuditAction::AccountSuspended,
        AuditResult::Succeeded,
    )
    .await?;

    let mut redis = state.redis.clone();
    if let Err(error) = session::delete_all_sessions_for_user(&mut redis, target_user_id).await {
        tracing::warn!(
            user_id = %target_user_id,
            error = %error,
            "best-effort session cleanup after suspend failed"
        );
    }
    Ok(ApiResponse::ok(json!({})))
}

pub async fn reactivate_account(
    State(state): State<AppState>,
    ApiPath(target_user_id): ApiPath<Uuid>,
    admin: InstanceAdmin,
) -> Result<impl IntoResponse, ApiError> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    if fetch_locked_user(&mut transaction, target_user_id)
        .await?
        .is_none()
    {
        return Err(ApiError::NotFound);
    }

    sqlx::query(
        "UPDATE users
         SET suspended_at = NULL
         WHERE id = $1",
    )
    .bind(target_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    audit_and_commit(
        transaction,
        admin.user_id,
        Some(target_user_id),
        AuditAction::AccountReactivated,
        AuditResult::Succeeded,
    )
    .await?;
    Ok(ApiResponse::ok(json!({})))
}

pub async fn transfer_form(
    State(state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    admin: InstanceAdmin,
    ApiJson(body): ApiJson<TransferOwnershipBody>,
) -> ApiResult<serde_json::Value> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let Some(prepared) = lifecycle::prepare_ownership_transfer(
        &mut transaction,
        form_id,
        None,
        body.member_id,
        &["editor"],
    )
    .await?
    else {
        audit_and_commit(
            transaction,
            admin.user_id,
            None,
            AuditAction::FormTransferred,
            AuditResult::Rejected,
        )
        .await?;
        return Err(ApiError::NotFound);
    };

    lifecycle::apply_ownership_transfer(
        &mut transaction,
        form_id,
        prepared,
        state.billing_enabled(),
    )
    .await?;
    audit_and_commit(
        transaction,
        admin.user_id,
        Some(prepared.target_user_id),
        AuditAction::FormTransferred,
        AuditResult::Succeeded,
    )
    .await?;
    Ok(ApiResponse::ok(json!({})))
}

pub async fn delete_account(
    State(state): State<AppState>,
    ApiPath(target_user_id): ApiPath<Uuid>,
    jar: CookieJar,
    admin: InstanceAdmin,
    ApiJson(body): ApiJson<DeleteAccountBody>,
) -> ApiResult<serde_json::Value> {
    let session_token = presented_session_token(&jar)?;
    let mut redis = state.redis.clone();
    let receipt_valid = consume_reauthentication_receipt(
        &mut redis,
        admin.user_id,
        &session_token,
        &body.reauthentication_receipt,
    )
    .await
    .map_err(ApiError::Internal)?;

    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let Some((instance_admin, _, deletion_started)) =
        fetch_locked_user(&mut transaction, target_user_id).await?
    else {
        return Err(ApiError::NotFound);
    };

    if !receipt_valid {
        audit_and_commit(
            transaction,
            admin.user_id,
            Some(target_user_id),
            AuditAction::AccountDeleted,
            AuditResult::Rejected,
        )
        .await?;
        return Err(ApiError::Unauthorized);
    }

    if admin.user_id == target_user_id
        || (instance_admin && count_other_admins(&mut transaction, target_user_id).await? == 0)
    {
        audit_and_commit(
            transaction,
            admin.user_id,
            Some(target_user_id),
            AuditAction::AccountDeleted,
            AuditResult::Rejected,
        )
        .await?;
        return Err(ApiError::Conflict);
    }

    // Deleting the account removes its local subscription row and cannot
    // cancel anything at Stripe, so a paying account would go on being charged
    // with nothing left to cancel it from. The account holder cancels first.
    // Only where this instance bills: without Stripe there is nothing to
    // cancel, and a row left from an earlier configuration must not make an
    // account undeletable.
    if state.billing_enabled()
        && crate::billing::quota::has_live_subscription(&mut transaction, target_user_id).await?
    {
        audit_and_commit(
            transaction,
            admin.user_id,
            Some(target_user_id),
            AuditAction::AccountDeleted,
            AuditResult::Rejected,
        )
        .await?;
        return Err(ApiError::ActiveSubscription);
    }

    let owned_form_ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT forms.id
         FROM forms
         JOIN form_members owner
           ON owner.form_id = forms.id
          AND owner.user_id = $1
          AND owner.role = 'owner'
          AND owner.state = 'active'
         ORDER BY forms.id",
    )
    .bind(target_user_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    for form_id in &owned_form_ids {
        let shared_member_count = sqlx::query_scalar::<_, i64>(
            "SELECT count(*)
             FROM form_members
             WHERE form_id = $1
               AND user_id <> $2",
        )
        .bind(form_id)
        .bind(target_user_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        if shared_member_count > 0 {
            audit_and_commit(
                transaction,
                admin.user_id,
                Some(target_user_id),
                AuditAction::AccountDeleted,
                AuditResult::Rejected,
            )
            .await?;
            return Err(ApiError::Conflict);
        }
    }

    if !deletion_started {
        mark_account_deletion_started(&mut transaction, target_user_id).await?;
    }

    // Committed with the barrier, so the log can never show nothing for an
    // account whose deletion had begun, whatever happens after this point.
    audit_and_commit(
        transaction,
        admin.user_id,
        Some(target_user_id),
        AuditAction::AccountDeletionStarted,
        AuditResult::Succeeded,
    )
    .await?;

    if let Err(error) = session::delete_all_sessions_for_user(&mut redis, target_user_id).await {
        tracing::warn!(
            user_id = %target_user_id,
            error = %error,
            "best-effort session cleanup after delete barrier failed"
        );
    }

    for form_id in owned_form_ids {
        if let Err(error) = lifecycle::delete_owned_form(&state, form_id, target_user_id).await {
            record_deletion_failure(&state, admin.user_id, target_user_id).await;
            return Err(error);
        }
    }

    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    if fetch_locked_user(&mut transaction, target_user_id)
        .await?
        .is_none()
    {
        drop(transaction);
        record_deletion_failure(&state, admin.user_id, target_user_id).await;
        return Err(ApiError::NotFound);
    }

    // The unscoped membership delete below would strip the Owner from any form
    // this account owns right now, leaving it with none. Its own forms were
    // deleted above, and a transfer can no longer promote an account marked
    // for deletion, so this finds nothing unless something outside both paths
    // changed the table. If it does, stop rather than orphan someone's form.
    let still_owned = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM form_members WHERE user_id = $1 AND role = 'owner'",
    )
    .bind(target_user_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if still_owned > 0 {
        audit_and_commit(
            transaction,
            admin.user_id,
            Some(target_user_id),
            AuditAction::AccountDeleted,
            AuditResult::Failed,
        )
        .await?;
        return Err(ApiError::Conflict);
    }

    move_bootstrap_claim_if_needed(&mut transaction, target_user_id).await?;

    sqlx::query(
        "DELETE FROM form_invitations
         WHERE recipient_user_id = $1",
    )
    .bind(target_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    sqlx::query(
        "DELETE FROM form_members
         WHERE user_id = $1",
    )
    .bind(target_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    sqlx::query(
        "DELETE FROM users
         WHERE id = $1",
    )
    .bind(target_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    audit_and_commit(
        transaction,
        admin.user_id,
        Some(target_user_id),
        AuditAction::AccountDeleted,
        AuditResult::Succeeded,
    )
    .await?;
    Ok(ApiResponse::ok(json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::aio::ConnectionManager;
    use std::sync::Arc;
    use tokio::sync::Barrier;

    async fn test_redis() -> ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        ConnectionManager::new(client).await.unwrap()
    }

    #[tokio::test]
    async fn reauthentication_receipt_consumes_atomically_under_concurrency() {
        let user_id = Uuid::now_v7();
        let session_token = format!("reauth-concurrent-session-{}", Uuid::now_v7());

        for _ in 0..128 {
            let mut issuer = test_redis().await;
            let receipt = issue_reauthentication_receipt(&mut issuer, user_id, &session_token)
                .await
                .unwrap();

            let barrier = Arc::new(Barrier::new(3));
            let task_a = tokio::spawn({
                let barrier = barrier.clone();
                let session_token = session_token.clone();
                let receipt = receipt.clone();
                async move {
                    let mut redis = test_redis().await;
                    barrier.wait().await;
                    consume_reauthentication_receipt(&mut redis, user_id, &session_token, &receipt)
                        .await
                        .unwrap()
                }
            });
            let task_b = tokio::spawn({
                let barrier = barrier.clone();
                let session_token = session_token.clone();
                let receipt = receipt.clone();
                async move {
                    let mut redis = test_redis().await;
                    barrier.wait().await;
                    consume_reauthentication_receipt(&mut redis, user_id, &session_token, &receipt)
                        .await
                        .unwrap()
                }
            });
            barrier.wait().await;
            let results = [task_a.await.unwrap(), task_b.await.unwrap()];
            assert_eq!(
                results.into_iter().filter(|result| *result).count(),
                1,
                "reauthentication receipt was consumed more than once"
            );
        }
    }
}
