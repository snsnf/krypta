use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{extract::State, http::StatusCode, response::IntoResponse};
use tokio::sync::Mutex;

use crate::{health::probes, state::AppState};

/// How long a readiness answer is reused.
///
/// This endpoint is unauthenticated and touches the database, so without a
/// cache it is a small amplifier aimed at ourselves. Five seconds is short
/// enough that a checker polling every thirty always sees a fresh answer,
/// and long enough that a flood collapses into one query per five seconds.
const CACHE_FOR: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub struct ReadinessCache(Arc<Mutex<Option<(Instant, bool)>>>);

impl ReadinessCache {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Postgres and Redis only.
///
/// A B2 blip must not mark the instance down while forms still work, and an
/// SMTP probe is either a meaningless TCP connect or actually sending mail.
/// The body is one of two fixed strings: naming the failing dependency here
/// would tell an attacker the architecture and when it is weakest.
pub async fn handler(State(state): State<AppState>) -> impl IntoResponse {
    let cache = state.readiness.0.clone();
    let mut slot = cache.lock().await;
    if let Some((checked_at, ready)) = *slot
        && checked_at.elapsed() < CACHE_FOR
    {
        return response(ready);
    }

    let (postgres, redis) = tokio::join!(probes::postgres(&state.db), probes::redis(&state));
    let ready = postgres.reachable && redis.reachable;
    *slot = Some((Instant::now(), ready));
    response(ready)
}

fn response(ready: bool) -> (StatusCode, &'static str) {
    if ready {
        (StatusCode::OK, "ok")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    }
}
