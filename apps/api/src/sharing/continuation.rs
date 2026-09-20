use base64::Engine;
use rand::RngCore;
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const CONTINUATION_TTL_SECONDS: u64 = 30 * 60;

#[derive(serde::Deserialize, serde::Serialize)]
struct ContinuationRecord {
    invitation_id: Uuid,
}

fn key(cookie: &str) -> String {
    format!(
        "invite_continuation:{:x}",
        Sha256::digest(cookie.as_bytes())
    )
}

pub async fn create(
    redis: &mut redis::aio::ConnectionManager,
    invitation_id: Uuid,
) -> anyhow::Result<String> {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let cookie = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let value = serde_json::to_string(&ContinuationRecord { invitation_id })?;
    let _: () = redis
        .set_ex(key(&cookie), value, CONTINUATION_TTL_SECONDS)
        .await?;
    Ok(cookie)
}

pub async fn load(
    redis: &mut redis::aio::ConnectionManager,
    cookie: &str,
) -> anyhow::Result<Option<Uuid>> {
    let value: Option<String> = redis.get(key(cookie)).await?;
    value
        .map(|value| serde_json::from_str::<ContinuationRecord>(&value))
        .transpose()
        .map(|record| record.map(|record| record.invitation_id))
        .map_err(Into::into)
}

pub async fn delete(redis: &mut redis::aio::ConnectionManager, cookie: &str) -> anyhow::Result<()> {
    let _: usize = redis.del(key(cookie)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_redis() -> redis::aio::ConnectionManager {
        dotenvy::dotenv().ok();
        let client = redis::Client::open(std::env::var("REDIS_URL").unwrap()).unwrap();
        redis::aio::ConnectionManager::new(client).await.unwrap()
    }

    #[tokio::test]
    async fn continuation_round_trip_stores_only_invitation_id_and_delete_consumes_it() {
        let mut redis = test_redis().await;
        let invitation_id = Uuid::now_v7();
        let cookie = create(&mut redis, invitation_id).await.unwrap();
        assert_eq!(cookie.len(), 43);

        let redis_key = format!(
            "invite_continuation:{:x}",
            Sha256::digest(cookie.as_bytes())
        );
        let stored: String = redis.get(&redis_key).await.unwrap();
        assert_eq!(
            stored,
            serde_json::json!({ "invitation_id": invitation_id }).to_string()
        );
        assert!(!stored.contains(&cookie));
        let ttl: i64 = redis.ttl(&redis_key).await.unwrap();
        assert!((1..=CONTINUATION_TTL_SECONDS as i64).contains(&ttl));
        assert_eq!(
            load(&mut redis, &cookie).await.unwrap(),
            Some(invitation_id)
        );

        delete(&mut redis, &cookie).await.unwrap();
        assert_eq!(load(&mut redis, &cookie).await.unwrap(), None);
    }
}
