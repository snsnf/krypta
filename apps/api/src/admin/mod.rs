pub mod account_lifecycle;
pub mod guard;
pub mod routes;
pub mod settings;

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::error::ApiError;

pub async fn claim_initial_admin(
    transaction: &mut Transaction<'_, Postgres>,
    configured_email: Option<&str>,
    user_id: Uuid,
    verified_email: &str,
) -> Result<(), ApiError> {
    let Some(configured_email) = configured_email else {
        return Ok(());
    };

    if configured_email != verified_email.trim().to_ascii_lowercase() {
        return Ok(());
    }

    let claimed_user_id = sqlx::query_scalar!(
        "UPDATE instance_bootstrap
         SET claimed_user_id = $1, claimed_at = now()
         WHERE id = TRUE AND claimed_user_id IS NULL
         RETURNING claimed_user_id",
        user_id,
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if claimed_user_id.is_some() {
        sqlx::query!(
            "UPDATE users SET instance_admin = TRUE WHERE id = $1",
            user_id
        )
        .execute(&mut **transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    }

    Ok(())
}
