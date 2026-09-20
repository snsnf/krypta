use redis::aio::ConnectionManager;

// INCR and EXPIRE in one script rather than two round trips. Split across two
// commands, a crash or dropped connection between them leaves a counter with
// no expiry, and once that counter passes the limit the key is refused
// forever: a permanent lockout of one address or account that nothing ever
// clears.
const INCREMENT_SCRIPT: &str = r#"
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
"#;

pub async fn check_rate_limit(
    redis: &mut ConnectionManager,
    key: &str,
    max_requests: u32,
    window_secs: u64,
) -> anyhow::Result<bool> {
    let redis_key = format!("ratelimit:{key}");
    let count: i64 = redis::Script::new(INCREMENT_SCRIPT)
        .key(&redis_key)
        .arg(window_secs)
        .invoke_async(redis)
        .await?;
    Ok(count <= i64::from(max_requests))
}

#[cfg(test)]
mod tests {
    use super::check_rate_limit;
    use redis::{AsyncCommands, aio::ConnectionManager};
    use uuid::Uuid;

    async fn test_redis() -> ConnectionManager {
        let client = redis::Client::open("redis://localhost:6379").unwrap();
        ConnectionManager::new(client).await.unwrap()
    }

    #[tokio::test]
    async fn allows_up_to_the_limit_then_blocks() {
        let mut redis = test_redis().await;
        let key = format!("test:{}", Uuid::now_v7());

        assert!(check_rate_limit(&mut redis, &key, 2, 60).await.unwrap());
        assert!(check_rate_limit(&mut redis, &key, 2, 60).await.unwrap());
        assert!(!check_rate_limit(&mut redis, &key, 2, 60).await.unwrap());
    }

    #[tokio::test]
    async fn the_counter_carries_its_expiry_from_the_first_increment() {
        let mut redis = test_redis().await;
        let key = format!("test:{}", Uuid::now_v7());

        check_rate_limit(&mut redis, &key, 5, 60).await.unwrap();

        let ttl: i64 = redis.ttl(format!("ratelimit:{key}")).await.unwrap();
        assert!(
            (1..=60).contains(&ttl),
            "a fresh counter must expire with its window, got ttl {ttl}"
        );
    }
}
