//! The account sharing keypair.
//!
//! Not form sharing, despite living under `sharing`: this is one keypair per
//! account, routed under `/api/v1/account/sharing-key`, and it touches only the
//! `users` table. It shared a file with the invitation and membership handlers
//! for no reason other than the file being where sharing code went.

use axum::extract::State;
use base64::Engine;

use crate::{
    auth::extractor::SessionUser,
    error::{ApiError, ApiJson, ApiResponse, ApiResult},
    sharing::models::{PutSharingKeyBody, SharingKeyResponse},
    state::AppState,
};

/// Version 1 means X-Wing. No version-1 X25519 key survived the clean break,
/// so the number buys nothing on its own: algorithm identity lives in the blob
/// tag, and the length check below is what actually rejects an old key.
pub(crate) const SHARING_KEY_VERSION: i16 = 1;
/// X-Wing's public key: ML-KEM-768's 1184 bytes plus the 32-byte X25519 half.
/// Swapping the sealing primitive changes this constant.
const SHARING_PUBLIC_KEY_BYTES: usize = 1216;

pub fn validate_sharing_key_body(body: &PutSharingKeyBody) -> Result<(), ApiError> {
    let public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&body.sharing_public_key)
        .map_err(|_| ApiError::BadRequest("Invalid request".into()))?;
    let wrapped_private_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&body.wrapped_sharing_private_key)
        .map_err(|_| ApiError::BadRequest("Invalid request".into()))?;

    if public_key.len() != SHARING_PUBLIC_KEY_BYTES
        || wrapped_private_key.len() != 72
        || body.sharing_key_version != SHARING_KEY_VERSION
    {
        return Err(ApiError::BadRequest("Invalid request".into()));
    }

    Ok(())
}

pub async fn get_sharing_key(
    State(state): State<AppState>,
    user: SessionUser,
) -> ApiResult<SharingKeyResponse> {
    let row = sqlx::query!(
        "SELECT sharing_public_key, wrapped_sharing_private_key, sharing_key_version
         FROM users WHERE id = $1",
        user.user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let Some(row) = row else {
        return Err(ApiError::NotFound);
    };

    Ok(ApiResponse::ok(SharingKeyResponse {
        user_id: user.user_id,
        sharing_public_key: row.sharing_public_key,
        wrapped_sharing_private_key: row.wrapped_sharing_private_key,
        sharing_key_version: row.sharing_key_version,
    }))
}

pub async fn put_sharing_key(
    State(state): State<AppState>,
    user: SessionUser,
    ApiJson(body): ApiJson<PutSharingKeyBody>,
) -> ApiResult<serde_json::Value> {
    if body.expected_user_id != user.user_id {
        return Err(ApiError::Conflict);
    }
    validate_sharing_key_body(&body)?;

    let result = sqlx::query!(
        "UPDATE users
         SET sharing_public_key = $1,
             wrapped_sharing_private_key = $2,
             sharing_key_version = 1,
             sharing_key_created_at = now()
         WHERE id = $3
           AND (
             sharing_public_key IS NULL
             OR (sharing_public_key = $1 AND wrapped_sharing_private_key = $2
                 AND sharing_key_version = 1)
           )",
        body.sharing_public_key,
        body.wrapped_sharing_private_key,
        user.user_id,
    )
    .execute(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if result.rows_affected() == 0 {
        let account_exists = sqlx::query_scalar!(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)",
            user.user_id
        )
        .fetch_one(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

        if account_exists.unwrap_or(false) {
            return Err(ApiError::Conflict);
        }
        return Err(ApiError::NotFound);
    }

    Ok(ApiResponse::ok(serde_json::json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn valid_body() -> PutSharingKeyBody {
        PutSharingKeyBody {
            expected_user_id: Uuid::now_v7(),
            sharing_public_key: base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode([7_u8; SHARING_PUBLIC_KEY_BYTES]),
            wrapped_sharing_private_key: base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode([9_u8; 72]),
            sharing_key_version: SHARING_KEY_VERSION,
        }
    }

    #[test]
    fn sharing_key_validation_accepts_the_required_record_shape() {
        assert!(validate_sharing_key_body(&valid_body()).is_ok());
    }

    #[test]
    fn sharing_key_validation_rejects_wrong_encoding_lengths_and_version() {
        let mut body = valid_body();
        body.sharing_public_key = "not base64!".to_string();
        assert!(matches!(
            validate_sharing_key_body(&body),
            Err(ApiError::BadRequest(message)) if message == "Invalid request"
        ));

        let mut body = valid_body();
        body.sharing_public_key = format!("{}=", body.sharing_public_key);
        assert!(matches!(
            validate_sharing_key_body(&body),
            Err(ApiError::BadRequest(message)) if message == "Invalid request"
        ));

        let mut body = valid_body();
        body.sharing_public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode([7_u8; SHARING_PUBLIC_KEY_BYTES - 1]);
        assert!(matches!(
            validate_sharing_key_body(&body),
            Err(ApiError::BadRequest(message)) if message == "Invalid request"
        ));

        let mut body = valid_body();
        body.wrapped_sharing_private_key =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9_u8; 71]);
        assert!(matches!(
            validate_sharing_key_body(&body),
            Err(ApiError::BadRequest(message)) if message == "Invalid request"
        ));

        let mut body = valid_body();
        body.sharing_key_version = 2;
        assert!(matches!(
            validate_sharing_key_body(&body),
            Err(ApiError::BadRequest(message)) if message == "Invalid request"
        ));
    }
}
