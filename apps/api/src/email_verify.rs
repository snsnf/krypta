use rand::{Rng, RngCore};
use redis::{AsyncCommands, aio::ConnectionManager};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

const RESEND_RESERVATION_SECONDS: i64 = 300;

const VERIFY_CODE_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
    return cjson.encode({ status = 'rejected' })
end

local record = cjson.decode(raw)
if record.verified_user_id ~= nil then
    if not record.decoy and record.code_hash == ARGV[1] then
        return cjson.encode({ status = 'authorized', record = record })
    end
    return cjson.encode({ status = 'rejected' })
end

if record.decoy or record.code_hash ~= ARGV[1] then
    record.attempts = (record.attempts or 0) + 1
    if record.attempts >= tonumber(ARGV[2]) then
        redis.call('DEL', KEYS[1])
    else
        redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
    end
    return cjson.encode({ status = 'rejected' })
end

record.verified_user_id = ARGV[3]
record.resend_reservation = nil
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return cjson.encode({ status = 'authorized', record = record })
"#;

const BEGIN_RESEND_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
    return cjson.encode({ status = 'missing' })
end

local record = cjson.decode(raw)
if record.verified_user_id ~= nil then
    return cjson.encode({ status = 'missing' })
end

local now = tonumber(ARGV[3])
if record.resend_reservation ~= nil then
    if tonumber(record.resend_reservation.reserved_until) > now then
        return cjson.encode({ status = 'unavailable' })
    end
    record.code_hash = record.resend_reservation.previous_code_hash
    record.resends = record.resend_reservation.previous_resends
    record.last_sent_at = record.resend_reservation.previous_last_sent_at
    record.last_sent_at_unix = record.resend_reservation.previous_last_sent_at_unix
    record.resend_reservation = nil
end

if record.code_hash == ARGV[1] then
    return cjson.encode({ status = 'retry_with_different_code' })
end
if now - tonumber(record.last_sent_at_unix or 0) < tonumber(ARGV[4]) then
    return cjson.encode({ status = 'unavailable' })
end
if tonumber(record.resends or 0) >= tonumber(ARGV[5]) then
    return cjson.encode({ status = 'unavailable' })
end

record.resend_reservation = {
    id = ARGV[2],
    previous_code_hash = record.code_hash,
    previous_resends = record.resends or 0,
    previous_last_sent_at = record.last_sent_at,
    previous_last_sent_at_unix = record.last_sent_at_unix,
    reserved_until = now + tonumber(ARGV[6])
}
record.code_hash = ARGV[1]
record.resends = (record.resends or 0) + 1
record.last_sent_at = cjson.decode(ARGV[7])
record.last_sent_at_unix = now
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return cjson.encode({ status = 'reserved', record = record })
"#;

const COMMIT_RESEND_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.resend_reservation == nil or record.resend_reservation.id ~= ARGV[1] then
    return 0
end
record.resend_reservation = nil
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
"#;

const ROLLBACK_RESEND_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.verified_user_id ~= nil or record.resend_reservation == nil or record.resend_reservation.id ~= ARGV[1] then
    return 0
end
record.code_hash = record.resend_reservation.previous_code_hash
record.resends = record.resend_reservation.previous_resends
record.last_sent_at = record.resend_reservation.previous_last_sent_at
record.last_sent_at_unix = record.resend_reservation.previous_last_sent_at_unix
record.resend_reservation = nil
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
"#;

// Shared pending-signup records and helpers used by the registration,
// verification, and resend routes.

/// A signup that has been paid for with a verifier hash but not yet proved to
/// own its address.
///
/// It lives in Redis and never in Postgres, so an abandoned or bot-driven
/// signup leaves nothing behind and cannot occupy the UNIQUE(email)
/// constraint. The cost is that an Argon2 hash sits in Redis for the TTL; see
/// the spec's accepted-cost note.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingSignup {
    pub email: String,
    pub verifier_hash: String,
    /// SHA-256 of the six-digit code, hex encoded. The code itself is only
    /// ever in the mail.
    pub code_hash: String,
    pub attempts: u32,
    pub resends: u32,
    /// True when the address already has an account. Such a record can never
    /// be redeemed; it exists so the duplicate case is indistinguishable.
    pub decoy: bool,
    /// Set exactly once by the atomic successful-code transition. Keeping the
    /// receipt under the original TTL makes cross-store failures retryable;
    /// the same token and code are still required on every retry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) verified_user_id: Option<Uuid>,
    /// A short-lived SMTP reservation. Its previous values make an explicit
    /// mail failure rollback-safe, while the new code is already durable if
    /// SMTP succeeds and the commit acknowledgement is lost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resend_reservation: Option<ResendReservation>,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_sent_at: OffsetDateTime,
    #[serde(default)]
    pub(crate) last_sent_at_unix: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct ResendReservation {
    id: String,
    previous_code_hash: String,
    previous_resends: u32,
    previous_last_sent_at: String,
    previous_last_sent_at_unix: i64,
    reserved_until: i64,
}

pub enum VerifyCodeResult {
    Authorized {
        record: Box<PendingSignup>,
        user_id: Uuid,
    },
    Rejected,
}

pub enum BeginResendResult {
    Reserved(Box<PendingSignup>),
    RetryWithDifferentCode,
    Missing,
    Unavailable,
}

#[derive(Deserialize)]
struct TransitionReply {
    status: String,
    record: Option<PendingSignup>,
}

#[derive(Serialize)]
struct Rfc3339Timestamp(#[serde(with = "time::serde::rfc3339")] OffsetDateTime);

fn pending_key(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("pending_signup:{:x}", hasher.finalize())
}

/// Seconds of life left, or `None` if the record has already expired.
fn remaining_secs(record: &PendingSignup) -> Option<u64> {
    let secs = (record.expires_at - OffsetDateTime::now_utc()).whole_seconds();
    if secs <= 0 { None } else { Some(secs as u64) }
}

pub fn generate_code() -> String {
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32))
}

pub fn hash_code(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Atomically spends a wrong guess or turns a correct one into a retryable
/// receipt. Lua keeps every competing request in one Redis serialization
/// point, so attempt increments cannot be lost.
pub async fn verify_code(
    redis: &mut ConnectionManager,
    token: &str,
    code: &str,
    max_attempts: u32,
    proposed_user_id: Uuid,
) -> anyhow::Result<VerifyCodeResult> {
    let reply: String = redis::Script::new(VERIFY_CODE_SCRIPT)
        .key(pending_key(token))
        .arg(hash_code(code.trim()))
        .arg(max_attempts)
        .arg(proposed_user_id.to_string())
        .invoke_async(redis)
        .await?;
    let reply: TransitionReply = serde_json::from_str(&reply)?;
    match reply.status.as_str() {
        "authorized" => {
            let record = reply
                .record
                .ok_or_else(|| anyhow::anyhow!("authorized transition omitted record"))?;
            let user_id = record
                .verified_user_id
                .ok_or_else(|| anyhow::anyhow!("authorized transition omitted user id"))?;
            Ok(VerifyCodeResult::Authorized {
                record: Box::new(record),
                user_id,
            })
        }
        "rejected" => Ok(VerifyCodeResult::Rejected),
        _ => Err(anyhow::anyhow!("unknown verification transition status")),
    }
}

/// Atomically reserves one resend before SMTP starts.
///
/// The new hash is installed in the reservation itself. A successful SMTP
/// delivery therefore cannot be followed by an invalid-code window merely
/// because the final Redis acknowledgement was lost. Explicit SMTP failures
/// roll back by the unguessable reservation id.
/// The three strings that identify one resend attempt.
///
/// They were three adjacent `&str` parameters, which is the one shape a call
/// site can get wrong without the compiler noticing: swap the token and the
/// code and it still builds, and the failure surfaces later as a code nobody
/// can redeem. Naming them at the call site removes that.
pub struct ResendAttempt<'a> {
    pub token: &'a str,
    pub code: &'a str,
    pub reservation_id: &'a str,
}

pub async fn begin_resend(
    redis: &mut ConnectionManager,
    attempt: ResendAttempt<'_>,
    now: OffsetDateTime,
    cooldown_seconds: i64,
    max_resends: u32,
) -> anyhow::Result<BeginResendResult> {
    let ResendAttempt {
        token,
        code,
        reservation_id,
    } = attempt;
    let now_rfc3339 = serde_json::to_string(&Rfc3339Timestamp(now))?;
    let reply: String = redis::Script::new(BEGIN_RESEND_SCRIPT)
        .key(pending_key(token))
        .arg(hash_code(code))
        .arg(reservation_id)
        .arg(now.unix_timestamp())
        .arg(cooldown_seconds)
        .arg(max_resends)
        .arg(RESEND_RESERVATION_SECONDS)
        .arg(now_rfc3339)
        .invoke_async(redis)
        .await?;
    let reply: TransitionReply = serde_json::from_str(&reply)?;
    match reply.status.as_str() {
        "reserved" => Ok(BeginResendResult::Reserved(Box::new(
            reply
                .record
                .ok_or_else(|| anyhow::anyhow!("resend reservation omitted record"))?,
        ))),
        "retry_with_different_code" => Ok(BeginResendResult::RetryWithDifferentCode),
        "missing" => Ok(BeginResendResult::Missing),
        "unavailable" => Ok(BeginResendResult::Unavailable),
        _ => Err(anyhow::anyhow!("unknown resend transition status")),
    }
}

pub async fn commit_resend(
    redis: &mut ConnectionManager,
    token: &str,
    reservation_id: &str,
) -> anyhow::Result<()> {
    let _: i64 = redis::Script::new(COMMIT_RESEND_SCRIPT)
        .key(pending_key(token))
        .arg(reservation_id)
        .invoke_async(redis)
        .await?;
    Ok(())
}

pub async fn rollback_resend(
    redis: &mut ConnectionManager,
    token: &str,
    reservation_id: &str,
) -> anyhow::Result<()> {
    let _: i64 = redis::Script::new(ROLLBACK_RESEND_SCRIPT)
        .key(pending_key(token))
        .arg(reservation_id)
        .invoke_async(redis)
        .await?;
    Ok(())
}

/// Stores the record and returns the handle the client presents later.
pub async fn create_pending(
    redis: &mut ConnectionManager,
    record: &PendingSignup,
) -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);
    save_pending(redis, &token, record).await?;
    Ok(token)
}

/// Writes the record back under the lifetime it already had.
///
/// The TTL comes from `expires_at` rather than a fixed constant, which is what
/// stops a resend or a failed attempt from extending the window.
pub async fn save_pending(
    redis: &mut ConnectionManager,
    token: &str,
    record: &PendingSignup,
) -> anyhow::Result<()> {
    let Some(ttl) = remaining_secs(record) else {
        return Ok(());
    };
    let value = serde_json::to_string(record)?;
    let _: () = redis.set_ex(pending_key(token), value, ttl).await?;
    Ok(())
}

#[cfg(test)]
async fn load_pending(
    redis: &mut ConnectionManager,
    token: &str,
) -> anyhow::Result<Option<PendingSignup>> {
    let value: Option<String> = redis.get(pending_key(token)).await?;
    let Some(value) = value else { return Ok(None) };
    let record: PendingSignup = serde_json::from_str(&value)?;
    if remaining_secs(&record).is_none() {
        return Ok(None);
    }
    Ok(Some(record))
}

pub async fn delete_pending(redis: &mut ConnectionManager, token: &str) -> anyhow::Result<()> {
    let _: () = redis.del(pending_key(token)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::aio::ConnectionManager;
    use std::sync::Arc;
    use time::Duration;
    use tokio::sync::Barrier;
    use uuid::Uuid;

    async fn test_redis() -> ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        ConnectionManager::new(client).await.unwrap()
    }

    fn sample() -> PendingSignup {
        let now = OffsetDateTime::now_utc();
        PendingSignup {
            email: "someone@example.com".to_string(),
            verifier_hash: "$argon2id$fake".to_string(),
            code_hash: hash_code("123456"),
            attempts: 0,
            resends: 0,
            decoy: false,
            verified_user_id: None,
            resend_reservation: None,
            expires_at: now + Duration::seconds(900),
            last_sent_at: now,
            last_sent_at_unix: now.unix_timestamp(),
        }
    }

    #[test]
    fn generated_codes_are_six_digits() {
        for _ in 0..50 {
            let code = generate_code();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn hashing_is_stable_and_hides_the_code() {
        assert_eq!(hash_code("123456"), hash_code("123456"));
        assert_ne!(hash_code("123456"), hash_code("123457"));
        assert!(!hash_code("123456").contains("123456"));
    }

    #[tokio::test]
    async fn create_then_load_round_trips_the_record() {
        let mut redis = test_redis().await;
        let record = sample();
        let token = create_pending(&mut redis, &record).await.unwrap();

        let loaded = load_pending(&mut redis, &token).await.unwrap().unwrap();
        assert_eq!(loaded.email, record.email);
        assert_eq!(loaded.code_hash, record.code_hash);
        assert_eq!(loaded.attempts, 0);
        assert!(!loaded.decoy);

        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn deleted_records_are_gone() {
        let mut redis = test_redis().await;
        let token = create_pending(&mut redis, &sample()).await.unwrap();
        delete_pending(&mut redis, &token).await.unwrap();
        assert!(load_pending(&mut redis, &token).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unknown_tokens_load_as_none() {
        let mut redis = test_redis().await;
        assert!(
            load_pending(&mut redis, "not-a-real-token")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn saving_does_not_extend_the_original_expiry() {
        let mut redis = test_redis().await;
        let mut record = sample();
        // A record already half-way through its life.
        record.expires_at = OffsetDateTime::now_utc() + Duration::seconds(100);
        let token = create_pending(&mut redis, &record).await.unwrap();

        record.attempts = 1;
        save_pending(&mut redis, &token, &record).await.unwrap();

        let key_ttl = key_ttl_secs(&mut redis, &token).await;
        assert!(
            key_ttl <= 100,
            "ttl was {key_ttl}, must not have been extended"
        );

        delete_pending(&mut redis, &token).await.unwrap();
    }

    /// Reads the raw TTL Redis holds for a token, so the test can assert on
    /// the lifetime rather than trusting the struct field.
    async fn key_ttl_secs(redis: &mut ConnectionManager, token: &str) -> i64 {
        use redis::AsyncCommands;
        redis.ttl(pending_key(token)).await.unwrap()
    }

    #[tokio::test]
    async fn an_expired_record_is_not_stored_at_all() {
        let mut redis = test_redis().await;
        let mut record = sample();
        record.expires_at = OffsetDateTime::now_utc() - Duration::seconds(1);
        let token = create_pending(&mut redis, &record).await.unwrap();
        assert!(load_pending(&mut redis, &token).await.unwrap().is_none());
    }

    fn guaranteed_wrong_code(real_code: &str) -> &'static str {
        if real_code == "000000" {
            "000001"
        } else {
            "000000"
        }
    }

    #[tokio::test]
    async fn five_concurrent_wrong_codes_atomically_exhaust_the_handle() {
        let mut redis = test_redis().await;
        let real_code = "123456";
        let token = create_pending(&mut redis, &sample()).await.unwrap();
        let barrier = Arc::new(Barrier::new(6));
        let mut tasks = Vec::new();

        for _ in 0..5 {
            let mut connection = redis.clone();
            let token = token.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                verify_code(
                    &mut connection,
                    &token,
                    guaranteed_wrong_code(real_code),
                    5,
                    Uuid::now_v7(),
                )
                .await
                .unwrap()
            }));
        }

        barrier.wait().await;
        for task in tasks {
            assert!(matches!(task.await.unwrap(), VerifyCodeResult::Rejected));
        }

        assert!(matches!(
            verify_code(&mut redis, &token, real_code, 5, Uuid::now_v7())
                .await
                .unwrap(),
            VerifyCodeResult::Rejected
        ));
    }

    #[tokio::test]
    async fn a_verified_receipt_requires_the_same_token_and_code_on_retry() {
        let mut redis = test_redis().await;
        let user_id = Uuid::now_v7();
        let token = create_pending(&mut redis, &sample()).await.unwrap();

        let first = verify_code(&mut redis, &token, "123456", 5, user_id)
            .await
            .unwrap();
        assert!(matches!(
            first,
            VerifyCodeResult::Authorized {
                user_id: returned,
                ..
            } if returned == user_id
        ));

        let retry = verify_code(&mut redis, &token, "123456", 5, Uuid::now_v7())
            .await
            .unwrap();
        assert!(matches!(
            retry,
            VerifyCodeResult::Authorized {
                user_id: returned,
                ..
            } if returned == user_id
        ));
        assert!(matches!(
            verify_code(&mut redis, &token, "654321", 5, Uuid::now_v7())
                .await
                .unwrap(),
            VerifyCodeResult::Rejected
        ));
        assert!(matches!(
            verify_code(&mut redis, "different-token", "123456", 5, Uuid::now_v7(),)
                .await
                .unwrap(),
            VerifyCodeResult::Rejected
        ));

        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_resends_make_exactly_one_smtp_reservation() {
        let mut redis = test_redis().await;
        let mut record = sample();
        let now = OffsetDateTime::now_utc();
        record.last_sent_at = now - Duration::seconds(61);
        record.last_sent_at_unix = record.last_sent_at.unix_timestamp();
        let token = create_pending(&mut redis, &record).await.unwrap();
        let barrier = Arc::new(Barrier::new(9));
        let mut tasks = Vec::new();

        for n in 0..8 {
            let mut connection = redis.clone();
            let token = token.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                let reservation_id = Uuid::now_v7().to_string();
                barrier.wait().await;
                let result = begin_resend(
                    &mut connection,
                    ResendAttempt {
                        token: &token,
                        code: &format!("{n:06}"),
                        reservation_id: &reservation_id,
                    },
                    now,
                    60,
                    3,
                )
                .await
                .unwrap();
                (reservation_id, result)
            }));
        }

        barrier.wait().await;
        let mut winner = None;
        for task in tasks {
            let (reservation_id, result) = task.await.unwrap();
            if matches!(result, BeginResendResult::Reserved(_)) {
                assert!(winner.replace(reservation_id).is_none());
            } else {
                assert!(matches!(result, BeginResendResult::Unavailable));
            }
        }
        let winner = winner.expect("exactly one request must reserve the SMTP send");
        commit_resend(&mut redis, &token, &winner).await.unwrap();

        let loaded = load_pending(&mut redis, &token).await.unwrap().unwrap();
        assert_eq!(loaded.resends, 1);
        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_requests_cannot_cross_the_three_resend_cap() {
        let mut redis = test_redis().await;
        let mut record = sample();
        let now = OffsetDateTime::now_utc();
        record.last_sent_at = now - Duration::seconds(61);
        record.last_sent_at_unix = record.last_sent_at.unix_timestamp();
        record.resends = 2;
        let token = create_pending(&mut redis, &record).await.unwrap();
        let barrier = Arc::new(Barrier::new(7));
        let mut tasks = Vec::new();

        for n in 0..6 {
            let mut connection = redis.clone();
            let token = token.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                let reservation_id = Uuid::now_v7().to_string();
                barrier.wait().await;
                let result = begin_resend(
                    &mut connection,
                    ResendAttempt {
                        token: &token,
                        code: &format!("9{n:05}"),
                        reservation_id: &reservation_id,
                    },
                    now,
                    60,
                    3,
                )
                .await
                .unwrap();
                (reservation_id, result)
            }));
        }

        barrier.wait().await;
        let mut winner = None;
        for task in tasks {
            let (reservation_id, result) = task.await.unwrap();
            if matches!(result, BeginResendResult::Reserved(_)) {
                assert!(winner.replace(reservation_id).is_none());
            } else {
                assert!(matches!(result, BeginResendResult::Unavailable));
            }
        }
        let winner = winner.expect("the third resend must have one winner");
        commit_resend(&mut redis, &token, &winner).await.unwrap();

        assert!(matches!(
            begin_resend(
                &mut redis,
                ResendAttempt {
                    token: &token,
                    code: "888888",
                    reservation_id: &Uuid::now_v7().to_string(),
                },
                now + Duration::seconds(61),
                60,
                3,
            )
            .await
            .unwrap(),
            BeginResendResult::Unavailable
        ));
        assert_eq!(
            load_pending(&mut redis, &token)
                .await
                .unwrap()
                .unwrap()
                .resends,
            3
        );
        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn rolling_back_a_failed_send_restores_the_old_code_and_attempt_count() {
        let mut redis = test_redis().await;
        let mut record = sample();
        let now = OffsetDateTime::now_utc();
        record.last_sent_at = now - Duration::seconds(61);
        record.last_sent_at_unix = record.last_sent_at.unix_timestamp();
        record.attempts = 2;
        let token = create_pending(&mut redis, &record).await.unwrap();
        let reservation_id = Uuid::now_v7().to_string();

        assert!(matches!(
            begin_resend(
                &mut redis,
                ResendAttempt {
                    token: &token,
                    code: "654321",
                    reservation_id: &reservation_id,
                },
                now,
                60,
                3,
            )
            .await
            .unwrap(),
            BeginResendResult::Reserved(_)
        ));
        rollback_resend(&mut redis, &token, &reservation_id)
            .await
            .unwrap();

        let loaded = load_pending(&mut redis, &token).await.unwrap().unwrap();
        assert_eq!(loaded.code_hash, hash_code("123456"));
        assert_eq!(loaded.resends, 0);
        assert_eq!(loaded.attempts, 2);
        assert!(matches!(
            verify_code(&mut redis, &token, "654321", 5, Uuid::now_v7())
                .await
                .unwrap(),
            VerifyCodeResult::Rejected
        ));
        assert!(matches!(
            verify_code(&mut redis, &token, "123456", 5, Uuid::now_v7())
                .await
                .unwrap(),
            VerifyCodeResult::Authorized { .. }
        ));
        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn resend_refuses_to_reissue_the_current_code() {
        let mut redis = test_redis().await;
        let mut record = sample();
        let now = OffsetDateTime::now_utc();
        record.last_sent_at = now - Duration::seconds(61);
        record.last_sent_at_unix = record.last_sent_at.unix_timestamp();
        let token = create_pending(&mut redis, &record).await.unwrap();

        assert!(matches!(
            begin_resend(
                &mut redis,
                ResendAttempt {
                    token: &token,
                    code: "123456",
                    reservation_id: &Uuid::now_v7().to_string(),
                },
                now,
                60,
                3,
            )
            .await
            .unwrap(),
            BeginResendResult::RetryWithDifferentCode
        ));
        let loaded = load_pending(&mut redis, &token).await.unwrap().unwrap();
        assert_eq!(loaded.resends, 0);
        assert_eq!(loaded.code_hash, hash_code("123456"));
        delete_pending(&mut redis, &token).await.unwrap();
    }

    #[tokio::test]
    async fn resend_transitions_preserve_the_original_redis_ttl() {
        let mut redis = test_redis().await;
        let mut record = sample();
        let now = OffsetDateTime::now_utc();
        record.expires_at = now + Duration::seconds(100);
        record.last_sent_at = now - Duration::seconds(61);
        record.last_sent_at_unix = record.last_sent_at.unix_timestamp();
        let token = create_pending(&mut redis, &record).await.unwrap();
        let before = key_ttl_secs(&mut redis, &token).await;
        let reservation_id = Uuid::now_v7().to_string();

        assert!(matches!(
            begin_resend(
                &mut redis,
                ResendAttempt {
                    token: &token,
                    code: "654321",
                    reservation_id: &reservation_id,
                },
                now,
                60,
                3,
            )
            .await
            .unwrap(),
            BeginResendResult::Reserved(_)
        ));
        commit_resend(&mut redis, &token, &reservation_id)
            .await
            .unwrap();

        let after = key_ttl_secs(&mut redis, &token).await;
        assert!(after <= before, "TTL grew from {before} to {after}");
        delete_pending(&mut redis, &token).await.unwrap();
    }
}
