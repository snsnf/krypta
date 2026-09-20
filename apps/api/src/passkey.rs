use std::sync::Arc;

use rand::RngCore;
use redis::{AsyncCommands, aio::ConnectionManager};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use url::Url;
use webauthn_rs::{Webauthn, WebauthnBuilder};

/// How long a started ceremony stays redeemable. Long enough to pick a
/// credential and touch a sensor, short enough that an abandoned handle is
/// near-useless. Mirrors `totp::PENDING_TTL_SECS`.
const CEREMONY_TTL_SECS: u64 = 300;

/// Builds the relying party.
///
/// `WebauthnBuilder::new` rejects an origin whose effective domain is not the
/// RP ID, which is the check that stops a misconfigured deployment accepting
/// assertions minted for another site.
///
/// The RP ID is baked into every credential permanently. Changing it does not
/// lock anyone out of their account, because the password wrapper survives, but
/// it turns every enrolled passkey into dead weight with no migration path.
pub fn build(rp_id: &str, rp_origin: &str) -> anyhow::Result<Arc<Webauthn>> {
    let origin = Url::parse(rp_origin)?;
    let webauthn = WebauthnBuilder::new(rp_id, &origin)?
        .rp_name("krypta")
        .build()?;
    Ok(Arc::new(webauthn))
}

/// The Redis key a ceremony handle maps to. Only the hash of the handle is
/// used as the key, never the handle itself, and `prefix` keeps the
/// registration and login ceremonies in disjoint keyspaces.
fn ceremony_key(prefix: &str, token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("passkey_{prefix}:{:x}", hasher.finalize())
}

/// Stores ceremony state and returns the handle that redeems it.
///
/// Only the hash of the handle is a Redis key, so a dump of Redis yields no
/// usable token, the same property `session::token_key` gives sessions.
pub async fn stash<T: Serialize>(
    redis: &mut ConnectionManager,
    prefix: &str,
    state: &T,
) -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);
    let value = serde_json::to_string(state)?;
    let _: () = redis
        .set_ex(ceremony_key(prefix, &token), value, CEREMONY_TTL_SECS)
        .await?;
    Ok(token)
}

/// Redeems ceremony state, consuming it.
///
/// Deletes before returning, so a replayed handle cannot re-run a ceremony
/// against the same challenge. This is what `danger-allow-state-serialisation`
/// asks the caller to guarantee in exchange for letting the state leave process
/// memory.
///
/// The `prefix` is part of the key, so a registration handle cannot be redeemed
/// as a login and the two ceremonies stay disjoint.
pub async fn take<T: DeserializeOwned>(
    redis: &mut ConnectionManager,
    prefix: &str,
    token: &str,
) -> anyhow::Result<Option<T>> {
    let key = ceremony_key(prefix, token);
    let value: Option<String> = redis.get_del(&key).await?;
    let Some(value) = value else { return Ok(None) };
    Ok(Some(serde_json::from_str(&value)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_redis() -> redis::aio::ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        redis::aio::ConnectionManager::new(client).await.unwrap()
    }

    #[tokio::test]
    async fn a_stashed_ceremony_is_returned_once_and_then_gone() {
        let mut redis = test_redis().await;
        let token = stash(&mut redis, "test_reg", &"payload".to_string())
            .await
            .unwrap();

        let first: Option<String> = take(&mut redis, "test_reg", &token).await.unwrap();
        assert_eq!(first.as_deref(), Some("payload"));

        // The whole point: a replayed ceremony token buys nothing.
        let second: Option<String> = take(&mut redis, "test_reg", &token).await.unwrap();
        assert!(second.is_none(), "a ceremony token must be single use");
    }

    #[tokio::test]
    async fn a_ceremony_cannot_be_redeemed_under_a_different_prefix() {
        let mut redis = test_redis().await;
        let token = stash(&mut redis, "test_reg", &"payload".to_string())
            .await
            .unwrap();

        // A registration handle must not satisfy a login, or the two ceremonies
        // become interchangeable.
        let crossed: Option<String> = take(&mut redis, "test_login", &token).await.unwrap();
        assert!(crossed.is_none());
    }

    #[tokio::test]
    async fn an_unknown_token_is_none_rather_than_an_error() {
        let mut redis = test_redis().await;
        let missing: Option<String> = take(&mut redis, "test_reg", "not-a-token").await.unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn the_relying_party_rejects_an_origin_that_does_not_match_the_rp_id() {
        assert!(build("example.com", "https://attacker.test").is_err());
        assert!(build("localhost", "http://localhost:3000").is_ok());
    }
}
