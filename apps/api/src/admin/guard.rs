use axum::{async_trait, extract::FromRequestParts, http::request::Parts};
use uuid::Uuid;

use crate::{auth::extractor::SessionUser, error::ApiError, state::AppState};

pub struct InstanceAdmin {
    pub user_id: Uuid,
}

#[async_trait]
impl FromRequestParts<AppState> for InstanceAdmin {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = SessionUser::from_request_parts(parts, state).await?;
        let admin_user_id = sqlx::query_scalar!(
            "SELECT id
             FROM users
             WHERE id = $1
               AND instance_admin = TRUE
               AND email_verified_at IS NOT NULL
               AND totp_secret IS NOT NULL
               AND totp_enabled = TRUE",
            user.user_id,
        )
        .fetch_optional(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        let Some(user_id) = admin_user_id else {
            return Err(ApiError::Unauthorized);
        };

        if !user.second_factor_verified {
            return Err(ApiError::Unauthorized);
        }

        Ok(Self { user_id })
    }
}
