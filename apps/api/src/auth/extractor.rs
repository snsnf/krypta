use axum::{async_trait, extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::CookieJar;
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

pub struct SessionUser {
    pub user_id: Uuid,
    pub second_factor_verified: bool,
}

#[async_trait]
impl FromRequestParts<AppState> for SessionUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get("__Host-session")
            .map(|c| c.value().to_string())
            .ok_or(ApiError::Unauthorized)?;

        let mut redis = state.redis.clone();
        let session = crate::session::get_session(&mut redis, &token)
            .await
            .map_err(ApiError::Internal)?
            .ok_or(ApiError::Unauthorized)?;

        if session.scope != crate::session::SessionScope::Full {
            return Err(ApiError::Unauthorized);
        }

        let active_user = sqlx::query(
            "SELECT id
             FROM users
             WHERE id = $1
               AND suspended_at IS NULL
               AND deletion_started_at IS NULL
               AND session_generation = $2",
        )
        .bind(session.user_id)
        .bind(session.generation)
        .fetch_optional(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        if active_user.is_none() {
            return Err(ApiError::Unauthorized);
        }

        Ok(SessionUser {
            user_id: session.user_id,
            second_factor_verified: session.second_factor_verified,
        })
    }
}

/// Authorizes `/auth/recover/complete` and nothing else.
///
/// Deliberately not built on `SessionUser`: that type now rejects recovery
/// scope outright, and keeping the two disjoint means no handler can silently
/// widen what a recovery session reaches.
///
/// Wired into `/auth/recover/complete` (added in `7c2484a`); also exercised
/// directly by `tests/recovery_test.rs`.
pub struct RecoverySessionUser {
    pub user_id: Uuid,
}

#[async_trait]
impl FromRequestParts<AppState> for RecoverySessionUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get("__Host-session")
            .map(|c| c.value().to_string())
            .ok_or(ApiError::Unauthorized)?;

        let mut redis = state.redis.clone();
        let session = crate::session::get_session(&mut redis, &token)
            .await
            .map_err(ApiError::Internal)?
            .ok_or(ApiError::Unauthorized)?;

        if session.scope != crate::session::SessionScope::Recovery {
            return Err(ApiError::Unauthorized);
        }

        let active_user = sqlx::query(
            "SELECT id
             FROM users
             WHERE id = $1
               AND suspended_at IS NULL
               AND deletion_started_at IS NULL
               AND session_generation = $2",
        )
        .bind(session.user_id)
        .bind(session.generation)
        .fetch_optional(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        if active_user.is_none() {
            return Err(ApiError::Unauthorized);
        }

        Ok(RecoverySessionUser {
            user_id: session.user_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    /// Builds a real `AppState` against the dev Postgres/Redis, mirroring
    /// `AppState::for_tests`. `RecoverySessionUser` needs a
    /// live Redis to load the session it is extracting.
    async fn test_state() -> AppState {
        AppState::for_tests(crate::mail::Mailer::failing()).await
    }

    fn parts_with_cookie(token: &str) -> Parts {
        Request::builder()
            .header("Cookie", format!("__Host-session={token}"))
            .body(())
            .unwrap()
            .into_parts()
            .0
    }

    /// This is the proof, independent of any HTTP route existing, that a
    /// full-scope session cannot be used to complete a recovery: the
    /// extractor that guards `/auth/recover/complete` rejects it directly.
    ///
    /// `tests/recovery_test.rs` could exercise this through the real route
    /// now that `/auth/recover/complete` exists, but this test proves the
    /// extractor itself independent of routing, which is a guarantee worth
    /// keeping even though the route-level path is also covered elsewhere.
    #[tokio::test]
    async fn a_full_scope_session_is_rejected_by_the_recovery_extractor() {
        let state = test_state().await;
        let mut redis = state.redis.clone();
        let user_id = Uuid::now_v7();
        let email = format!("recovery-extractor-full-{user_id}@example.com");

        // The user must be a genuine active user (same as the accept-path
        // test below), so the only thing left that could reject this session
        // is the scope check. Without this row, `active_user.is_none()` at
        // :111 rejects on its own and the test passes whether or not the
        // scope check exists at all, proving nothing about `RecoverySessionUser`.
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'unit-hash')",
            user_id,
            email,
        )
        .execute(&state.db)
        .await
        .unwrap();

        let full_token = crate::session::create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();

        let mut parts = parts_with_cookie(&full_token);
        let result = RecoverySessionUser::from_request_parts(&mut parts, &state).await;

        assert!(
            matches!(result, Err(ApiError::Unauthorized)),
            "a full-scope session must not satisfy RecoverySessionUser"
        );

        crate::session::delete_session(&mut redis, &full_token)
            .await
            .unwrap();
        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&state.db)
            .await
            .unwrap();
    }

    /// Sanity check the other direction, so the test above cannot pass
    /// merely because the extractor rejects everything: a genuine
    /// recovery-scoped session for an active user is accepted.
    #[tokio::test]
    async fn a_recovery_scope_session_for_an_active_user_is_accepted() {
        let state = test_state().await;
        let mut redis = state.redis.clone();
        let user_id = Uuid::now_v7();
        let email = format!("recovery-extractor-{user_id}@example.com");
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'unit-hash')",
            user_id,
            email,
        )
        .execute(&state.db)
        .await
        .unwrap();

        let recovery_token = crate::session::create_scoped_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
            crate::session::SessionScope::Recovery,
            crate::session::RECOVERY_SESSION_TTL_SECS,
        )
        .await
        .unwrap();

        let mut parts = parts_with_cookie(&recovery_token);
        let result = RecoverySessionUser::from_request_parts(&mut parts, &state).await;

        let recovered =
            result.expect("a live recovery session for an active user must be accepted");
        assert_eq!(recovered.user_id, user_id);

        crate::session::delete_session(&mut redis, &recovery_token)
            .await
            .unwrap();
        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&state.db)
            .await
            .unwrap();
    }
}
