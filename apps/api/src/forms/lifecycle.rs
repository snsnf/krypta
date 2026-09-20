//! Handing a form over, and taking it away.
//!
//! Under `forms` rather than `sharing`: deleting a form is form lifecycle, and
//! it only ever lived beside the invitation code because it needed the same
//! owner check. `main.rs` routed DELETE /forms/:id into `sharing` while GET and
//! PATCH went to `forms`, so a reader looking for form deletion started in the
//! wrong file.
//!
//! Ownership transfer is a proven seam rather than a hypothetical one: it has
//! two callers, the owner-facing route here and the admin account-lifecycle
//! path, which is why `prepare_` and `apply_` are split and `pub(crate)`.

use axum::extract::State;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::sharing::access::lock_and_require_owner_for_deletion;
use crate::{
    auth::extractor::SessionUser,
    error::{ApiError, ApiJson, ApiPath, ApiResponse, ApiResult},
    sharing::models::TransferOwnershipBody,
    state::AppState,
};

#[derive(Clone, Copy)]
pub(crate) struct PreparedOwnershipTransfer {
    current_owner_member_id: Uuid,
    pub(crate) current_owner_user_id: Uuid,
    target_member_id: Uuid,
    pub(crate) target_user_id: Uuid,
    attachment_bytes: i64,
}

pub(crate) async fn prepare_ownership_transfer(
    transaction: &mut Transaction<'_, Postgres>,
    form_id: Uuid,
    expected_owner_user_id: Option<Uuid>,
    target_member_id: Uuid,
    allowed_target_roles: &[&str],
) -> Result<Option<PreparedOwnershipTransfer>, ApiError> {
    let Some(form) = sqlx::query(
        "SELECT attachment_bytes
         FROM forms
         WHERE id = $1 AND deletion_started_at IS NULL
         FOR UPDATE",
    )
    .bind(form_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    else {
        return Ok(None);
    };

    let memberships = sqlx::query(
        "SELECT id, user_id, role, state
         FROM form_members
         WHERE form_id = $1
         ORDER BY id
         FOR UPDATE",
    )
    .bind(form_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let current_owner = memberships.iter().find(|membership| {
        membership.get::<String, _>("role") == "owner"
            && membership.get::<String, _>("state") == "active"
            && expected_owner_user_id
                .is_none_or(|owner_user_id| membership.get::<Uuid, _>("user_id") == owner_user_id)
    });
    let target = memberships.iter().find(|membership| {
        membership.get::<Uuid, _>("id") == target_member_id
            && membership.get::<String, _>("state") == "active"
            && allowed_target_roles
                .iter()
                .any(|role| membership.get::<String, _>("role") == *role)
    });
    let (Some(current_owner), Some(target)) = (current_owner, target) else {
        return Ok(None);
    };

    Ok(Some(PreparedOwnershipTransfer {
        current_owner_member_id: current_owner.get("id"),
        current_owner_user_id: current_owner.get("user_id"),
        target_member_id: target.get("id"),
        target_user_id: target.get("user_id"),
        attachment_bytes: form.get("attachment_bytes"),
    }))
}

pub(crate) async fn apply_ownership_transfer(
    transaction: &mut Transaction<'_, Postgres>,
    form_id: Uuid,
    prepared: PreparedOwnershipTransfer,
    billing_enabled: bool,
) -> Result<(Uuid, Uuid), ApiError> {
    crate::admin::settings::transfer_form_usage(
        transaction,
        prepared.current_owner_user_id,
        prepared.target_user_id,
        prepared.attachment_bytes,
        billing_enabled,
    )
    .await?;

    let demoted = sqlx::query(
        "UPDATE form_members
         SET role = 'editor', updated_at = now()
         WHERE id = $1 AND form_id = $2 AND role = 'owner' AND state = 'active'",
    )
    .bind(prepared.current_owner_member_id)
    .bind(form_id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if demoted.rows_affected() != 1 {
        return Err(ApiError::NotFound);
    }

    let promoted = sqlx::query(
        // An Owner defaults to notifications on; without this, a promoted
        // member would otherwise inherit the collaborator default of off and
        // silently hear nothing about responses to a form they now own.
        // Seeding last_notified_at at the same moment means the new Owner
        // hears only about responses arriving after the promotion, not the
        // form's entire history.
        //
        // The new Owner must be an account that is neither suspended nor
        // being deleted, checked in this statement and under a share lock on
        // their users row. Admin account deletion locks that row first and
        // ends by removing every membership the account holds, so a form
        // promoted to it mid-deletion would be left with no Owner at all.
        // The lock makes the two serialize: whichever commits second sees the
        // other.
        "UPDATE form_members
         SET role = 'owner', notify_on_response = true, last_notified_at = now(), updated_at = now()
         WHERE id = $1 AND form_id = $2 AND role IN ('editor', 'viewer') AND state = 'active'
           AND EXISTS (
               SELECT 1 FROM users
               WHERE users.id = form_members.user_id
                 AND users.suspended_at IS NULL
                 AND users.deletion_started_at IS NULL
               FOR SHARE
           )",
    )
    .bind(prepared.target_member_id)
    .bind(form_id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if promoted.rows_affected() != 1 {
        return Err(ApiError::NotFound);
    }

    Ok((prepared.current_owner_user_id, prepared.target_user_id))
}

pub async fn transfer_ownership(
    State(state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    user: SessionUser,
    ApiJson(body): ApiJson<TransferOwnershipBody>,
) -> ApiResult<serde_json::Value> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let Some(prepared) = prepare_ownership_transfer(
        &mut transaction,
        form_id,
        Some(user.user_id),
        body.member_id,
        &["editor", "viewer"],
    )
    .await?
    else {
        return Err(ApiError::NotFound);
    };
    apply_ownership_transfer(&mut transaction, form_id, prepared, state.billing_enabled()).await?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(ApiResponse::ok(serde_json::json!({})))
}

pub(crate) async fn delete_owned_form(
    state: &AppState,
    form_id: Uuid,
    owner_user_id: Uuid,
) -> Result<(), ApiError> {
    let mut close_transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    lock_and_require_owner_for_deletion(&mut close_transaction, form_id, owner_user_id).await?;
    sqlx::query!(
        "UPDATE forms
         SET accepting_responses = false,
             deletion_started_at = COALESCE(deletion_started_at, now())
         WHERE id = $1",
        form_id,
    )
    .execute(&mut *close_transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    close_transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    loop {
        let mut lifecycle_transaction = state
            .db
            .begin()
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
        lock_and_require_owner_for_deletion(&mut lifecycle_transaction, form_id, owner_user_id)
            .await?;

        // A persisted uploading row remains fresh longer than the bounded S3
        // operation. Deletion waits for it; only an abandoned reservation may
        // be converted to cleanup_pending.
        let upload_stale_seconds = state.config.attachment_upload_stale_seconds as f64;
        sqlx::query!(
            "UPDATE attachments
             SET upload_state = 'cleanup_pending', lifecycle_updated_at = now()
             WHERE form_id = $1
               AND (
                   upload_state = 'ready'
                   OR (
                       upload_state = 'uploading'
                       AND lifecycle_updated_at <= now() - $2 * interval '1 second'
                   )
               )",
            form_id,
            upload_stale_seconds,
        )
        .execute(&mut *lifecycle_transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

        let has_fresh_upload = sqlx::query_scalar!(
            "SELECT EXISTS(
                SELECT 1 FROM attachments
                WHERE form_id = $1 AND upload_state = 'uploading'
             ) AS \"exists!\"",
            form_id,
        )
        .fetch_one(&mut *lifecycle_transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        if has_fresh_upload {
            lifecycle_transaction
                .commit()
                .await
                .map_err(|error| ApiError::Internal(error.into()))?;
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            continue;
        }

        let attachment_ids = sqlx::query_scalar!(
            "SELECT id FROM attachments
             WHERE form_id = $1 AND upload_state = 'cleanup_pending'
             ORDER BY id
             FOR UPDATE",
            form_id,
        )
        .fetch_all(&mut *lifecycle_transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        if attachment_ids.is_empty() {
            let deleted = sqlx::query!("DELETE FROM forms WHERE id = $1", form_id)
                .execute(&mut *lifecycle_transaction)
                .await
                .map_err(|error| ApiError::Internal(error.into()))?;
            if deleted.rows_affected() != 1 {
                return Err(ApiError::NotFound);
            }
            crate::admin::settings::release_form_slot(&mut lifecycle_transaction, owner_user_id)
                .await?;
            lifecycle_transaction
                .commit()
                .await
                .map_err(|error| ApiError::Internal(error.into()))?;
            return Ok(());
        }
        lifecycle_transaction
            .commit()
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;

        for attachment_id in attachment_ids {
            crate::attachments::cleanup::cleanup_attachment(
                &state.db,
                &state.storage,
                form_id,
                attachment_id,
            )
            .await
            .map_err(ApiError::Internal)?;
        }
    }
}

pub async fn delete_form(
    State(state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    user: SessionUser,
) -> ApiResult<serde_json::Value> {
    delete_owned_form(&state, form_id, user.user_id).await?;
    Ok(ApiResponse::ok(serde_json::json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sharing::access::test_support::insert_owner_form;

    async fn test_state(mailer: crate::mail::Mailer) -> AppState {
        AppState::for_tests(mailer).await
    }

    #[tokio::test]
    async fn delete_form_storage_failure_keeps_a_closed_form_for_retry() {
        let mut state = test_state(crate::mail::Mailer::capture()).await;
        state.storage = crate::attachments::storage::Storage::new(
            "http://127.0.0.1:1".to_string(),
            "garage".to_string(),
            "unreachable-access-key".to_string(),
            "unreachable-secret-key".to_string(),
            "unreachable-bucket".to_string(),
            1,
        )
        .unwrap();
        let (owner_id, form_id) = insert_owner_form(&state.db).await;
        let attachment_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO attachments (id, form_id, byte_size) VALUES ($1, $2, 1)",
            attachment_id,
            form_id,
        )
        .execute(&state.db)
        .await
        .unwrap();

        let error = match delete_form(
            State(state.clone()),
            ApiPath(form_id),
            SessionUser {
                user_id: owner_id,
                second_factor_verified: false,
            },
        )
        .await
        {
            Ok(_) => panic!("form deletion unexpectedly ignored storage failure"),
            Err(error) => error,
        };
        assert!(matches!(error, ApiError::Internal(_)));
        let retained = sqlx::query!(
            "SELECT accepting_responses, deletion_started_at
             FROM forms WHERE id = $1",
            form_id,
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert!(!retained.accepting_responses);
        assert!(retained.deletion_started_at.is_some());
        let retained_attachment = sqlx::query!(
            "SELECT upload_state, byte_size FROM attachments WHERE id = $1",
            attachment_id,
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(retained_attachment.upload_state, "cleanup_pending");
        assert_eq!(retained_attachment.byte_size, 1);

        sqlx::query!("DELETE FROM forms WHERE id = $1", form_id)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query!("DELETE FROM users WHERE id = $1", owner_id)
            .execute(&state.db)
            .await
            .unwrap();
    }
}
