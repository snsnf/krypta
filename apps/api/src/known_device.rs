//! Browsers that have signed in to an account before.
//!
//! Login attempts are capped per address across every source, which lets
//! anyone who knows an address spend that budget and keep its owner off the
//! password form. A browser that completed a sign-in to the account carries a
//! marker that earns it a budget of its own instead, so a stranger's attempts
//! cannot lock the owner out of the browsers they actually use.
//!
//! The marker never authenticates anything: the password and any second factor
//! are still required. It only decides which counter an attempt is charged to,
//! so a stolen marker buys one more capped budget and nothing else.

use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use rand::RngCore;
use redis::{AsyncCommands, aio::ConnectionManager};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const COOKIE_NAME: &str = "__Host-known-device";

/// As long as a session can live, so a browser stays known while it could
/// still be signed in.
const LIFETIME_SECS: u64 = 90 * 24 * 60 * 60;

/// A marker presented with a request and recognised as belonging to an
/// account.
pub struct KnownDevice {
    marker_key: String,
    user_id: Uuid,
}

impl KnownDevice {
    pub fn belongs_to(&self, user_id: Uuid) -> bool {
        self.user_id == user_id
    }

    /// A recognised browser for `user_id` with a marker no one was issued.
    #[cfg(test)]
    pub fn for_tests(user_id: Uuid) -> Self {
        KnownDevice {
            marker_key: marker_key(&new_marker()),
            user_id,
        }
    }

    /// The rate-limit key for this browser's own login budget. Built from the
    /// hashed marker, so the cookie value never appears in a Redis key.
    pub fn login_budget_key(&self) -> String {
        format!("login_device:{}", self.marker_key)
    }
}

/// The marker presented with this request, if it is one the server issued and
/// has not since forgotten.
pub async fn recognise(
    redis: &mut ConnectionManager,
    jar: &CookieJar,
) -> anyhow::Result<Option<KnownDevice>> {
    let Some(cookie) = jar.get(COOKIE_NAME) else {
        return Ok(None);
    };
    let marker_key = marker_key(cookie.value());
    let user_id: Option<String> = redis.get(&marker_key).await?;
    Ok(user_id
        .and_then(|id| id.parse().ok())
        .map(|user_id| KnownDevice {
            marker_key,
            user_id,
        }))
}

/// Marks this browser as known to `user_id`, replacing any marker it held.
///
/// A browser holds one marker, so signing in to a second account moves it
/// there; the first account's attempts from this browser then share that
/// account's address budget again.
pub async fn remember(
    redis: &mut ConnectionManager,
    jar: CookieJar,
    user_id: Uuid,
) -> anyhow::Result<CookieJar> {
    if let Some(previous) = jar.get(COOKIE_NAME) {
        let _: () = redis.del(marker_key(previous.value())).await?;
    }

    let marker = new_marker();
    let key = marker_key(&marker);
    let _: () = redis
        .set_ex(&key, user_id.to_string(), LIFETIME_SECS)
        .await?;
    let index = user_markers_key(user_id);
    let _: () = redis.sadd(&index, &key).await?;
    let _: () = redis.expire(&index, LIFETIME_SECS as i64).await?;

    Ok(jar.add(marker_cookie(marker)))
}

/// Forgets every browser known to `user_id`, so none keeps a budget of its
/// own once the account's sessions have been revoked.
pub async fn forget_all(redis: &mut ConnectionManager, user_id: Uuid) -> anyhow::Result<()> {
    let index = user_markers_key(user_id);
    let keys: Vec<String> = redis.smembers(&index).await?;
    for key in &keys {
        let _: () = redis.del(key).await?;
    }
    let _: () = redis.del(&index).await?;
    Ok(())
}

fn new_marker() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

/// Only the hash is stored, so a dump of Redis yields no usable marker.
fn marker_key(marker: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(marker.as_bytes());
    format!("known_device:{:x}", hasher.finalize())
}

fn user_markers_key(user_id: Uuid) -> String {
    format!("user_known_devices:{user_id}")
}

fn marker_cookie(marker: String) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, marker))
        .path("/")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(LIFETIME_SECS as i64))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_redis() -> ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        ConnectionManager::new(client).await.unwrap()
    }

    /// The jar a browser would send back after receiving `issued`.
    fn returned_jar(issued: &CookieJar) -> CookieJar {
        let marker = issued.get(COOKIE_NAME).unwrap().value().to_string();
        CookieJar::new().add(Cookie::new(COOKIE_NAME, marker))
    }

    #[tokio::test]
    async fn a_remembered_browser_is_recognised_for_its_account_only() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();

        let issued = remember(&mut redis, CookieJar::new(), user_id)
            .await
            .unwrap();
        let device = recognise(&mut redis, &returned_jar(&issued))
            .await
            .unwrap()
            .expect("the marker just issued is recognised");

        assert!(device.belongs_to(user_id));
        assert!(!device.belongs_to(Uuid::now_v7()));
    }

    #[tokio::test]
    async fn a_marker_the_server_never_issued_is_not_recognised() {
        let mut redis = test_redis().await;
        let forged = CookieJar::new().add(Cookie::new(COOKIE_NAME, new_marker()));

        assert!(recognise(&mut redis, &forged).await.unwrap().is_none());
        assert!(
            recognise(&mut redis, &CookieJar::new())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn signing_in_again_replaces_the_previous_marker() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();

        let first = returned_jar(
            &remember(&mut redis, CookieJar::new(), user_id)
                .await
                .unwrap(),
        );
        remember(&mut redis, first.clone(), user_id).await.unwrap();

        assert!(recognise(&mut redis, &first).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn forgetting_an_account_forgets_every_browser_it_knew() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let laptop = returned_jar(
            &remember(&mut redis, CookieJar::new(), user_id)
                .await
                .unwrap(),
        );
        let phone = returned_jar(
            &remember(&mut redis, CookieJar::new(), user_id)
                .await
                .unwrap(),
        );

        forget_all(&mut redis, user_id).await.unwrap();

        assert!(recognise(&mut redis, &laptop).await.unwrap().is_none());
        assert!(recognise(&mut redis, &phone).await.unwrap().is_none());
    }

    #[test]
    fn the_budget_key_does_not_carry_the_marker_itself() {
        let marker = new_marker();
        let device = KnownDevice {
            marker_key: marker_key(&marker),
            user_id: Uuid::now_v7(),
        };
        assert!(!device.login_budget_key().contains(&marker));
    }
}
