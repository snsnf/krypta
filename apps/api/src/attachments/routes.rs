use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::{
    admin::settings,
    auth::extractor::SessionUser,
    client_ip::ClientIp,
    error::{ApiError, ApiPath, ApiResponse, ApiResult},
    form_access::FormAccess,
    forms::routes::{count_responses_under_lock, form_is_open},
    state::AppState,
};

// The 10 MiB a user is promised, plus the 1114-byte increase in sealing
// overhead when crypto_box_seal (48 bytes) became hybrid KEM-DEM (1162).
// The check below is against the sealed upload, so without this the
// effective plaintext limit would silently drop below 10 MiB.
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024 + 1114;
const MAX_UPLOADS_PER_SOURCE_PER_FORM_PER_MINUTE: u32 = 5;
// The header image route needs no session and pulls up to about 10 MiB from
// the object store per request, which on a hosted store is paid egress. This
// is an abuse ceiling, not a crowd limit: it is scoped per form per source,
// so a classroom, an office, or a carrier-grade NAT sharing one address while
// opening the SAME form link must stay well inside it. At the limit that is
// up to roughly 6 GiB of egress per source per form per minute in the worst
// case, which bounds a single address hammering one form without capping a
// real audience opening it together.
const HEADER_IMAGE_READS_PER_SOURCE_PER_FORM_PER_MINUTE: u32 = 600;
const MAX_ATTACHMENTS_PER_FORM: i32 = 20;
const MAX_ATTACHMENT_BYTES_PER_FORM: i64 = 100 * 1024 * 1024;

pub async fn upload_attachment(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    // Uploads are anonymous, so a missing or invalid session is not an
    // error here. When one IS present and belongs to a member who may edit
    // the form, the row records it, and that record is what later lets
    // `update_form` accept the attachment as the form's header image. A
    // respondent's upload never carries it, so the public header route can
    // never be aimed at one. See migration 0026.
    uploader: Option<SessionUser>,
    ApiPath(form_id): ApiPath<Uuid>,
    headers: HeaderMap,
    bytes: Bytes,
) -> ApiResult<serde_json::Value> {
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("attachments:{form_id}:source:{}", client_ip),
        MAX_UPLOADS_PER_SOURCE_PER_FORM_PER_MINUTE,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(ApiError::PayloadTooLarge);
    }

    let attachment_id = Uuid::now_v7();
    let byte_size = i64::try_from(bytes.len()).map_err(|_| ApiError::PayloadTooLarge)?;
    let uploaded_by = match uploader {
        Some(user) => FormAccess::load(&state.db, form_id, user.user_id)
            .await
            .map_err(|error| ApiError::Internal(error.into()))?
            .filter(|access| access.require_edit().is_ok())
            .map(|_| user.user_id),
        None => None,
    };
    let mut reservation = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let form = sqlx::query!(
        "SELECT accepting_responses, closes_at, max_responses, deletion_started_at
         FROM forms WHERE id = $1 FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *reservation)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let Some(form) = form else {
        return Err(ApiError::NotFound);
    };
    // Counted under the same `FOR UPDATE` lock `submit_response` takes on this
    // row, so the two serialize and this count cannot go stale between here
    // and the reservation UPDATE below. That is what makes it a locked count
    // rather than a reported one.
    let response_count = count_responses_under_lock(&mut reservation, form_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    if form.deletion_started_at.is_some()
        || !form_is_open(
            form.accepting_responses,
            form.closes_at,
            form.max_responses,
            response_count,
        )
    {
        return Err(ApiError::FormClosed);
    }

    let owner_id = sqlx::query_scalar!(
        "SELECT owner.user_id
         FROM form_members owner
         JOIN users owner_user
           ON owner_user.id = owner.user_id
          AND owner_user.suspended_at IS NULL
         WHERE owner.form_id = $1
           AND owner.role = 'owner'
           AND owner.state = 'active'
         FOR UPDATE OF owner_user",
        form_id,
    )
    .fetch_optional(&mut *reservation)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;

    settings::reserve_attachment_bytes(
        &mut reservation,
        owner_id,
        byte_size,
        state.billing_enabled(),
    )
    .await?;

    let reservation_result = sqlx::query!(
        "UPDATE forms
         SET attachment_count = attachment_count + 1,
             attachment_bytes = attachment_bytes + $1
         WHERE id = $2
           AND accepting_responses
           AND deletion_started_at IS NULL
           AND attachment_count < $3
           AND attachment_bytes <= $4",
        byte_size,
        form_id,
        MAX_ATTACHMENTS_PER_FORM,
        MAX_ATTACHMENT_BYTES_PER_FORM - byte_size,
    )
    .execute(&mut *reservation)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if reservation_result.rows_affected() == 0 {
        return Err(ApiError::RateLimited);
    }

    sqlx::query!(
        "INSERT INTO attachments (
            id, form_id, byte_size, upload_state, upload_started_at,
            upload_completed_at, lifecycle_updated_at, uploaded_by
         ) VALUES ($1, $2, $3, 'uploading', now(), NULL, now(), $4)",
        attachment_id,
        form_id,
        byte_size,
        uploaded_by,
    )
    .execute(&mut *reservation)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    reservation
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    let key = format!("attachments/{form_id}/{attachment_id}");
    // The form and attachment locks remain held from the final lease check
    // through the bounded object PUT and ready transition. Deletion and stale
    // cleanup therefore cannot remove the only object reference while a write
    // is still permitted to complete.
    let mut upload_transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let form = sqlx::query!(
        "SELECT accepting_responses, closes_at, max_responses, deletion_started_at
         FROM forms WHERE id = $1 FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *upload_transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let Some(form) = form else {
        let _ = upload_transaction.rollback().await;
        return Err(ApiError::NotFound);
    };
    let response_count = count_responses_under_lock(&mut upload_transaction, form_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    if form.deletion_started_at.is_some()
        || !form_is_open(
            form.accepting_responses,
            form.closes_at,
            form.max_responses,
            response_count,
        )
    {
        let _ = upload_transaction.rollback().await;
        let _ = reconcile_failed_upload(&state, form_id, attachment_id).await;
        return Err(ApiError::FormClosed);
    }

    let owner_ready = sqlx::query_scalar!(
        "SELECT owner.user_id
         FROM form_members owner
         JOIN users owner_user
           ON owner_user.id = owner.user_id
          AND owner_user.suspended_at IS NULL
         WHERE owner.form_id = $1
           AND owner.role = 'owner'
           AND owner.state = 'active'
         FOR UPDATE OF owner_user",
        form_id,
    )
    .fetch_optional(&mut *upload_transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if owner_ready.is_none() {
        let _ = upload_transaction.rollback().await;
        let _ = reconcile_failed_upload(&state, form_id, attachment_id).await;
        return Err(ApiError::NotFound);
    }

    let upload_state = sqlx::query_scalar!(
        "SELECT upload_state FROM attachments
         WHERE id = $1 AND form_id = $2
         FOR UPDATE",
        attachment_id,
        form_id,
    )
    .fetch_optional(&mut *upload_transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if upload_state.as_deref() != Some("uploading") {
        let _ = upload_transaction.rollback().await;
        let _ = reconcile_failed_upload(&state, form_id, attachment_id).await;
        return Err(ApiError::Internal(anyhow::anyhow!(
            "attachment upload reservation expired"
        )));
    }

    sqlx::query!(
        "UPDATE attachments
         SET lifecycle_updated_at = now()
         WHERE id = $1 AND form_id = $2 AND upload_state = 'uploading'",
        attachment_id,
        form_id,
    )
    .execute(&mut *upload_transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    maybe_pause_before_put(&mut upload_transaction, &headers, form_id).await?;

    if let Err(error) = state.storage.put(&key, &bytes).await {
        let _ = upload_transaction.rollback().await;
        let _ = reconcile_failed_upload(&state, form_id, attachment_id).await;
        return Err(ApiError::Internal(error));
    }

    let finalized = sqlx::query!(
        "UPDATE attachments
         SET upload_state = 'ready', upload_completed_at = now(),
             lifecycle_updated_at = now()
         WHERE id = $1 AND form_id = $2 AND upload_state = 'uploading'",
        attachment_id,
        form_id,
    )
    .execute(&mut *upload_transaction)
    .await;
    let finalized = match finalized {
        Ok(finalized) if finalized.rows_affected() == 1 => finalized,
        Ok(_) => {
            let _ = upload_transaction.rollback().await;
            let _ = reconcile_failed_upload(&state, form_id, attachment_id).await;
            return Err(ApiError::Internal(anyhow::anyhow!(
                "attachment upload lifecycle changed before finalization"
            )));
        }
        Err(error) => {
            let _ = upload_transaction.rollback().await;
            let _ = reconcile_failed_upload(&state, form_id, attachment_id).await;
            return Err(ApiError::Internal(error.into()));
        }
    };
    debug_assert_eq!(finalized.rows_affected(), 1);

    if let Err(error) = upload_transaction.commit().await {
        let outcome = reconcile_failed_upload(&state, form_id, attachment_id).await;
        if outcome == Some(super::cleanup::UploadReconcileOutcome::Ready) {
            return Ok(ApiResponse::ok(
                serde_json::json!({ "attachment_id": attachment_id }),
            ));
        }
        return Err(ApiError::Internal(error.into()));
    }
    Ok(ApiResponse::ok(
        serde_json::json!({ "attachment_id": attachment_id }),
    ))
}

async fn reconcile_failed_upload(
    state: &AppState,
    form_id: Uuid,
    attachment_id: Uuid,
) -> Option<super::cleanup::UploadReconcileOutcome> {
    match super::cleanup::reconcile_upload(&state.db, &state.storage, form_id, attachment_id).await
    {
        Ok(outcome) => Some(outcome),
        Err(_) => {
            tracing::warn!(
                form_id = %form_id,
                attachment_id = %attachment_id,
                failure_kind = "failed_upload_reconciliation",
                "failed attachment upload reconciliation will be retried"
            );
            None
        }
    }
}

async fn maybe_pause_before_put(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    headers: &HeaderMap,
    form_id: Uuid,
) -> Result<(), ApiError> {
    #[cfg(debug_assertions)]
    if std::env::var("KRYPTA_ATTACHMENT_TEST_HOOKS").as_deref() == Ok("1")
        && headers
            .get("x-krypta-test-pause-upload")
            .and_then(|value| value.to_str().ok())
            == Some("after-reservation")
    {
        let form_id = form_id.to_string();
        sqlx::query!(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7009))",
            form_id,
        )
        .execute(&mut **transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    }
    Ok(())
}

pub async fn download_attachment(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath((form_id, attachment_id)): ApiPath<(Uuid, Uuid)>,
) -> Result<Response, ApiError> {
    let access = FormAccess::load(&state.db, form_id, user.user_id)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .ok_or(ApiError::NotFound)?;
    access.require_read()?;

    let is_ready = sqlx::query_scalar!(
        "SELECT EXISTS(
            SELECT 1 FROM attachments
            WHERE id = $1 AND form_id = $2 AND upload_state = 'ready'
         ) AS \"exists!\"",
        attachment_id,
        form_id,
    )
    .fetch_one(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if !is_ready {
        return Err(ApiError::NotFound);
    }

    let key = format!("attachments/{form_id}/{attachment_id}");
    let bytes = state.storage.get(&key).await.map_err(|_| {
        tracing::warn!(
            form_id = %form_id,
            attachment_id = %attachment_id,
            failure_kind = "attachment_object_fetch",
            "attachment fetch from storage failed"
        );
        ApiError::NotFound
    })?;

    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_DISPOSITION, "attachment".to_string()),
        ],
        bytes,
    )
        .into_response())
}

/*
 * The one attachment a form serves without a session, because a respondent has
 * to see the header before they have any reason to have an account.
 *
 * It authorises on the form's own pointer rather than on the id in the path:
 * the bytes are served only when the caller asks for exactly the attachment
 * this form names as its header. Accepting any attachment id belonging to the
 * form would turn a form link into a reader for every response attachment on
 * it.
 *
 * What is served is still ciphertext. It opens with the schema key, which
 * lives in the link fragment and never reaches this server, so the bytes are
 * as opaque here as the schema and the responses beside them.
 */
pub async fn download_header_image(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    ApiPath(form_id): ApiPath<Uuid>,
) -> Result<Response, ApiError> {
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("header_image:{form_id}:source:{client_ip}"),
        HEADER_IMAGE_READS_PER_SOURCE_PER_FORM_PER_MINUTE,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let attachment_id = sqlx::query_scalar!(
        "SELECT a.id
         FROM forms f
         JOIN attachments a ON a.id = f.header_attachment_id
         WHERE f.id = $1 AND a.form_id = f.id AND a.upload_state = 'ready'",
        form_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;

    let key = format!("attachments/{form_id}/{attachment_id}");
    let bytes = state.storage.get(&key).await.map_err(|_| {
        tracing::warn!(
            form_id = %form_id,
            attachment_id = %attachment_id,
            failure_kind = "header_image_object_fetch",
            "header image fetch from storage failed"
        );
        ApiError::NotFound
    })?;

    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream".to_string())],
        bytes,
    )
        .into_response())
}
