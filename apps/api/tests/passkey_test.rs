mod common;

use base64::Engine;
use reqwest::Client;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

const PASSWORD: &str = "correct horse battery staple";

async fn test_db() -> PgPool {
    dotenvy::dotenv().ok();
    PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap()
}

/// Mirrors `ceremony_key` in `src/passkey.rs` exactly: `passkey_{prefix}:` plus
/// the lowercase hex SHA-256 of the handle. Kept in sync deliberately rather
/// than exposed from the crate, so this test fails if the two ever drift.
fn ceremony_redis_key(prefix: &str, token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("passkey_{prefix}:{:x}", hasher.finalize())
}

async fn redis_connection() -> redis::aio::ConnectionManager {
    let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    let client = redis::Client::open(url).unwrap();
    redis::aio::ConnectionManager::new(client).await.unwrap()
}

#[tokio::test]
async fn registration_requires_a_session() {
    let base = common::base_url();
    let client = Client::new();

    let res = client
        .post(format!("{base}/api/v1/auth/passkeys/register/start"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn a_registration_ceremony_token_cannot_be_replayed() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("passkey-reg-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, PASSWORD).await;
    let receipt = common::reauthentication_receipt(&base, &client, PASSWORD).await;

    let start: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/passkeys/register/start"))
        .json(&json!({ "reauthentication_receipt": receipt }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = start["data"]["ceremony_token"]
        .as_str()
        .unwrap()
        .to_string();

    // The options are a real challenge, which proves the ceremony started.
    assert!(
        start["data"]["options"]["publicKey"]["challenge"].is_string(),
        "start must return a challenge for the browser"
    );

    // Finishing with a bogus credential must fail, and must still consume the
    // handle: otherwise an attacker retries against one challenge forever.
    // Correctly sized (a real 72-byte crypto_secretbox wrapper would decode
    // to this length) but otherwise garbage, so the shape validator lets it
    // through and the credential check is what actually fails. A wrapper
    // that flunks the shape check would be rejected before the ceremony
    // token is consumed, which would defeat this test.
    let bogus = json!({
        "ceremony_token": token,
        "credential": {"id": "x", "rawId": "eA", "type": "public-key",
                       "response": {"attestationObject": "eA", "clientDataJSON": "eA"}},
        "wrapped_account_key": "PtQzyVDvIgwqIpqk5Su01UuhS6vTXE2G4sofdI-dU_Lmbgt4_5N3aUJkUKXF8xEMDEKeSJjwPu2WcZF7CL3cobZOGljRFfv7",
        "nickname": "test"
    });

    // Prove the handle is actually live before it is spent. Without this, a
    // regression that moves the consume-before-verify order (or drops it
    // entirely) is invisible: both requests would still get a 401 either way,
    // since a bogus credential always fails verification on its own.
    let redis_key = ceremony_redis_key("register", &token);
    let mut redis = redis_connection().await;
    let exists_before: bool = redis::AsyncCommands::exists(&mut redis, &redis_key)
        .await
        .unwrap();
    assert!(
        exists_before,
        "the ceremony handle must exist in Redis before it is redeemed"
    );

    let first = client
        .post(format!("{base}/api/v1/auth/passkeys/register/finish"))
        .json(&bogus)
        .send()
        .await
        .unwrap();
    assert!(first.status().is_client_error());

    // The handle must be gone even though verification failed. This is the
    // property the test exists to catch: if `take` moved to after
    // `finish_passkey_registration`, the key would still be here.
    let exists_after: bool = redis::AsyncCommands::exists(&mut redis, &redis_key)
        .await
        .unwrap();
    assert!(
        !exists_after,
        "the ceremony handle must be consumed even when verification fails"
    );

    let second = client
        .post(format!("{base}/api/v1/auth/passkeys/register/finish"))
        .json(&bogus)
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = second.json().await.unwrap();
    assert_eq!(
        body["error"]["code"], "unauthorized",
        "a consumed ceremony token must not be redeemable a second time"
    );
}

/// A structurally invalid wrapper (the wrong size to ever be a real
/// `crypto_secretbox` wrapper) must be rejected as a 400 `bad_request`, not
/// waved through and only discovered at the next passkey login. The
/// ceremony token comes from a real `register/start` call: sending a bogus
/// wrapper alongside a bogus credential would fail either way and could not
/// tell the two rejections apart.
#[tokio::test]
async fn register_finish_rejects_a_structurally_invalid_wrapped_account_key() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("passkey-badwrap-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, PASSWORD).await;
    let receipt = common::reauthentication_receipt(&base, &client, PASSWORD).await;

    let start: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/passkeys/register/start"))
        .json(&json!({ "reauthentication_receipt": receipt }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = start["data"]["ceremony_token"]
        .as_str()
        .unwrap()
        .to_string();

    let res = client
        .post(format!("{base}/api/v1/auth/passkeys/register/finish"))
        .json(&json!({
            "ceremony_token": token,
            "credential": {"id": "x", "rawId": "eA", "type": "public-key",
                           "response": {"attestationObject": "eA", "clientDataJSON": "eA"}},
            "wrapped_account_key": "dG9vLXNob3J0",
            "nickname": "test"
        }))
        .send()
        .await
        .unwrap();

    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "bad_request");

    // The ceremony must still be alive: validation happens before the
    // handle is consumed, so a request that could never succeed does not
    // burn it.
    let redis_key = ceremony_redis_key("register", &token);
    let mut redis = redis_connection().await;
    let exists: bool = redis::AsyncCommands::exists(&mut redis, &redis_key)
        .await
        .unwrap();
    assert!(
        exists,
        "a request rejected before verification must not consume the ceremony token"
    );
}

#[tokio::test]
async fn login_start_issues_a_challenge_without_naming_an_account() {
    let base = common::base_url();
    let client = Client::new();

    let body: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/passkeys/login/start"))
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(body["success"], true);
    assert!(body["data"]["ceremony_token"].is_string());
    // Anchor the path first: without this, a change to the response envelope
    // or to the crate's serde shape would make the allow-list assertion below
    // pass vacuously (its `as_array()` also returns `None` when the path
    // fails to resolve at all).
    assert!(
        body["data"]["options"]["publicKey"]["challenge"].is_string(),
        "start must return a challenge for the browser"
    );
    // No email is accepted and none is echoed: this endpoint is issued for
    // nobody in particular, which is what keeps it from being an
    // account-enumeration oracle.
    assert!(
        body["data"]["options"]["publicKey"]["allowCredentials"]
            .as_array()
            .is_none_or(|list| list.is_empty()),
        "a discoverable challenge must not carry an allow-list"
    );
}

/// A malformed user handle fails `identify_discoverable_authentication`
/// itself (`InvalidUserUniqueId`), before the handler ever queries the
/// database. This only proves that branch is generic; it says nothing about
/// the database-miss path below.
#[tokio::test]
async fn a_malformed_user_handle_is_rejected_before_any_database_lookup() {
    let base = common::base_url();
    let client = Client::new();

    let start: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/passkeys/login/start"))
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let res = client
        .post(format!("{base}/api/v1/auth/passkeys/login/finish"))
        .json(&json!({
            "ceremony_token": start["data"]["ceremony_token"],
            "credential": {"id": "x", "rawId": "eA", "type": "public-key",
                           "response": {"authenticatorData": "eA", "clientDataJSON": "eA",
                                        "signature": "eA", "userHandle": null}}
        }))
        .send()
        .await
        .unwrap();

    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(status, 401);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(
        body["error"]["message"], "Unauthorized",
        "the message must not say which check failed"
    );
}

/// A well-formed user handle naming a real, non-suspended account, paired
/// with a credential id that account never enrolled, must fail exactly like
/// a bad signature would: same status, code, and message. This is the
/// database-miss `.ok_or(ApiError::Unauthorized)` in `login_finish`, and it
/// is also what proves the `suspended_at IS NULL AND deletion_started_at IS
/// NULL` guards in that same query cannot be told apart from an unenrolled
/// credential by anyone probing the endpoint.
#[tokio::test]
async fn an_unenrolled_credential_for_a_real_account_is_indistinguishable_from_a_bad_signature() {
    let base = common::base_url();
    let db = test_db().await;
    let register_client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("passkey-login-miss-{}@example.com", uuid::Uuid::now_v7());
    let account = common::register_test_account(&base, &register_client, &email, PASSWORD).await;

    let stored: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
        .bind(account.user_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(stored, account.user_id, "the account must actually exist");

    let user_handle =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(account.user_id.as_bytes());

    let client = Client::new();
    let start: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/passkeys/login/start"))
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let res = client
        .post(format!("{base}/api/v1/auth/passkeys/login/finish"))
        .json(&json!({
            "ceremony_token": start["data"]["ceremony_token"],
            "credential": {"id": "never-enrolled", "rawId": "bmV2ZXItZW5yb2xsZWQ", "type": "public-key",
                           "response": {"authenticatorData": "eA", "clientDataJSON": "eA",
                                        "signature": "eA", "userHandle": user_handle}}
        }))
        .send()
        .await
        .unwrap();

    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(status, 401);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(
        body["error"]["message"], "Unauthorized",
        "the message must not say which check failed, even for a real account"
    );
}

#[tokio::test]
async fn listing_passkeys_is_empty_for_a_new_account() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("passkey-list-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, PASSWORD).await;

    let body: serde_json::Value = client
        .get(format!("{base}/api/v1/auth/passkeys"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(body["data"]["passkeys"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn deleting_a_passkey_removes_its_wrapper_too() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("passkey-del-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, PASSWORD).await;

    let db = test_db().await;
    let user_id: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_one(&db)
        .await
        .unwrap();

    // Insert the pair directly: a real ceremony needs an authenticator, and
    // what this test is about is the cascade, not the signature check.
    let credential_row_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO passkey_credentials (id, user_id, credential_id, credential, nickname)
         VALUES ($1, $2, $3, '{}'::jsonb, 'cascade probe')",
    )
    .bind(credential_row_id)
    .bind(user_id)
    .bind(format!("cred-{credential_row_id}"))
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO account_key_wrappers (id, user_id, method, wrapped_account_key, credential_id)
         VALUES ($1, $2, 'passkey', 'wrapped', $3)",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(user_id)
    .bind(credential_row_id)
    .execute(&db)
    .await
    .unwrap();

    let listed: serde_json::Value = client
        .get(format!("{base}/api/v1/auth/passkeys"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["data"]["passkeys"].as_array().unwrap().len(), 1);

    let deleted = client
        .delete(format!("{base}/api/v1/auth/passkeys/{credential_row_id}"))
        .send()
        .await
        .unwrap();
    assert!(deleted.status().is_success());

    let orphans: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_key_wrappers WHERE credential_id = $1")
            .bind(credential_row_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(orphans, 0, "deleting a credential must cascade its wrapper");

    // The password wrapper is structural and must survive, or the user has
    // deleted their way out of their own vault.
    let password_wrappers: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_key_wrappers WHERE user_id = $1 AND method = 'password'",
    )
    .bind(user_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(password_wrappers, 1);
}

#[tokio::test]
async fn one_account_cannot_delete_another_accounts_passkey() {
    let base = common::base_url();
    let owner = Client::builder().cookie_store(true).build().unwrap();
    let owner_email = format!("passkey-own-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &owner, &owner_email, PASSWORD).await;

    let db = test_db().await;
    let owner_id: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&owner_email)
        .fetch_one(&db)
        .await
        .unwrap();
    let credential_row_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO passkey_credentials (id, user_id, credential_id, credential)
         VALUES ($1, $2, $3, '{}'::jsonb)",
    )
    .bind(credential_row_id)
    .bind(owner_id)
    .bind(format!("cred-{credential_row_id}"))
    .execute(&db)
    .await
    .unwrap();

    let attacker = Client::builder().cookie_store(true).build().unwrap();
    let attacker_email = format!("passkey-atk-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &attacker, &attacker_email, PASSWORD).await;

    let res = attacker
        .delete(format!("{base}/api/v1/auth/passkeys/{credential_row_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    let still_there: i64 =
        sqlx::query_scalar("SELECT count(*) FROM passkey_credentials WHERE id = $1")
            .bind(credential_row_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(still_there, 1);
}

/// A session alone cannot add a passkey: a passkey is a standing way into the
/// account and the vault, so beginning one takes a fresh password proof.
#[tokio::test]
async fn registration_requires_a_fresh_password_proof() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("passkey-reauth-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, PASSWORD).await;

    let res = client
        .post(format!("{base}/api/v1/auth/passkeys/register/start"))
        .json(&json!({ "reauthentication_receipt": "not-a-receipt" }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), 401);
}
