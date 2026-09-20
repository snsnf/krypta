use rand::RngCore;
use redis::{AsyncCommands, aio::ConnectionManager};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::email_verify::hash_code;

const VERIFY_CODE_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
    return cjson.encode({ status = 'rejected' })
end

local record = cjson.decode(raw)
if record.decoy or record.code_hash ~= ARGV[1] then
    record.attempts = (record.attempts or 0) + 1
    if record.attempts >= tonumber(ARGV[2]) then
        redis.call('DEL', KEYS[1])
    else
        redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
    end
    return cjson.encode({ status = 'rejected' })
end

return cjson.encode({ status = 'authorized', record = record })
"#;

/// A recovery in progress: the address proved nothing yet, and no session
/// exists.
///
/// Like `PendingSignup` this lives in Redis and never in Postgres, so an
/// abandoned or bot-driven recovery leaves nothing behind. It holds no key
/// material at all (the account key, the recovery code, and every unlock key
/// stay in the browser); only the address, the user it resolved to, and the
/// hash of the six-digit code that was mailed.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingRecovery {
    pub email: String,
    /// `None` for a decoy. A decoy is never redeemable, so the absence of a
    /// user is not something a caller can distinguish from a wrong code.
    pub user_id: Option<Uuid>,
    /// SHA-256 of the six-digit code, hex encoded. The code itself is only
    /// ever in the mail.
    pub code_hash: String,
    pub attempts: u32,
    /// True when no account exists for the address. Such a record can never be
    /// redeemed; it exists so the unknown-address case is indistinguishable.
    pub decoy: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

pub enum VerifyCodeResult {
    Authorized(Box<PendingRecovery>),
    Rejected,
}

#[derive(Deserialize)]
struct TransitionReply {
    status: String,
    record: Option<PendingRecovery>,
}

fn pending_key(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("pending_recovery:{:x}", hasher.finalize())
}

/// Seconds of life left, or `None` if the record has already expired.
fn remaining_secs(record: &PendingRecovery) -> Option<u64> {
    let secs = (record.expires_at - OffsetDateTime::now_utc()).whole_seconds();
    if secs <= 0 { None } else { Some(secs as u64) }
}

/// Atomically spends a wrong guess, or reports the code as correct.
///
/// Attempts are capped rather than the handle being consumed on the first
/// failure, which is what `totp.rs` does. The two flows differ in what is
/// guessable. The only low-entropy secret here is the 6-digit email code, and
/// the cap below plus the per-IP limit on the route already protect it; the
/// recovery code is 160 bits and has nothing to guess. Spending the handle on a
/// single mistyped character would force a fresh email round trip on every
/// typo, in the one flow where the user is transcribing 32 characters off paper
/// with their vault on the line. That is a considered trade-off, not an
/// oversight.
///
/// A correct code deliberately leaves the record in place, under its original
/// TTL: the caller has more factors to check, and a mistyped recovery code must
/// not cost the emailed one. The caller deletes the record once every factor
/// has passed and a session has been minted.
///
/// Lua keeps competing requests in one Redis serialization point, so attempt
/// increments cannot be lost, and `KEEPTTL` is what stops a failed attempt from
/// extending the window.
pub async fn verify_code(
    redis: &mut ConnectionManager,
    token: &str,
    code: &str,
    max_attempts: u32,
) -> anyhow::Result<VerifyCodeResult> {
    let reply: String = redis::Script::new(VERIFY_CODE_SCRIPT)
        .key(pending_key(token))
        .arg(hash_code(code.trim()))
        .arg(max_attempts)
        .invoke_async(redis)
        .await?;
    let reply: TransitionReply = serde_json::from_str(&reply)?;
    match reply.status.as_str() {
        "authorized" => Ok(VerifyCodeResult::Authorized(Box::new(
            reply
                .record
                .ok_or_else(|| anyhow::anyhow!("authorized transition omitted record"))?,
        ))),
        "rejected" => Ok(VerifyCodeResult::Rejected),
        _ => Err(anyhow::anyhow!("unknown recovery transition status")),
    }
}

/// Stores the record and returns the handle the client presents later.
pub async fn create_pending(
    redis: &mut ConnectionManager,
    record: &PendingRecovery,
) -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);
    save_pending(redis, &token, record).await?;
    Ok(token)
}

/// Writes the record back under the lifetime it already had.
///
/// The TTL comes from `expires_at` rather than a fixed constant, so nothing a
/// client does can extend the window.
pub async fn save_pending(
    redis: &mut ConnectionManager,
    token: &str,
    record: &PendingRecovery,
) -> anyhow::Result<()> {
    let Some(ttl) = remaining_secs(record) else {
        return Ok(());
    };
    let value = serde_json::to_string(record)?;
    let _: () = redis.set_ex(pending_key(token), value, ttl).await?;
    Ok(())
}

pub async fn delete_pending(redis: &mut ConnectionManager, token: &str) -> anyhow::Result<()> {
    let _: () = redis.del(pending_key(token)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use time::Duration;
    use tokio::sync::Barrier;

    async fn test_redis() -> ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        ConnectionManager::new(client).await.unwrap()
    }

    fn sample() -> PendingRecovery {
        PendingRecovery {
            email: "someone@example.com".to_string(),
            user_id: Some(Uuid::now_v7()),
            code_hash: hash_code("123456"),
            attempts: 0,
            decoy: false,
            expires_at: OffsetDateTime::now_utc() + Duration::seconds(900),
        }
    }

    async fn key_ttl_secs(redis: &mut ConnectionManager, token: &str) -> i64 {
        redis.ttl(pending_key(token)).await.unwrap()
    }

    #[tokio::test]
    async fn a_correct_code_authorizes_and_leaves_the_handle_usable() {
        let mut redis = test_redis().await;
        let record = sample();
        let token = create_pending(&mut redis, &record).await.unwrap();

        for _ in 0..2 {
            match verify_code(&mut redis, &token, "123456", 5).await.unwrap() {
                VerifyCodeResult::Authorized(loaded) => {
                    assert_eq!(loaded.email, record.email);
                    assert_eq!(loaded.user_id, record.user_id);
                }
                VerifyCodeResult::Rejected => {
                    panic!("a correct code must not consume the handle")
                }
            }
        }

        delete_pending(&mut redis, &token).await.unwrap();
        assert!(matches!(
            verify_code(&mut redis, &token, "123456", 5).await.unwrap(),
            VerifyCodeResult::Rejected
        ));
    }

    /// A decoy exists only to make the unknown-address case indistinguishable.
    /// No code may redeem it, including the one whose hash it carries.
    #[tokio::test]
    async fn a_decoy_is_never_redeemable() {
        let mut redis = test_redis().await;
        let mut record = sample();
        record.decoy = true;
        record.user_id = None;
        let token = create_pending(&mut redis, &record).await.unwrap();

        assert!(matches!(
            verify_code(&mut redis, &token, "123456", 5).await.unwrap(),
            VerifyCodeResult::Rejected
        ));

        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn five_concurrent_wrong_codes_atomically_exhaust_the_handle() {
        let mut redis = test_redis().await;
        let token = create_pending(&mut redis, &sample()).await.unwrap();
        let barrier = Arc::new(Barrier::new(6));
        let mut tasks = Vec::new();

        for _ in 0..5 {
            let mut connection = redis.clone();
            let token = token.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                verify_code(&mut connection, &token, "000000", 5)
                    .await
                    .unwrap()
            }));
        }

        barrier.wait().await;
        for task in tasks {
            assert!(matches!(task.await.unwrap(), VerifyCodeResult::Rejected));
        }

        assert!(
            matches!(
                verify_code(&mut redis, &token, "123456", 5).await.unwrap(),
                VerifyCodeResult::Rejected
            ),
            "the handle must be gone once the cap is reached"
        );
    }

    #[tokio::test]
    async fn a_failed_attempt_does_not_extend_the_window() {
        let mut redis = test_redis().await;
        let mut record = sample();
        record.expires_at = OffsetDateTime::now_utc() + Duration::seconds(100);
        let token = create_pending(&mut redis, &record).await.unwrap();
        let before = key_ttl_secs(&mut redis, &token).await;

        assert!(matches!(
            verify_code(&mut redis, &token, "000000", 5).await.unwrap(),
            VerifyCodeResult::Rejected
        ));

        let after = key_ttl_secs(&mut redis, &token).await;
        assert!(after <= before, "TTL grew from {before} to {after}");
        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn an_expired_record_is_not_stored_at_all() {
        let mut redis = test_redis().await;
        let mut record = sample();
        record.expires_at = OffsetDateTime::now_utc() - Duration::seconds(1);
        let token = create_pending(&mut redis, &record).await.unwrap();

        assert!(matches!(
            verify_code(&mut redis, &token, "123456", 5).await.unwrap(),
            VerifyCodeResult::Rejected
        ));
    }

    #[tokio::test]
    async fn unknown_tokens_are_rejected() {
        let mut redis = test_redis().await;
        assert!(matches!(
            verify_code(&mut redis, "not-a-real-token", "123456", 5)
                .await
                .unwrap(),
            VerifyCodeResult::Rejected
        ));
    }
}
