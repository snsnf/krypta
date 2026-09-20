use std::time::Instant;

use serde::Serialize;
use sqlx::PgPool;

use crate::state::AppState;

/// Every probe is bounded by this. A hung dependency must answer, not hang
/// the request until the proxy gives up.
pub(crate) const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Serialize)]
pub struct Probe {
    pub reachable: bool,
    pub latency_ms: Option<u64>,
}

impl Probe {
    fn unreachable() -> Self {
        Self {
            reachable: false,
            latency_ms: None,
        }
    }

    fn reached(started: Instant) -> Self {
        Self {
            reachable: true,
            latency_ms: Some(started.elapsed().as_millis() as u64),
        }
    }
}

pub async fn postgres(db: &PgPool) -> Probe {
    let started = Instant::now();
    let query = sqlx::query_scalar!(r#"SELECT 1 AS "one!""#).fetch_one(db);
    match tokio::time::timeout(PROBE_TIMEOUT, query).await {
        Ok(Ok(_)) => Probe::reached(started),
        _ => Probe::unreachable(),
    }
}

pub async fn redis(state: &AppState) -> Probe {
    let started = Instant::now();
    let mut connection = state.redis.clone();
    let ping = async move {
        redis::cmd("PING")
            .query_async::<String>(&mut connection)
            .await
    };
    match tokio::time::timeout(PROBE_TIMEOUT, ping).await {
        Ok(Ok(_)) => Probe::reached(started),
        _ => Probe::unreachable(),
    }
}

pub async fn storage(state: &AppState) -> Probe {
    let started = Instant::now();
    if state.storage.reachable().await {
        Probe::reached(started)
    } else {
        Probe::unreachable()
    }
}

/// Reachability only. A TCP connect proves something is listening at the
/// configured host and port; it proves neither an SMTP conversation, nor
/// authentication, nor delivery. An `EHLO` was considered and rejected:
/// `SMTP_TLS` supports `implicit` (port 465), where a raw `EHLO` sent before
/// the TLS handshake would fail, so an EHLO probe would behave differently
/// across the three supported TLS modes. Sending a real message on every
/// refresh would spam a mailbox and burn relay quota, so the page states
/// this limitation rather than overclaiming.
pub async fn mail(state: &AppState) -> Probe {
    let started = Instant::now();
    if !state.config.mail_configured() {
        return Probe::unreachable();
    }
    let address = format!("{}:{}", state.config.smtp_host, state.config.smtp_port);
    let connect = tokio::net::TcpStream::connect(address);
    match tokio::time::timeout(PROBE_TIMEOUT, connect).await {
        Ok(Ok(_)) => Probe::reached(started),
        _ => Probe::unreachable(),
    }
}
