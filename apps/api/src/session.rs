use rand::RngCore;
use redis::{AsyncCommands, aio::ConnectionManager};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const IDLE_TIMEOUT_SECS: i64 = 30 * 24 * 60 * 60;
const ABSOLUTE_TIMEOUT_SECS: i64 = 90 * 24 * 60 * 60;

/// Long enough to read a code off paper and choose a password, short enough
/// that an abandoned recovery does not leave a usable handle lying around.
///
/// Minted by `/auth/recover/verify` and used for the cookie's max-age as well
/// as the Redis TTL. That TTL is never renewed on read; see `get_session`.
pub const RECOVERY_SESSION_TTL_SECS: i64 = 15 * 60;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SessionScope {
    /// A normal session. Reaches every authenticated route.
    #[default]
    Full,
    /// Minted mid-recovery, before a new password exists. Reaches
    /// `/auth/recover/complete` and nothing else.
    Recovery,
}

/// Whether the login that minted a session actually presented a second factor.
///
/// This was a bare `bool` parameter, which read as nothing at the call site:
/// `create_session(redis, id, generation, crate::session::SecondFactor::Verified)` gives no hint that the last
/// argument is what `admin::guard` checks before granting instance-admin
/// access, so getting it backwards looked like a typo rather than a
/// privilege change. Same reasoning as `ResponseCount` in `forms::routes`:
/// where a mistake is an authorization bug, the type carries the meaning.
///
/// The stored `Session` keeps a plain `bool`, because that is the shape
/// already serialized into every live Redis entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecondFactor {
    Verified,
    NotVerified,
}

impl SecondFactor {
    fn verified(self) -> bool {
        matches!(self, SecondFactor::Verified)
    }
}

#[derive(Serialize, Deserialize)]
pub struct Session {
    pub user_id: Uuid,
    #[serde(default)]
    pub generation: i64,
    /// True when the login proved a second factor: a TOTP code, or a passkey
    /// assertion, which is possession plus user verification and needs no code
    /// on top. `admin/guard.rs` gates instance administration on this, so the
    /// name has to say what it means rather than name one of the two ways to
    /// earn it.
    ///
    /// The alias keeps sessions written before the rename deserializing. This
    /// is the same concern `scope` handled with `#[serde(default)]`, solved
    /// with an alias instead because the old name carries a value worth
    /// keeping rather than one worth defaulting.
    #[serde(default, alias = "totp_verified")]
    pub second_factor_verified: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub absolute_expires_at: OffsetDateTime,
    /// `#[serde(default)]` plus `SessionScope`'s `#[default] Full` means a
    /// session written before this field existed still deserializes as
    /// `Full`, so live dev sessions are not invalidated by this change.
    #[serde(default)]
    pub scope: SessionScope,
}

fn token_key(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("session:{:x}", hasher.finalize())
}

/// Index of a user's live session keys, so they can be revoked together.
///
/// Holds the hashed keys, never the tokens, so a dump of this set is no more
/// useful than a dump of the session entries themselves. Entries for sessions
/// that have since expired may linger until the index expires or a revoke-all
/// sweeps them; deleting a key that is already gone is a no-op, so a stale
/// member is harmless.
fn user_sessions_key(user_id: Uuid) -> String {
    format!("user_sessions:{user_id}")
}

pub async fn create_session(
    redis: &mut ConnectionManager,
    user_id: Uuid,
    generation: i64,
    second_factor: SecondFactor,
) -> anyhow::Result<String> {
    create_scoped_session(
        redis,
        user_id,
        generation,
        second_factor,
        SessionScope::Full,
        IDLE_TIMEOUT_SECS,
    )
    .await
}

pub async fn create_scoped_session(
    redis: &mut ConnectionManager,
    user_id: Uuid,
    generation: i64,
    second_factor: SecondFactor,
    scope: SessionScope,
    ttl_secs: i64,
) -> anyhow::Result<String> {
    // A Redis TTL longer than the absolute expiry would let a session outlive
    // the ceiling it's meant never to cross. Every current caller passes a
    // constant well under this, so a debug assertion catches a future caller
    // getting it wrong without adding a runtime branch to a path this hot.
    debug_assert!(
        ttl_secs <= ABSOLUTE_TIMEOUT_SECS,
        "ttl_secs ({ttl_secs}) must not exceed ABSOLUTE_TIMEOUT_SECS ({ABSOLUTE_TIMEOUT_SECS})"
    );
    // The lower bound is checked rather than asserted, because `as u64` on a
    // negative would wrap to a TTL of billions of years on the value that
    // decides how long a session lives. Every caller passes a positive
    // constant today, so this is unreachable; converting rather than casting
    // is what keeps it unreachable when one does not.
    let ttl_secs =
        u64::try_from(ttl_secs).map_err(|_| anyhow::anyhow!("session ttl must not be negative"))?;

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);

    let now = OffsetDateTime::now_utc();
    let session = Session {
        user_id,
        generation,
        second_factor_verified: second_factor.verified(),
        created_at: now,
        absolute_expires_at: now + Duration::seconds(ABSOLUTE_TIMEOUT_SECS),
        scope,
    };
    let value = serde_json::to_string(&session)?;
    let key = token_key(&token);
    let _: () = redis.set_ex(&key, value, ttl_secs).await?;

    let index = user_sessions_key(user_id);
    let _: () = redis.sadd(&index, &key).await?;
    // The index has to outlive the longest-lived session it points at.
    let _: () = redis.expire(&index, ABSOLUTE_TIMEOUT_SECS).await?;
    Ok(token)
}

pub async fn get_session(
    redis: &mut ConnectionManager,
    token: &str,
) -> anyhow::Result<Option<Session>> {
    let key = token_key(token);
    let value: Option<String> = redis.get(&key).await?;
    let Some(value) = value else { return Ok(None) };
    let session: Session = serde_json::from_str(&value)?;

    if OffsetDateTime::now_utc() > session.absolute_expires_at {
        let _: () = redis.del(&key).await?;
        let _: () = redis.srem(user_sessions_key(session.user_id), &key).await?;
        return Ok(None);
    }

    // Only a Full session gets its idle timeout renewed on access. A recovery
    // session's short TTL is deliberately fixed at mint time: refreshing it
    // here on every read (including a read that ends in rejection, e.g. a
    // recovery session probing an ordinary route) would let an abandoned
    // recovery attempt renew itself into a long-lived, unused handle.
    if session.scope == SessionScope::Full {
        let _: () = redis.expire(&key, IDLE_TIMEOUT_SECS).await?;
    }
    Ok(Some(session))
}

pub async fn delete_session(redis: &mut ConnectionManager, token: &str) -> anyhow::Result<()> {
    let key = token_key(token);
    // Read before deleting so the user's index can be kept in step.
    let value: Option<String> = redis.get(&key).await?;
    if let Some(value) = value
        && let Ok(session) = serde_json::from_str::<Session>(&value)
    {
        let _: () = redis.srem(user_sessions_key(session.user_id), &key).await?;
    }
    let _: () = redis.del(&key).await?;
    Ok(())
}

/// Revokes every session belonging to `user_id`, returning how many were live.
///
/// Used to sign out other devices after a credential change or a suspected
/// compromise; without it a leaked token stays valid until it expires, which is
/// up to the absolute timeout away.
pub async fn delete_all_sessions_for_user(
    redis: &mut ConnectionManager,
    user_id: Uuid,
) -> anyhow::Result<u32> {
    let index = user_sessions_key(user_id);
    let keys: Vec<String> = redis.smembers(&index).await?;

    let mut revoked = 0u32;
    for key in &keys {
        let deleted: i64 = redis.del(key).await?;
        revoked += deleted as u32;
    }
    let _: () = redis.del(&index).await?;
    Ok(revoked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::aio::ConnectionManager;

    async fn test_redis() -> ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        ConnectionManager::new(client).await.unwrap()
    }

    #[tokio::test]
    async fn create_then_get_returns_same_user() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let token = create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();

        let session = get_session(&mut redis, &token).await.unwrap();
        let session = session.unwrap();
        assert_eq!(session.user_id, user_id);
        assert_eq!(session.generation, 0);
        assert!(!session.second_factor_verified);
    }

    #[tokio::test]
    async fn session_round_trips_totp_verification_state() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let token = create_session(
            &mut redis,
            user_id,
            7,
            crate::session::SecondFactor::Verified,
        )
        .await
        .unwrap();

        let session = get_session(&mut redis, &token).await.unwrap().unwrap();
        assert_eq!(session.generation, 7);
        assert!(session.second_factor_verified);

        delete_session(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn revoking_all_invalidates_every_session_for_that_user() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let other_user = Uuid::now_v7();

        let a = create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        let b = create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        let untouched = create_session(
            &mut redis,
            other_user,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();

        let revoked = delete_all_sessions_for_user(&mut redis, user_id)
            .await
            .unwrap();

        assert_eq!(revoked, 2);
        assert!(get_session(&mut redis, &a).await.unwrap().is_none());
        assert!(get_session(&mut redis, &b).await.unwrap().is_none());
        // Another user's sessions must survive.
        assert!(get_session(&mut redis, &untouched).await.unwrap().is_some());

        delete_session(&mut redis, &untouched).await.unwrap();
    }

    #[tokio::test]
    async fn deleting_one_session_leaves_the_others_usable() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let a = create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        let b = create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();

        delete_session(&mut redis, &a).await.unwrap();

        assert!(get_session(&mut redis, &a).await.unwrap().is_none());
        assert!(get_session(&mut redis, &b).await.unwrap().is_some());

        // The index must have dropped the deleted one, so a later revoke-all
        // reports only what was really live.
        let revoked = delete_all_sessions_for_user(&mut redis, user_id)
            .await
            .unwrap();
        assert_eq!(revoked, 1);
    }

    #[tokio::test]
    async fn deleted_session_is_gone() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let token = create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        delete_session(&mut redis, &token).await.unwrap();

        let session = get_session(&mut redis, &token).await.unwrap();
        assert!(session.is_none());
    }

    /// A session persisted before this field existed has no `scope` key at
    /// all. `#[serde(default)]` on the field, combined with `SessionScope`'s
    /// own `#[default] Full`, must still deserialize it as `Full`, or
    /// every live session in a running deployment would be invalidated (or
    /// worse, silently reinterpreted) the moment this code ships.
    #[test]
    fn a_session_record_without_a_scope_field_deserializes_as_full() {
        let user_id = Uuid::now_v7();
        let now = OffsetDateTime::now_utc();
        let json = format!(
            r#"{{"user_id":"{user_id}","generation":0,"totp_verified":false,"created_at":"{}","absolute_expires_at":"{}"}}"#,
            now.format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            (now + Duration::seconds(60))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
        );

        let session: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(session.scope, SessionScope::Full);
    }

    /// A `Full` session's key TTL is pushed back toward the idle timeout on
    /// every successful read, so an active user is not logged out out from
    /// under them. This pins that behavior directly against the Redis TTL,
    /// rather than relying on end-to-end symptoms, so a future edit to the
    /// condition in `get_session` (inverted, dropped, or scoped wrong) fails
    /// a test instead of silently changing who gets logged out early.
    #[tokio::test]
    async fn a_full_session_ttl_is_renewed_on_read() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let token = create_session(
            &mut redis,
            user_id,
            0,
            crate::session::SecondFactor::NotVerified,
        )
        .await
        .unwrap();
        let key = token_key(&token);

        // Simulate a session that has sat idle for a while: force its TTL
        // down to a few seconds so a renewal on read is unambiguous. Without
        // this, `create_session` already sets the initial TTL to
        // `IDLE_TIMEOUT_SECS`, so the "before" and "after" values would look
        // the same whether or not `get_session` actually renews anything.
        let _: () = redis.expire(&key, 5).await.unwrap();
        let ttl_before: i64 = redis.ttl(&key).await.unwrap();
        assert!(
            ttl_before <= 5,
            "expected the forced-short TTL to still be short, got {ttl_before}"
        );

        get_session(&mut redis, &token).await.unwrap();

        let ttl_after: i64 = redis.ttl(&key).await.unwrap();
        assert!(
            ttl_after > IDLE_TIMEOUT_SECS - 5,
            "expected the TTL to be renewed back to ~{IDLE_TIMEOUT_SECS}, got {ttl_after}"
        );

        delete_session(&mut redis, &token).await.unwrap();
    }

    /// The mirror image of the test above: a `Recovery` session's TTL must
    /// stay exactly what it was minted with, even after a read. Renewing it
    /// would let an abandoned recovery attempt silently keep itself alive
    /// past `RECOVERY_SESSION_TTL_SECS`, defeating the reason that constant
    /// exists.
    #[tokio::test]
    async fn a_recovery_session_ttl_is_not_renewed_on_read() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let token = create_scoped_session(
            &mut redis,
            user_id,
            0,
            SecondFactor::NotVerified,
            SessionScope::Recovery,
            RECOVERY_SESSION_TTL_SECS,
        )
        .await
        .unwrap();
        let key = token_key(&token);

        let ttl_before: i64 = redis.ttl(&key).await.unwrap();

        get_session(&mut redis, &token).await.unwrap();

        let ttl_after: i64 = redis.ttl(&key).await.unwrap();
        // Allow a couple of seconds of clock/scheduling drift between the two
        // reads rather than demanding the TTL be frozen to the exact second.
        assert!(
            ttl_after <= ttl_before && ttl_before - ttl_after <= 2,
            "expected the recovery session's TTL to be left alone (not renewed), \
             got {ttl_before} before and {ttl_after} after"
        );
        assert!(
            ttl_after <= RECOVERY_SESSION_TTL_SECS,
            "expected the TTL to stay within the recovery window, got {ttl_after}"
        );

        delete_session(&mut redis, &token).await.unwrap();
    }

    /// A session written before the rename must keep deserializing, or every
    /// signed-in user is logged out by a deploy.
    #[tokio::test]
    async fn a_session_stored_under_the_old_field_name_still_loads() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let token = "legacy-name-token";
        let now = OffsetDateTime::now_utc();
        let value = format!(
            r#"{{"user_id":"{user_id}","generation":0,"totp_verified":true,"created_at":"{}","absolute_expires_at":"{}","scope":"full"}}"#,
            now.format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            (now + Duration::seconds(ABSOLUTE_TIMEOUT_SECS))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
        );
        let key = token_key(token);
        let _: () = redis.set_ex(&key, value, 60).await.unwrap();

        let session = get_session(&mut redis, token).await.unwrap().unwrap();
        assert!(
            session.second_factor_verified,
            "the serde alias must carry the old field's value across the rename"
        );

        let _: () = redis.del(&key).await.unwrap();
    }
}
