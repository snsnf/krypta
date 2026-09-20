//! A form's manual grades: one ciphertext blob per form, versioned on its own.
//!
//! The blob is encrypted in the browser under the quiz key, which the server
//! never holds, so this module stores and returns opaque bytes and decides only
//! who may do so. One blob per form rather than one per response is deliberate:
//! the server learns only when and how many times grades were saved, never
//! which response or question a grade belongs to.

use axum::extract::State;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::extractor::SessionUser,
    error::{ApiError, ApiJson, ApiPath, ApiResponse, ApiResult},
    form_access::FormAccess,
    state::AppState,
};

pub async fn get_grades(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath(id): ApiPath<Uuid>,
) -> ApiResult<serde_json::Value> {
    FormAccess::load(&state.db, id, user.user_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or(ApiError::NotFound)?
        .require_read()?;

    let row = sqlx::query!(
        "SELECT ciphertext, version FROM form_grades WHERE form_id = $1",
        id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    // Version 0 means "nothing graded yet", and is what the first write sends.
    Ok(ApiResponse::ok(match row {
        Some(row) => json!({ "ciphertext": row.ciphertext, "version": row.version }),
        None => json!({ "ciphertext": null, "version": 0 }),
    }))
}

#[derive(Deserialize)]
pub struct PutGradesBody {
    ciphertext: String,
    expected_version: i64,
}

pub async fn put_grades(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<PutGradesBody>,
) -> ApiResult<serde_json::Value> {
    if body.ciphertext.is_empty() {
        return Err(ApiError::BadRequest("invalid grades".to_string()));
    }

    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Form first, then membership, the order update_form and every membership
    // mutation use, so a removal and this write serialize instead of
    // deadlocking. Rights are decided under the membership lock, which holds
    // until commit: a member removed mid-request cannot still write.
    sqlx::query!(
        "SELECT id FROM forms WHERE id = $1 AND deletion_started_at IS NULL FOR UPDATE",
        id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;
    FormAccess::load_for_update(&mut transaction, id, user.user_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or(ApiError::NotFound)?
        .require_edit()?;

    let version = if body.expected_version == 0 {
        // Nothing returned means another first write got there first: the
        // same conflict a stale version is, and never retried here.
        sqlx::query_scalar!(
            "INSERT INTO form_grades (form_id, ciphertext) VALUES ($1, $2)
             ON CONFLICT (form_id) DO NOTHING
             RETURNING version",
            id,
            body.ciphertext,
        )
        .fetch_optional(&mut *transaction)
        .await
    } else {
        sqlx::query_scalar!(
            "UPDATE form_grades
             SET ciphertext = $2, version = version + 1, updated_at = now()
             WHERE form_id = $1 AND version = $3
             RETURNING version",
            id,
            body.ciphertext,
            body.expected_version,
        )
        .fetch_optional(&mut *transaction)
        .await
    }
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Conflict)?;

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(json!({ "version": version })))
}
