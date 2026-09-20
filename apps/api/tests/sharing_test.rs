mod common;

use base64::Engine;
use reqwest::Client;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

// Hybrid ML-KEM-768 + X25519 sharing public keys are 1216 bytes, matching
// `SHARING_PUBLIC_KEY_BYTES` in `apps/api/src/sharing/routes.rs`.
const SHARING_PUBLIC_KEY_BYTES: usize = 1216;

fn sharing_public_key(fill: u8) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([fill; SHARING_PUBLIC_KEY_BYTES])
}

async fn test_db() -> sqlx::PgPool {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL").unwrap();
    sqlx::PgPool::connect(&database_url).await.unwrap()
}

#[tokio::test]
async fn every_live_form_has_exactly_one_owner_membership() {
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let invalid: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM (
           SELECT f.id FROM forms f
           LEFT JOIN form_members m ON m.form_id = f.id AND m.role = 'owner'
           GROUP BY f.id HAVING count(m.id) <> 1
         ) invalid_forms",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(invalid, 0);
}

#[tokio::test]
async fn legacy_form_ownership_columns_are_retired() {
    let db = test_db().await;
    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*)
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'forms'
           AND column_name IN (
             'owner_id', 'wrapped_form_private_key', 'wrapped_form_data_key'
           )",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
}

async fn wait_for_blocked_requests(db: &sqlx::PgPool, blocker_backend_pid: i32, expected: i64) {
    for _ in 0..80 {
        let blocked = sqlx::query_scalar!(
            "WITH RECURSIVE blocked(pid) AS (
               SELECT activity.pid
               FROM pg_stat_activity activity
               WHERE $1 = ANY(pg_blocking_pids(activity.pid))
               UNION
               SELECT activity.pid
               FROM pg_stat_activity activity
               JOIN blocked blocker
                 ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
             )
             SELECT count(*) FROM blocked",
            blocker_backend_pid,
        )
        .fetch_one(db)
        .await
        .unwrap()
        .unwrap_or(0);
        if blocked >= expected {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("{expected} requests did not contend on the controlled form lock");
}

async fn register_user(base: &str, label: &str) -> (Client, Uuid) {
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("role-matrix-{label}-{}@example.com", Uuid::now_v7());
    common::register_test_account(base, &client, &email, "correct horse battery staple").await;
    let db = test_db().await;
    let user_id = sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_one(&db)
        .await
        .unwrap();
    (client, user_id)
}

async fn authenticated_user_id(client: &Client, base: &str) -> Uuid {
    let response: serde_json::Value = client
        .get(format!("{base}/api/v1/auth/me"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    response["data"]["user_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn insert_membership(form_id: Uuid, user_id: Uuid, role: &str, state: &str) {
    let db = test_db().await;
    let active = state == "active";
    let key_scheme = active.then_some("account_sealed_box_v1");
    let encrypted_form_data_key = active.then(|| format!("{role}-data-key"));
    let encrypted_form_private_key = active.then(|| format!("{role}-private-key"));
    sqlx::query!(
        "INSERT INTO form_members (
            id, form_id, user_id, role, state, key_scheme,
            encrypted_form_data_key, encrypted_form_private_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        Uuid::now_v7(),
        form_id,
        user_id,
        role,
        state,
        key_scheme,
        encrypted_form_data_key,
        encrypted_form_private_key,
    )
    .execute(&db)
    .await
    .unwrap();
}

async fn set_account_quota(user_id: Uuid, max_forms: i32, max_attachment_bytes: i64) {
    let db = test_db().await;
    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET max_forms = EXCLUDED.max_forms,
             max_attachment_bytes = EXCLUDED.max_attachment_bytes",
    )
    .bind(user_id)
    .bind(max_forms)
    .bind(max_attachment_bytes)
    .execute(&db)
    .await
    .unwrap();
}

async fn fetch_account_usage(user_id: Uuid) -> (i32, i64) {
    let db = test_db().await;
    sqlx::query_as::<_, (i32, i64)>(
        "SELECT forms_used, attachment_bytes_used
         FROM account_usage
         WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&db)
    .await
    .unwrap()
    .unwrap_or((0, 0))
}

async fn upload_attachment(base: &str, form_id: Uuid, bytes: Vec<u8>) -> reqwest::Response {
    Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .unwrap()
}

async fn form_version(client: &Client, base: &str, form_id: Uuid) -> i64 {
    let response = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    if response.status() != 200 {
        return 1;
    }
    response.json::<serde_json::Value>().await.unwrap()["data"]["version"]
        .as_i64()
        .unwrap_or(1)
}

async fn create_test_form(client: &Client, base: &str, label: &str) -> Uuid {
    let response = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": format!("{label}-title"),
            "schema_ciphertext": format!("{label}-schema"),
            "form_public_key": format!("{label}-public-key"),
            "wrapped_form_private_key": format!("{label}-private-key"),
            "wrapped_form_data_key": format!("{label}-data-key"),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn register_invitation_user(_base: &str, label: &str) -> (Client, Uuid, String, String) {
    let email = format!("invitation-{label}-{}@example.com", Uuid::now_v7());
    let db = test_db().await;
    let user_id = Uuid::now_v7();
    sqlx::query!(
        "INSERT INTO users (id, email, password_hash)
         VALUES ($1, $2, 'test-password-hash')",
        user_id,
        email,
    )
    .execute(&db)
    .await
    .unwrap();

    let session_token = format!("invitation-session-{}", Uuid::now_v7());
    let session_hash = format!("{:x}", Sha256::digest(session_token.as_bytes()));
    let session = json!({
        "user_id": user_id,
        "created_at": "2026-08-26T00:00:00Z",
        "absolute_expires_at": "2099-01-01T00:00:00Z",
    })
    .to_string();
    let redis_client = redis::Client::open(
        std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string()),
    )
    .unwrap();
    let mut redis = redis::aio::ConnectionManager::new(redis_client)
        .await
        .unwrap();
    let _: () =
        redis::AsyncCommands::set_ex(&mut redis, format!("session:{session_hash}"), session, 3600)
            .await
            .unwrap();

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::COOKIE,
        format!("__Host-session={session_token}").parse().unwrap(),
    );
    let client = Client::builder().default_headers(headers).build().unwrap();
    (client, user_id, email, session_token)
}

async fn promote_manual_user_to_admin(user_id: Uuid) {
    let db = test_db().await;
    sqlx::query(
        "UPDATE users
         SET instance_admin = TRUE,
             email_verified_at = now(),
             totp_secret = '\\x01'::bytea,
             totp_enabled = TRUE
         WHERE id = $1",
    )
    .bind(user_id)
    .execute(&db)
    .await
    .unwrap();
}

/// Takes back the instance admin role `promote_manual_user_to_admin` granted,
/// on the panicking path too. A promoted user left behind makes the database
/// look as if it had a real admin, which `admin_test` asserts against and
/// `scripts/ci.sh` refuses to run that suite beside. `Drop` cannot await, so
/// the update runs on its own thread and runtime and is joined before the
/// test returns.
struct DemoteAdminOnDrop(Uuid);

impl Drop for DemoteAdminOnDrop {
    fn drop(&mut self) {
        let user_id = self.0;
        let _ = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let db = test_db().await;
                    sqlx::query("UPDATE users SET instance_admin = FALSE WHERE id = $1")
                        .bind(user_id)
                        .execute(&db)
                        .await
                })
        })
        .join();
    }
}

async fn set_manual_session_totp_verified(session_token: &str, user_id: Uuid) {
    // Raw session record written straight into Redis, not an HTTP response
    // body. Keeps the pre-rename key "totp_verified" on purpose, as the only
    // integration-level proof that Session's serde alias still loads a
    // session stored under the old name. Do not rename this to
    // "second_factor_verified".
    let session_hash = format!("{:x}", Sha256::digest(session_token.as_bytes()));
    let session = json!({
        "user_id": user_id,
        "totp_verified": true,
        "created_at": "2026-08-28T00:00:00Z",
        "absolute_expires_at": "2099-01-01T00:00:00Z",
    })
    .to_string();
    let redis_client = redis::Client::open(
        std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string()),
    )
    .unwrap();
    let mut redis = redis::aio::ConnectionManager::new(redis_client)
        .await
        .unwrap();
    let _: () =
        redis::AsyncCommands::set_ex(&mut redis, format!("session:{session_hash}"), session, 3600)
            .await
            .unwrap();
}

async fn count_audit_events(action: &str, result: &str) -> i64 {
    let db = test_db().await;
    sqlx::query_scalar("SELECT count(*) FROM admin_audit_events WHERE action = $1 AND result = $2")
        .bind(action)
        .bind(result)
        .fetch_one(&db)
        .await
        .unwrap()
}

fn invitation_cookie_header(session_token: &str, continuation_cookie: &str) -> String {
    format!("__Host-session={session_token}; __Host-invite={continuation_cookie}")
}

async fn insert_acceptance_invitation(
    form_id: Uuid,
    recipient_user_id: Uuid,
    invited_email: &str,
    role: &str,
    grant_ready: bool,
) -> (Uuid, String) {
    let db = test_db().await;
    let invitation_id = Uuid::now_v7();
    let token = format!("invitation-token-{}", Uuid::now_v7());
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let recipient_sharing_public_key = grant_ready.then_some("recipient-public-key");
    let encrypted_form_data_key = grant_ready.then_some("sealed-acceptance-data-key");
    let encrypted_form_private_key = grant_ready.then_some("sealed-acceptance-private-key");
    sqlx::query!(
        "INSERT INTO form_invitations (
            id, form_id, invited_email, role, status, token_hash,
            recipient_user_id, recipient_sharing_public_key,
            encrypted_form_data_key, encrypted_form_private_key, expires_at
         ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9,
                   now() + interval '1 hour')",
        invitation_id,
        form_id,
        invited_email,
        role,
        token_hash,
        recipient_user_id,
        recipient_sharing_public_key,
        encrypted_form_data_key,
        encrypted_form_private_key,
    )
    .execute(&db)
    .await
    .unwrap();
    (invitation_id, token)
}

async fn continue_invitation(client: &Client, base: &str, token: &str) -> String {
    let response = client
        .post(format!("{base}/api/v1/invitations/continue"))
        .json(&json!({ "token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let set_cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .find(|value| value.starts_with("__Host-invite="))
        .expect("continuation response did not set __Host-invite")
        .to_string();
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("Secure"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(set_cookie.contains("Path=/"));
    assert!(set_cookie.contains("Max-Age=1800"));
    assert!(!set_cookie.contains(token));
    set_cookie["__Host-invite=".len()..]
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

async fn assert_generic_not_found(response: reqwest::Response) {
    assert_eq!(response.status(), 404);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "not_found");
    assert_eq!(body["error"]["message"], "Not found");
}

async fn assert_generic_bad_request(response: reqwest::Response) {
    assert_eq!(response.status(), 400);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "bad_request");
    assert_eq!(body["error"]["message"], "Invalid request");
}

async fn latest_mail_content_for(email: &str) -> String {
    let client = Client::new();
    for _ in 0..40 {
        let response = client
            .get(format!(
                "{}/api/v1/search?query=to:{email}",
                common::mailpit_url()
            ))
            .send()
            .await
            .expect("mail catcher is unavailable");
        if response.status().is_success() {
            let search: serde_json::Value = response.json().await.unwrap();
            if let Some(id) = search["messages"][0]["ID"].as_str() {
                let message: serde_json::Value = client
                    .get(format!("{}/api/v1/message/{id}", common::mailpit_url()))
                    .send()
                    .await
                    .expect("mail catcher message is unavailable")
                    .json()
                    .await
                    .unwrap();
                return format!(
                    "{}\n{}",
                    message["Text"].as_str().unwrap_or_default(),
                    message["HTML"].as_str().unwrap_or_default()
                );
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("expected mail was not delivered");
}

async fn continuation_record(cookie: &str) -> Option<String> {
    let continuation_hash = format!("{:x}", Sha256::digest(cookie.as_bytes()));
    let redis_client = redis::Client::open(
        std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string()),
    )
    .unwrap();
    let mut redis = redis::aio::ConnectionManager::new(redis_client)
        .await
        .unwrap();
    redis::AsyncCommands::get(
        &mut redis,
        format!("invite_continuation:{continuation_hash}"),
    )
    .await
    .unwrap()
}

fn assert_clears_invitation_cookie(response: &reqwest::Response) {
    let set_cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .find(|value| value.starts_with("__Host-invite="))
        .expect("decision response did not clear __Host-invite");
    assert!(set_cookie.starts_with("__Host-invite=;"));
    assert!(set_cookie.contains("Max-Age=0"));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("Secure"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(set_cookie.contains("Path=/"));
}

#[tokio::test]
async fn sharing_schema_backfills_every_existing_form_owner() {
    let db = test_db().await;
    let missing: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM forms f
         LEFT JOIN form_members m
           ON m.form_id = f.id AND m.role = 'owner'
         WHERE m.id IS NULL",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(missing, 0);

    let duplicate_owners: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM (
           SELECT form_id FROM form_members
           WHERE role = 'owner' GROUP BY form_id HAVING count(*) > 1
         ) duplicates",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(duplicate_owners, 0);
}

#[tokio::test]
async fn account_sharing_key_is_initialized_once_and_retried_idempotently() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("sharing-key-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, "correct horse battery staple").await;

    let initial = client
        .get(format!("{base}/api/v1/account/sharing-key"))
        .send()
        .await
        .unwrap();
    assert_eq!(initial.status(), 200);
    let initial_body: serde_json::Value = initial.json().await.unwrap();
    let user_id = initial_body["data"]["user_id"]
        .as_str()
        .expect("sharing GET must bind the authenticated user")
        .to_string();
    assert!(initial_body["data"]["sharing_public_key"].is_null());
    assert!(initial_body["data"]["wrapped_sharing_private_key"].is_null());
    assert!(initial_body["data"]["sharing_key_version"].is_null());

    let public_key = sharing_public_key(7);
    let wrapped_private = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9_u8; 72]);
    let record = json!({
        "expected_user_id": user_id,
        "sharing_public_key": public_key,
        "wrapped_sharing_private_key": wrapped_private,
        "sharing_key_version": 1,
    });

    let created = client
        .put(format!("{base}/api/v1/account/sharing-key"))
        .json(&record)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);

    let retrieved = client
        .get(format!("{base}/api/v1/account/sharing-key"))
        .send()
        .await
        .unwrap();
    assert_eq!(retrieved.status(), 200);
    let retrieved_body: serde_json::Value = retrieved.json().await.unwrap();
    assert_eq!(
        retrieved_body["data"]["sharing_public_key"],
        record["sharing_public_key"]
    );
    assert_eq!(
        retrieved_body["data"]["wrapped_sharing_private_key"],
        record["wrapped_sharing_private_key"]
    );
    assert_eq!(
        retrieved_body["data"]["sharing_key_version"],
        record["sharing_key_version"]
    );

    let retry = client
        .put(format!("{base}/api/v1/account/sharing-key"))
        .json(&record)
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), 200);

    let different_record = json!({
        "expected_user_id": record["expected_user_id"],
        "sharing_public_key": sharing_public_key(8),
        "wrapped_sharing_private_key": wrapped_private,
        "sharing_key_version": 1,
    });
    let conflict = client
        .put(format!("{base}/api/v1/account/sharing-key"))
        .json(&different_record)
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), 409);

    let after_conflict = client
        .get(format!("{base}/api/v1/account/sharing-key"))
        .send()
        .await
        .unwrap();
    assert_eq!(after_conflict.status(), 200);
    let after_conflict_body: serde_json::Value = after_conflict.json().await.unwrap();
    assert_eq!(
        after_conflict_body["data"]["sharing_public_key"],
        record["sharing_public_key"]
    );
    assert_eq!(
        after_conflict_body["data"]["wrapped_sharing_private_key"],
        record["wrapped_sharing_private_key"]
    );
    assert_eq!(
        after_conflict_body["data"]["sharing_key_version"],
        record["sharing_key_version"]
    );
}

#[tokio::test]
async fn malformed_sharing_keys_and_half_grants_are_generic_bad_requests() {
    let base = common::base_url();
    let owner = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("sharing-validation-{}@example.com", Uuid::now_v7());
    common::register_test_account(&base, &owner, &email, "correct horse battery staple").await;
    let user_id = authenticated_user_id(&owner, &base).await;
    let valid_public_key = sharing_public_key(3);
    let valid_wrapped_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4_u8; 72]);

    for (case_index, (sharing_public_key, wrapped_sharing_private_key)) in [
        ("not_base64".to_string(), valid_wrapped_key.clone()),
        (
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode([3_u8; SHARING_PUBLIC_KEY_BYTES - 1]),
            valid_wrapped_key.clone(),
        ),
        (valid_public_key.clone(), "not_base64".to_string()),
        (
            valid_public_key.clone(),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4_u8; 71]),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let response = owner
            .put(format!("{base}/api/v1/account/sharing-key"))
            .json(&json!({
                "expected_user_id": user_id,
                "sharing_public_key": sharing_public_key,
                "wrapped_sharing_private_key": wrapped_sharing_private_key,
                "sharing_key_version": 1,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "sharing-key case {case_index}");
        assert_generic_bad_request(response).await;
    }

    let form_id = create_test_form(&owner, &base, "sharing-validation").await;
    assert_generic_bad_request(
        owner
            .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
            .json(&json!({
                "invited_email": format!("half-grant-{}@example.com", Uuid::now_v7()),
                "role": "viewer",
                "recipient_sharing_public_key": valid_public_key,
                "encrypted_form_data_key": "sealed-data-only",
                "encrypted_form_private_key": null,
            }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_generic_bad_request(
        owner
            .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
            .json(&json!({
                "invited_email": format!("inverse-half-grant-{}@example.com", Uuid::now_v7()),
                "role": "viewer",
                "recipient_sharing_public_key": valid_public_key,
                "encrypted_form_data_key": null,
                "encrypted_form_private_key": "sealed-private-only",
            }))
            .send()
            .await
            .unwrap(),
    )
    .await;
}

#[tokio::test]
async fn sharing_key_put_rejects_mismatched_and_switched_authenticated_users() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let first_email = format!("sharing-bind-a-{}@example.com", Uuid::now_v7());
    common::register_test_account(&base, &client, &first_email, "correct horse battery staple")
        .await;

    let first_get: serde_json::Value = client
        .get(format!("{base}/api/v1/account/sharing-key"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let first_user_id = first_get["data"]["user_id"].as_str().unwrap();
    let record = json!({
        "expected_user_id": first_user_id,
        "sharing_public_key": sharing_public_key(71),
        "wrapped_sharing_private_key": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([72_u8; 72]),
        "sharing_key_version": 1,
    });

    let mismatched = client
        .put(format!("{base}/api/v1/account/sharing-key"))
        .json(&json!({
            "expected_user_id": Uuid::now_v7(),
            "sharing_public_key": record["sharing_public_key"],
            "wrapped_sharing_private_key": record["wrapped_sharing_private_key"],
            "sharing_key_version": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(mismatched.status(), 409);
    let mismatch_body: serde_json::Value = mismatched.json().await.unwrap();
    assert_eq!(mismatch_body["error"]["code"], "conflict");

    let second_email = format!("sharing-bind-b-{}@example.com", Uuid::now_v7());
    common::register_test_account(
        &base,
        &client,
        &second_email,
        "correct horse battery staple",
    )
    .await;

    let switched = client
        .put(format!("{base}/api/v1/account/sharing-key"))
        .json(&record)
        .send()
        .await
        .unwrap();
    assert_eq!(switched.status(), 409);

    let second_get: serde_json::Value = client
        .get(format!("{base}/api/v1/account/sharing-key"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(second_get["data"]["user_id"], first_user_id);
    assert!(second_get["data"]["sharing_public_key"].is_null());
    assert!(second_get["data"]["wrapped_sharing_private_key"].is_null());
    assert!(second_get["data"]["sharing_key_version"].is_null());
}

#[tokio::test]
async fn role_matrix_controls_authenticated_form_content_and_key_access() {
    let base = common::base_url();
    let (owner, _) = register_user(&base, "owner").await;
    let (editor, editor_id) = register_user(&base, "editor").await;
    let (viewer, viewer_id) = register_user(&base, "viewer").await;
    let (awaiting, awaiting_id) = register_user(&base, "awaiting").await;
    let (unrelated, _) = register_user(&base, "unrelated").await;

    let create = owner
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "role-matrix-title",
            "schema_ciphertext": "role-matrix-schema",
            "form_public_key": "role-matrix-public-key",
            "wrapped_form_private_key": "owner-private-key",
            "wrapped_form_data_key": "owner-data-key",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status(), 200);
    let form_id = create.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();

    insert_membership(form_id, editor_id, "editor", "active").await;
    insert_membership(form_id, viewer_id, "viewer", "active").await;
    insert_membership(form_id, awaiting_id, "viewer", "awaiting_keys").await;

    let anonymous = Client::new();
    anonymous
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "role-matrix-response" }))
        .send()
        .await
        .unwrap();
    let upload = anonymous
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![7_u8, 8, 9])
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 200);
    let attachment_id = upload.json::<serde_json::Value>().await.unwrap()["data"]["attachment_id"]
        .as_str()
        .unwrap()
        .to_string();

    let cases = [
        ("owner", &owner, 200, 200, 200, 200),
        ("editor", &editor, 200, 200, 200, 200),
        ("viewer", &viewer, 200, 404, 200, 200),
        ("awaiting", &awaiting, 404, 404, 404, 404),
        ("unrelated", &unrelated, 404, 404, 404, 404),
    ];

    for (role, client, get_status, patch_status, responses_status, download_status) in cases {
        let expected_version = form_version(&owner, &base, form_id).await;

        let get = client
            .get(format!("{base}/api/v1/forms/{form_id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(get.status(), get_status, "{role} GET form");

        let patch = client
            .patch(format!("{base}/api/v1/forms/{form_id}"))
            .json(&json!({
                "allow_response_editing": false,
                "expected_version": expected_version,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(patch.status(), patch_status, "{role} PATCH form");

        let responses = client
            .get(format!("{base}/api/v1/forms/{form_id}/responses"))
            .send()
            .await
            .unwrap();
        assert_eq!(responses.status(), responses_status, "{role} GET responses");

        let download = client
            .get(format!(
                "{base}/api/v1/forms/{form_id}/attachments/{attachment_id}"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(download.status(), download_status, "{role} GET attachment");
    }

    let editor_details = editor
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(editor_details.status(), 200);
    let editor_body: serde_json::Value = editor_details.json().await.unwrap();
    assert_eq!(editor_body["data"]["role"], "editor");
    assert_eq!(editor_body["data"]["membership_state"], "active");
    assert_eq!(editor_body["data"]["title_ciphertext"], "role-matrix-title");
    assert_eq!(
        editor_body["data"]["form_public_key"],
        "role-matrix-public-key"
    );
    assert!(editor_body["data"]["version"].as_i64().is_some());
    assert_eq!(editor_body["data"]["accepting_responses"], true);
    assert_eq!(
        editor_body["data"]["encrypted_form_data_key"],
        "editor-data-key"
    );
    assert_eq!(
        editor_body["data"]["encrypted_form_private_key"],
        "editor-private-key"
    );

    let list = awaiting
        .get(format!("{base}/api/v1/forms"))
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), 200);
    let list_body: serde_json::Value = list.json().await.unwrap();
    let awaiting_form = list_body["data"]["forms"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == form_id.to_string())
        .expect("awaiting membership must have a safe list item");
    assert_eq!(awaiting_form["role"], "viewer");
    assert_eq!(awaiting_form["membership_state"], "awaiting_keys");
    assert!(awaiting_form["title_ciphertext"].is_null());
    assert!(awaiting_form["schema_ciphertext"].is_null());
    assert!(awaiting_form["key_scheme"].is_null());
    assert!(awaiting_form["encrypted_form_data_key"].is_null());
    assert!(awaiting_form["encrypted_form_private_key"].is_null());
}

#[tokio::test]
async fn owner_invitation_lifecycle() {
    let base = common::base_url();
    let owner = Client::builder().cookie_store(true).build().unwrap();
    let recipient = Client::builder().cookie_store(true).build().unwrap();
    let uninitialized = Client::builder().cookie_store(true).build().unwrap();
    let owner_email = format!("invite-owner-{}@example.com", Uuid::now_v7());
    let recipient_email = format!("invite-recipient-{}@example.com", Uuid::now_v7());
    let uninitialized_email = format!("invite-new-{}@example.com", Uuid::now_v7());
    common::register_test_account(&base, &owner, &owner_email, "correct horse battery staple")
        .await;
    common::register_test_account(
        &base,
        &recipient,
        &recipient_email,
        "correct horse battery staple",
    )
    .await;
    common::register_test_account(
        &base,
        &uninitialized,
        &uninitialized_email,
        "correct horse battery staple",
    )
    .await;

    let create_form = owner
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "invitation-title-ciphertext",
            "schema_ciphertext": "invitation-schema-ciphertext",
            "form_public_key": "invitation-public-key",
            "wrapped_form_private_key": "owner-private-key",
            "wrapped_form_data_key": "owner-data-key",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create_form.status(), 200);
    let form_id = create_form.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();

    let recipient_public_key = sharing_public_key(31);
    let wrapped_private_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([41_u8; 72]);
    let recipient_id = authenticated_user_id(&recipient, &base).await;
    let put_key = recipient
        .put(format!("{base}/api/v1/account/sharing-key"))
        .json(&json!({
            "expected_user_id": recipient_id,
            "sharing_public_key": recipient_public_key,
            "wrapped_sharing_private_key": wrapped_private_key,
            "sharing_key_version": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(put_key.status(), 200);

    let lookup = owner
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/recipient-key"
        ))
        .json(&json!({ "invited_email": format!("  {}  ", recipient_email.to_uppercase()) }))
        .send()
        .await
        .unwrap();
    assert_eq!(lookup.status(), 200);
    let lookup_body: serde_json::Value = lookup.json().await.unwrap();
    assert_eq!(
        lookup_body["data"]["sharing_public_key"],
        recipient_public_key
    );
    assert_eq!(lookup_body["data"]["sharing_key_version"], 1);
    assert!(lookup_body["data"].get("account_exists").is_none());

    let unauthorized_lookup = recipient
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/recipient-key"
        ))
        .json(&json!({ "invited_email": recipient_email }))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_lookup.status(), 404);

    let create_invitation = owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&json!({
            "invited_email": format!("  {}  ", recipient_email.to_uppercase()),
            "role": "editor",
            "recipient_sharing_public_key": recipient_public_key,
            "encrypted_form_data_key": "sealed-data-key-v1",
            "encrypted_form_private_key": "sealed-private-key-v1",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create_invitation.status(), 200);
    let create_body: serde_json::Value = create_invitation.json().await.unwrap();
    let invitation_id = create_body["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let (first_delivery_id, first_token) =
        common::latest_invitation_delivery_for(&recipient_email).await;
    assert_eq!(first_token.len(), 43);

    let db = test_db().await;
    let created = sqlx::query!(
        "SELECT invited_email::text AS invited_email, role, status, token_hash,
                recipient_sharing_public_key, encrypted_form_data_key,
                encrypted_form_private_key,
                extract(epoch FROM (expires_at - created_at))::bigint AS ttl_seconds
         FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let first_hash = created.token_hash.unwrap();
    let first_token_hash = format!("{:x}", Sha256::digest(first_token.as_bytes()));
    assert_eq!(created.invited_email.unwrap(), recipient_email);
    assert_eq!(created.role, "editor");
    assert_eq!(created.status, "pending");
    assert_eq!(first_hash.len(), 64);
    assert_eq!(first_hash, first_token_hash);
    assert!(first_hash != first_token);
    assert!(
        first_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    );
    let invitation_mail = latest_mail_content_for(&recipient_email).await;
    assert!(!invitation_mail.contains("invitation-title-ciphertext"));
    assert_eq!(
        created.recipient_sharing_public_key.unwrap(),
        recipient_public_key
    );
    assert_eq!(
        created.encrypted_form_data_key.unwrap(),
        "sealed-data-key-v1"
    );
    assert_eq!(
        created.encrypted_form_private_key.unwrap(),
        "sealed-private-key-v1"
    );
    assert_eq!(created.ttl_seconds.unwrap(), 7 * 24 * 60 * 60);

    let resend = owner
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/{invitation_id}/resend"
        ))
        .json(&json!({
            "invited_email": recipient_email,
            "role": "viewer",
            "recipient_sharing_public_key": recipient_public_key,
            "encrypted_form_data_key": "sealed-data-key-v2",
            "encrypted_form_private_key": "sealed-private-key-v2",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 200);
    let resent_id = resend.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    assert_eq!(resent_id, invitation_id);
    let (_, second_token) =
        common::next_invitation_delivery_for(&recipient_email, &first_delivery_id).await;
    assert!(first_token != second_token);
    let resent = sqlx::query!(
        "SELECT status, token_hash, role, encrypted_form_data_key,
                encrypted_form_private_key
         FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(resent.status, "pending");
    assert_eq!(resent.role, "viewer");
    assert_eq!(resent.token_hash.as_deref().map(str::len), Some(64));
    assert_ne!(resent.token_hash.as_deref(), Some(first_hash.as_str()));
    assert_eq!(
        resent.encrypted_form_data_key.unwrap(),
        "sealed-data-key-v2"
    );
    assert_eq!(
        resent.encrypted_form_private_key.unwrap(),
        "sealed-private-key-v2"
    );
    let old_token_still_valid: bool = sqlx::query_scalar!(
        "SELECT EXISTS(
            SELECT 1 FROM form_invitations
            WHERE token_hash = $1 AND status = 'pending'
         )",
        first_token_hash,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap_or(false);
    assert!(!old_token_still_valid);

    let uninitialized_lookup = owner
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/recipient-key"
        ))
        .json(&json!({ "invited_email": uninitialized_email }))
        .send()
        .await
        .unwrap();
    assert_eq!(uninitialized_lookup.status(), 200);
    let uninitialized_lookup_body: serde_json::Value = uninitialized_lookup.json().await.unwrap();
    assert!(uninitialized_lookup_body["data"]["sharing_public_key"].is_null());
    assert!(uninitialized_lookup_body["data"]["sharing_key_version"].is_null());

    let second_invitation = owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&json!({
            "invited_email": uninitialized_email,
            "role": "viewer",
            "recipient_sharing_public_key": null,
            "encrypted_form_data_key": null,
            "encrypted_form_private_key": null,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second_invitation.status(), 200);
    let second_invitation_id = second_invitation.json::<serde_json::Value>().await.unwrap()["data"]
        ["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let uninitialized_grant = sqlx::query!(
        "SELECT recipient_sharing_public_key, encrypted_form_data_key,
                encrypted_form_private_key
         FROM form_invitations WHERE id = $1",
        second_invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(uninitialized_grant.recipient_sharing_public_key.is_none());
    assert!(uninitialized_grant.encrypted_form_data_key.is_none());
    assert!(uninitialized_grant.encrypted_form_private_key.is_none());

    let revoke = owner
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/invitations/{invitation_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(revoke.status(), 200);
    let revoked = sqlx::query!(
        "SELECT status, token_hash FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(revoked.status, "revoked");
    assert!(revoked.token_hash.is_none());
}

#[tokio::test]
async fn resend_revives_the_expired_path_invitation_id() {
    let base = common::base_url();
    let (owner, _) = register_user(&base, "re").await;
    let recipient = Client::builder().cookie_store(true).build().unwrap();
    let recipient_email = format!("revive-recipient-{}@example.com", Uuid::now_v7());
    common::register_test_account(
        &base,
        &recipient,
        &recipient_email,
        "correct horse battery staple",
    )
    .await;
    let db = test_db().await;
    let recipient_id =
        sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", recipient_email)
            .fetch_one(&db)
            .await
            .unwrap();
    let recipient_public_key = sharing_public_key(51);
    let put_key = recipient
        .put(format!("{base}/api/v1/account/sharing-key"))
        .json(&json!({
            "expected_user_id": recipient_id,
            "sharing_public_key": recipient_public_key,
            "wrapped_sharing_private_key": base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode([61_u8; 72]),
            "sharing_key_version": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(put_key.status(), 200);

    let form_id = create_test_form(&owner, &base, "revive-expired").await;
    let first = owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&json!({
            "invited_email": recipient_email,
            "role": "viewer",
            "recipient_sharing_public_key": recipient_public_key,
            "encrypted_form_data_key": "expired-data-v1",
            "encrypted_form_private_key": "expired-private-v1",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let invitation_id = first.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let old_hash = sqlx::query_scalar!(
        "SELECT token_hash FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap();
    sqlx::query!(
        "UPDATE form_invitations
         SET status = 'expired', token_hash = NULL, expires_at = now() - interval '1 second'
         WHERE id = $1",
        invitation_id,
    )
    .execute(&db)
    .await
    .unwrap();

    let resend = owner
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/{invitation_id}/resend"
        ))
        .json(&json!({
            "invited_email": format!("  {}  ", recipient_email.to_uppercase()),
            "role": "editor",
            "recipient_sharing_public_key": recipient_public_key,
            "encrypted_form_data_key": "expired-data-v2",
            "encrypted_form_private_key": "expired-private-v2",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 200);
    let resent_id = resend.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    assert_eq!(resent_id, invitation_id);

    let revived = sqlx::query!(
        "SELECT status, role, token_hash, recipient_user_id,
                recipient_sharing_public_key, encrypted_form_data_key,
                encrypted_form_private_key,
                extract(epoch FROM (expires_at - now()))::bigint AS ttl_seconds
         FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(revived.status, "pending");
    assert_eq!(revived.role, "editor");
    assert_eq!(revived.token_hash.as_deref().map(str::len), Some(64));
    assert_ne!(revived.token_hash.as_deref(), Some(old_hash.as_str()));
    assert_eq!(revived.recipient_user_id, Some(recipient_id));
    assert_eq!(
        revived.recipient_sharing_public_key.as_deref(),
        Some(recipient_public_key.as_str())
    );
    assert_eq!(
        revived.encrypted_form_data_key.as_deref(),
        Some("expired-data-v2")
    );
    assert_eq!(
        revived.encrypted_form_private_key.as_deref(),
        Some("expired-private-v2")
    );
    assert!(matches!(revived.ttl_seconds, Some(604_795..=604_800)));
    let stale_hash_exists: bool = sqlx::query_scalar!(
        "SELECT EXISTS(SELECT 1 FROM form_invitations WHERE token_hash = $1)",
        old_hash,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap_or(false);
    assert!(!stale_hash_exists);
}

#[tokio::test]
async fn resend_revives_an_overdue_pending_path_invitation_id() {
    let base = common::base_url();
    let (owner, _) = register_user(&base, "ro").await;
    let form_id = create_test_form(&owner, &base, "revive-overdue").await;
    let invited_email = format!("revive-overdue-{}@example.com", Uuid::now_v7());
    let body = json!({
        "invited_email": invited_email,
        "role": "viewer",
        "recipient_sharing_public_key": null,
        "encrypted_form_data_key": null,
        "encrypted_form_private_key": null,
    });
    let first = owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let invitation_id = first.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let db = test_db().await;
    let old_hash = sqlx::query_scalar!(
        "SELECT token_hash FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap();
    sqlx::query!(
        "UPDATE form_invitations SET expires_at = now() - interval '1 second'
         WHERE id = $1",
        invitation_id,
    )
    .execute(&db)
    .await
    .unwrap();

    let resend = owner
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/{invitation_id}/resend"
        ))
        .json(&json!({
            "invited_email": invited_email,
            "role": "editor",
            "recipient_sharing_public_key": null,
            "encrypted_form_data_key": null,
            "encrypted_form_private_key": null,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 200);
    let resent_id = resend.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    assert_eq!(resent_id, invitation_id);

    let revived = sqlx::query!(
        "SELECT status, role, token_hash,
                extract(epoch FROM (expires_at - now()))::bigint AS ttl_seconds
         FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(revived.status, "pending");
    assert_eq!(revived.role, "editor");
    assert_eq!(revived.token_hash.as_deref().map(str::len), Some(64));
    assert_ne!(revived.token_hash.as_deref(), Some(old_hash.as_str()));
    assert!(matches!(revived.ttl_seconds, Some(604_795..=604_800)));
}

#[tokio::test]
async fn expired_resend_conflict_does_not_mutate_another_open_invitation() {
    let base = common::base_url();
    let (owner, _) = register_user(&base, "rs").await;
    let form_id = create_test_form(&owner, &base, "resend-scope").await;
    let invited_email = format!("resend-scope-{}@example.com", Uuid::now_v7());
    let invitation = |role: &str| {
        json!({
            "invited_email": invited_email,
            "role": role,
            "recipient_sharing_public_key": null,
            "encrypted_form_data_key": null,
            "encrypted_form_private_key": null,
        })
    };

    let first = owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&invitation("viewer"))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let first_id = first.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();

    let db = test_db().await;
    sqlx::query!(
        "UPDATE form_invitations
         SET status = 'expired', token_hash = NULL, expires_at = now() - interval '1 second'
         WHERE id = $1",
        first_id,
    )
    .execute(&db)
    .await
    .unwrap();

    // This is reachable under the partial unique index: a terminal row and a
    // distinct open row may share the same form/email pair.
    let second = owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&invitation("viewer"))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 200);
    let second_id = second.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    assert_ne!(first_id, second_id);
    let before = sqlx::query!(
        "SELECT status, role, token_hash, expires_at, updated_at
         FROM form_invitations WHERE id = $1",
        second_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();

    let resend = owner
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/{first_id}/resend"
        ))
        .json(&invitation("editor"))
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 409);

    let expired = sqlx::query!(
        "SELECT status, token_hash FROM form_invitations WHERE id = $1",
        first_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(expired.status, "expired");
    assert!(expired.token_hash.is_none());

    let after = sqlx::query!(
        "SELECT status, role, token_hash, expires_at, updated_at
         FROM form_invitations WHERE id = $1",
        second_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(after.status, before.status);
    assert_eq!(after.role, before.role);
    assert_eq!(after.token_hash, before.token_hash);
    assert_eq!(after.expires_at, before.expires_at);
    assert_eq!(after.updated_at, before.updated_at);
}

#[tokio::test]
async fn non_owner_cannot_create_resend_or_revoke_invitations() {
    let base = common::base_url();
    let (owner, _) = register_user(&base, "no").await;
    let (non_owner, _) = register_user(&base, "nn").await;
    let form_id = create_test_form(&owner, &base, "non-owner").await;
    let invited_email = format!("non-owner-{}@example.com", Uuid::now_v7());
    let body = json!({
        "invited_email": invited_email,
        "role": "viewer",
        "recipient_sharing_public_key": null,
        "encrypted_form_data_key": null,
        "encrypted_form_private_key": null,
    });

    let created = owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);
    let invitation_id = created.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let db = test_db().await;
    let before = sqlx::query!(
        "SELECT status, token_hash, updated_at FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();

    let distinct_email = format!("other-{}@example.com", Uuid::now_v7());
    let create = non_owner
        .post(format!("{base}/api/v1/forms/{form_id}/invitations"))
        .json(&json!({
            "invited_email": distinct_email,
            "role": "editor",
            "recipient_sharing_public_key": null,
            "encrypted_form_data_key": null,
            "encrypted_form_private_key": null,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status(), 404);
    let distinct_invitation_count: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM form_invitations
         WHERE form_id = $1 AND invited_email = $2",
        form_id,
        distinct_email,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(distinct_invitation_count, 0);

    let resend = non_owner
        .post(format!(
            "{base}/api/v1/forms/{form_id}/invitations/{invitation_id}/resend"
        ))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 404);

    let revoke = non_owner
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/invitations/{invitation_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(revoke.status(), 404);

    let after = sqlx::query!(
        "SELECT status, token_hash, updated_at FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(after.status, before.status);
    assert_eq!(after.token_hash, before.token_hash);
    assert_eq!(after.updated_at, before.updated_at);
}

#[tokio::test]
async fn concurrent_creates_keep_one_open_invitation() {
    let base = common::base_url();
    let (owner, _) = register_user(&base, "cc").await;
    let form_id = create_test_form(&owner, &base, "concurrent-invitations").await;
    let invited_email = format!("concurrent-{}@example.com", Uuid::now_v7());
    let create_body = json!({
        "invited_email": invited_email,
        "role": "viewer",
        "recipient_sharing_public_key": null,
        "encrypted_form_data_key": null,
        "encrypted_form_private_key": null,
    });
    let create_url = format!("{base}/api/v1/forms/{form_id}/invitations");
    let first_create = owner.post(&create_url).json(&create_body).send();
    let second_create = owner.post(&create_url).json(&create_body).send();
    let (first_create, second_create) = tokio::join!(first_create, second_create);
    assert_eq!(first_create.unwrap().status(), 200);
    assert_eq!(second_create.unwrap().status(), 200);

    let db = test_db().await;
    let rows = sqlx::query!(
        "SELECT status, token_hash FROM form_invitations
         WHERE form_id = $1 AND invited_email = $2",
        form_id,
        invited_email,
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "pending");
    assert_eq!(rows[0].token_hash.as_deref().map(str::len), Some(64));
}

#[tokio::test]
async fn invitation_acceptance_with_complete_grant_creates_active_membership() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "accept-active-owner").await;
    let (recipient, recipient_id, recipient_email, recipient_session) =
        register_invitation_user(&base, "accept-active-recipient").await;
    let form_id = create_test_form(&owner, &base, "accept-active").await;
    let (invitation_id, token) = insert_acceptance_invitation(
        form_id,
        recipient_id,
        &recipient_email.to_uppercase(),
        "editor",
        true,
    )
    .await;

    let continuation_cookie = continue_invitation(&recipient, &base, &token).await;
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    assert!(continuation_cookie != token);
    assert!(continuation_cookie != token_hash);
    let stored = continuation_record(&continuation_cookie).await;
    assert_eq!(
        stored.as_deref(),
        Some(
            json!({ "invitation_id": invitation_id })
                .to_string()
                .as_str()
        )
    );

    let current = recipient
        .get(format!("{base}/api/v1/invitations/current"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&recipient_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(current.status(), 200);
    let current_body: serde_json::Value = current.json().await.unwrap();
    assert_eq!(current_body["data"]["role"], "editor");
    assert_eq!(current_body["data"]["status"], "pending");
    assert_eq!(current_body["data"]["grant_ready"], true);
    assert_eq!(current_body["data"]["masked_email"], "I***@EXAMPLE.COM");
    assert!(current_body["data"].get("form_id").is_none());
    assert!(current_body["data"].get("invited_email").is_none());

    let accepted = recipient
        .post(format!("{base}/api/v1/invitations/current/accept"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&recipient_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);
    assert_clears_invitation_cookie(&accepted);
    assert!(continuation_record(&continuation_cookie).await.is_none());
    let accepted_body: serde_json::Value = accepted.json().await.unwrap();
    assert_eq!(accepted_body["data"]["form_id"], form_id.to_string());
    assert_eq!(accepted_body["data"]["membership_state"], "active");

    let db = test_db().await;
    let member = sqlx::query!(
        "SELECT role, state, key_scheme, encrypted_form_data_key,
                encrypted_form_private_key
         FROM form_members WHERE form_id = $1 AND user_id = $2",
        form_id,
        recipient_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(member.role, "editor");
    assert_eq!(member.state, "active");
    assert_eq!(member.key_scheme.as_deref(), Some("account_sealed_box_v1"));
    assert_eq!(
        member.encrypted_form_data_key.as_deref(),
        Some("sealed-acceptance-data-key")
    );
    assert_eq!(
        member.encrypted_form_private_key.as_deref(),
        Some("sealed-acceptance-private-key")
    );
    let invitation = sqlx::query!(
        "SELECT status, token_hash, recipient_user_id, accepted_at
         FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(invitation.status, "accepted");
    assert!(invitation.token_hash.is_none());
    assert_eq!(invitation.recipient_user_id, Some(recipient_id));
    assert!(invitation.accepted_at.is_some());
}

#[tokio::test]
async fn invitation_acceptance_without_grant_creates_awaiting_keys_membership() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "accept-awaiting-owner").await;
    let (recipient, recipient_id, recipient_email, recipient_session) =
        register_invitation_user(&base, "accept-awaiting-recipient").await;
    let form_id = create_test_form(&owner, &base, "accept-awaiting").await;
    let (_, token) =
        insert_acceptance_invitation(form_id, recipient_id, &recipient_email, "viewer", false)
            .await;

    let continuation_cookie = continue_invitation(&recipient, &base, &token).await;
    let accepted = recipient
        .post(format!("{base}/api/v1/invitations/current/accept"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&recipient_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);
    let accepted_body: serde_json::Value = accepted.json().await.unwrap();
    assert_eq!(accepted_body["data"]["form_id"], form_id.to_string());
    assert_eq!(accepted_body["data"]["membership_state"], "awaiting_keys");

    let db = test_db().await;
    let member = sqlx::query!(
        "SELECT role, state, key_scheme, encrypted_form_data_key,
                encrypted_form_private_key
         FROM form_members WHERE form_id = $1 AND user_id = $2",
        form_id,
        recipient_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(member.role, "viewer");
    assert_eq!(member.state, "awaiting_keys");
    assert!(member.key_scheme.is_none());
    assert!(member.encrypted_form_data_key.is_none());
    assert!(member.encrypted_form_private_key.is_none());
}

#[tokio::test]
async fn invitation_wrong_account_is_forbidden_without_consuming_invitation() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "wrong-owner").await;
    let (_, recipient_id, recipient_email, _) =
        register_invitation_user(&base, "wrong-recipient").await;
    let (wrong_account, _, _, wrong_session) =
        register_invitation_user(&base, "wrong-signed-in").await;
    let form_id = create_test_form(&owner, &base, "wrong-account").await;
    let (invitation_id, token) =
        insert_acceptance_invitation(form_id, recipient_id, &recipient_email, "viewer", false)
            .await;

    let continuation_cookie = continue_invitation(&wrong_account, &base, &token).await;
    let current = wrong_account
        .get(format!("{base}/api/v1/invitations/current"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&wrong_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(current.status(), 200);
    let current_body: serde_json::Value = current.json().await.unwrap();
    let current_data = current_body["data"].as_object().unwrap();
    assert_eq!(current_data.len(), 4);
    assert_eq!(current_data["role"], "viewer");
    assert_eq!(current_data["status"], "pending");
    assert_eq!(current_data["masked_email"], "i***@example.com");
    assert_eq!(current_data["grant_ready"], false);

    let response = wrong_account
        .post(format!("{base}/api/v1/invitations/current/accept"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&wrong_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "wrong_account");
    assert_eq!(body["error"]["message"], "Use the invited account");
    assert!(continuation_record(&continuation_cookie).await.is_some());
    let resumed = wrong_account
        .get(format!("{base}/api/v1/invitations/current"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&wrong_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(resumed.status(), 200);

    let db = test_db().await;
    let invitation = sqlx::query!(
        "SELECT status, token_hash, recipient_user_id, accepted_at
         FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(invitation.status, "pending");
    assert!(invitation.token_hash.is_some());
    assert_eq!(invitation.recipient_user_id, Some(recipient_id));
    assert!(invitation.accepted_at.is_none());
    let member_count: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM form_members WHERE form_id = $1 AND role <> 'owner'",
        form_id,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(member_count, 0);
}

#[tokio::test]
async fn invitation_acceptance_rejects_expired_revoked_and_consumed_tokens_generically() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "invalid-owner").await;
    let (recipient, recipient_id, recipient_email, _) =
        register_invitation_user(&base, "invalid-recipient").await;
    let form_id = create_test_form(&owner, &base, "invalid-tokens").await;
    let db = test_db().await;

    for status in ["expired", "revoked", "accepted"] {
        let (invitation_id, token) =
            insert_acceptance_invitation(form_id, recipient_id, &recipient_email, "viewer", false)
                .await;
        sqlx::query!(
            "UPDATE form_invitations
             SET status = $1, token_hash = NULL,
                 accepted_at = CASE WHEN $1 = 'accepted' THEN now() ELSE NULL END
             WHERE id = $2",
            status,
            invitation_id,
        )
        .execute(&db)
        .await
        .unwrap();
        let response = recipient
            .post(format!("{base}/api/v1/invitations/continue"))
            .json(&json!({ "token": token }))
            .send()
            .await
            .unwrap();
        assert_generic_not_found(response).await;
    }

    let (_, expired_token) =
        insert_acceptance_invitation(form_id, recipient_id, &recipient_email, "viewer", false)
            .await;
    sqlx::query!(
        "UPDATE form_invitations SET expires_at = now() - interval '1 second'
         WHERE token_hash = $1",
        format!("{:x}", Sha256::digest(expired_token.as_bytes())),
    )
    .execute(&db)
    .await
    .unwrap();
    let response = recipient
        .post(format!("{base}/api/v1/invitations/continue"))
        .json(&json!({ "token": expired_token }))
        .send()
        .await
        .unwrap();
    assert_generic_not_found(response).await;
}

#[tokio::test]
async fn invitation_acceptance_replay_with_same_continuation_is_not_found() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "replay-owner").await;
    let (recipient, recipient_id, recipient_email, recipient_session) =
        register_invitation_user(&base, "replay-recipient").await;
    let form_id = create_test_form(&owner, &base, "accept-replay").await;
    let (_, token) =
        insert_acceptance_invitation(form_id, recipient_id, &recipient_email, "editor", true).await;
    let continuation_cookie = continue_invitation(&recipient, &base, &token).await;
    let cookie_header = invitation_cookie_header(&recipient_session, &continuation_cookie);

    let first = recipient
        .post(format!("{base}/api/v1/invitations/current/accept"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let second = recipient
        .post(format!("{base}/api/v1/invitations/current/accept"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .send()
        .await
        .unwrap();
    assert_generic_not_found(second).await;

    let db = test_db().await;
    let member_count: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM form_members WHERE form_id = $1 AND user_id = $2",
        form_id,
        recipient_id,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(member_count, 1);
}

#[tokio::test]
async fn invitation_acceptance_decline_revokes_without_creating_membership() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "decline-owner").await;
    let (recipient, recipient_id, recipient_email, recipient_session) =
        register_invitation_user(&base, "decline-recipient").await;
    let form_id = create_test_form(&owner, &base, "accept-decline").await;
    let (invitation_id, token) =
        insert_acceptance_invitation(form_id, recipient_id, &recipient_email, "viewer", false)
            .await;
    let continuation_cookie = continue_invitation(&recipient, &base, &token).await;

    let declined = recipient
        .post(format!("{base}/api/v1/invitations/current/decline"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&recipient_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(declined.status(), 200);
    assert_clears_invitation_cookie(&declined);
    assert!(continuation_record(&continuation_cookie).await.is_none());
    let db = test_db().await;
    let invitation = sqlx::query!(
        "SELECT status, token_hash, accepted_at FROM form_invitations WHERE id = $1",
        invitation_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(invitation.status, "revoked");
    assert!(invitation.token_hash.is_none());
    assert!(invitation.accepted_at.is_none());
    let member_exists = sqlx::query_scalar!(
        "SELECT EXISTS(
            SELECT 1 FROM form_members WHERE form_id = $1 AND user_id = $2
         )",
        form_id,
        recipient_id,
    )
    .fetch_one(&db)
    .await
    .unwrap()
    .unwrap_or(false);
    assert!(!member_exists);
}

#[tokio::test]
async fn invitation_concurrency_accept_and_owner_revoke_follow_form_first_lock_order() {
    let base = common::base_url();

    for iteration in 0..5 {
        let (owner, _, _, _) =
            register_invitation_user(&base, &format!("race-owner-{iteration}")).await;
        let (recipient, recipient_id, recipient_email, recipient_session) =
            register_invitation_user(&base, &format!("race-recipient-{iteration}")).await;
        let form_id = create_test_form(&owner, &base, &format!("decision-race-{iteration}")).await;
        let (invitation_id, token) =
            insert_acceptance_invitation(form_id, recipient_id, &recipient_email, "editor", true)
                .await;
        let continuation_cookie = continue_invitation(&recipient, &base, &token).await;
        let cookie_header = invitation_cookie_header(&recipient_session, &continuation_cookie);

        let db = test_db().await;
        let mut blocker = db.begin().await.unwrap();
        sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id)
            .fetch_one(&mut *blocker)
            .await
            .unwrap();

        let revoke_url = format!("{base}/api/v1/forms/{form_id}/invitations/{invitation_id}");
        let owner_request =
            tokio::spawn(async move { owner.delete(revoke_url).send().await.unwrap() });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let accept_url = format!("{base}/api/v1/invitations/current/accept");
        let recipient_request = tokio::spawn(async move {
            recipient
                .post(accept_url)
                .header(reqwest::header::COOKIE, cookie_header)
                .send()
                .await
                .unwrap()
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        blocker.commit().await.unwrap();

        let revoke = owner_request.await.unwrap();
        let accept = recipient_request.await.unwrap();
        let mut statuses = [revoke.status().as_u16(), accept.status().as_u16()];
        statuses.sort_unstable();
        assert_eq!(statuses, [200, 404]);
        let loser = if revoke.status() == 404 {
            revoke
        } else {
            accept
        };
        assert_generic_not_found(loser).await;

        let invitation = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations WHERE id = $1",
            invitation_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(matches!(invitation.status.as_str(), "accepted" | "revoked"));
        assert!(invitation.token_hash.is_none());
        let member_count: i64 = sqlx::query_scalar!(
            "SELECT count(*) FROM form_members WHERE form_id = $1 AND user_id = $2",
            form_id,
            recipient_id,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0);
        assert_eq!(
            member_count,
            if invitation.status == "accepted" {
                1
            } else {
                0
            }
        );
    }
}

async fn membership_id(form_id: Uuid, user_id: Uuid) -> Uuid {
    let db = test_db().await;
    sqlx::query_scalar!(
        "SELECT id FROM form_members WHERE form_id = $1 AND user_id = $2",
        form_id,
        user_id,
    )
    .fetch_one(&db)
    .await
    .unwrap()
}

async fn insert_pending_collaboration_invitation(
    form_id: Uuid,
    recipient_user_id: Uuid,
    invited_email: &str,
    role: &str,
) -> Uuid {
    let db = test_db().await;
    let invitation_id = Uuid::now_v7();
    let token_hash = format!("pending-collaboration-{}", Uuid::now_v7());
    sqlx::query!(
        "INSERT INTO form_invitations (
            id, form_id, invited_email, role, status, token_hash,
            recipient_user_id, expires_at
         ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, now() + interval '1 day')",
        invitation_id,
        form_id,
        invited_email,
        role,
        token_hash,
        recipient_user_id,
    )
    .execute(&db)
    .await
    .unwrap();
    invitation_id
}

async fn set_account_sharing_key(user_id: Uuid, public_key: &str, wrapped_private_key: &str) {
    let db = test_db().await;
    sqlx::query!(
        "UPDATE users
         SET sharing_public_key = $1, wrapped_sharing_private_key = $2,
             sharing_key_version = 1, sharing_key_created_at = now()
         WHERE id = $3",
        public_key,
        wrapped_private_key,
        user_id,
    )
    .execute(&db)
    .await
    .unwrap();
}

async fn assert_ciphertext_reads_not_found(
    client: &Client,
    base: &str,
    form_id: Uuid,
    attachment_id: &str,
) {
    for response in [
        client
            .get(format!("{base}/api/v1/forms/{form_id}"))
            .send()
            .await
            .unwrap(),
        client
            .get(format!("{base}/api/v1/forms/{form_id}/responses"))
            .send()
            .await
            .unwrap(),
        client
            .get(format!(
                "{base}/api/v1/forms/{form_id}/attachments/{attachment_id}"
            ))
            .send()
            .await
            .unwrap(),
    ] {
        assert_generic_not_found(response).await;
    }
}

#[tokio::test]
async fn inaccessible_membership_lifecycle_states_reject_all_ciphertext_reads() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "read-owner").await;
    let (awaiting, awaiting_id, _, _) = register_invitation_user(&base, "read-awaiting").await;
    let (removed, removed_id, _, _) = register_invitation_user(&base, "read-removed").await;
    let (unaccepted, unaccepted_id, unaccepted_email, _) =
        register_invitation_user(&base, "read-unaccepted").await;
    let (expired, expired_id, expired_email, _) =
        register_invitation_user(&base, "read-expired").await;
    let (revoked, revoked_id, revoked_email, _) =
        register_invitation_user(&base, "read-revoked").await;
    let form_id = create_test_form(&owner, &base, "read-lifecycle").await;
    insert_membership(form_id, awaiting_id, "viewer", "awaiting_keys").await;
    insert_membership(form_id, removed_id, "editor", "active").await;
    let removed_member_id = membership_id(form_id, removed_id).await;

    let response = Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "opaque-response" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let upload = Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![17_u8, 23, 29])
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 200);
    let attachment_id = upload.json::<serde_json::Value>().await.unwrap()["data"]["attachment_id"]
        .as_str()
        .unwrap()
        .to_string();

    let unaccepted_invitation = insert_pending_collaboration_invitation(
        form_id,
        unaccepted_id,
        &unaccepted_email,
        "viewer",
    )
    .await;
    let expired_invitation =
        insert_pending_collaboration_invitation(form_id, expired_id, &expired_email, "viewer")
            .await;
    let revoked_invitation =
        insert_pending_collaboration_invitation(form_id, revoked_id, &revoked_email, "editor")
            .await;
    let db = test_db().await;
    sqlx::query!(
        "UPDATE form_invitations
         SET status = 'expired', token_hash = NULL, expires_at = now() - interval '1 second'
         WHERE id = $1",
        expired_invitation,
    )
    .execute(&db)
    .await
    .unwrap();
    sqlx::query!(
        "UPDATE form_invitations SET status = 'revoked', token_hash = NULL WHERE id = $1",
        revoked_invitation,
    )
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar!(
            "SELECT count(*) FROM form_invitations WHERE id = $1 AND status = 'pending'",
            unaccepted_invitation,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0),
        1
    );

    let remove = owner
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/members/{removed_member_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(remove.status(), 200);

    for client in [&awaiting, &removed, &unaccepted, &expired, &revoked] {
        assert_ciphertext_reads_not_found(client, &base, form_id, &attachment_id).await;
    }
}

#[tokio::test]
async fn collaborator_lifecycle_owner_controls_metadata_roles_removal_leaving_and_deletion() {
    let base = common::base_url();
    let (owner, owner_id, owner_email, _) =
        register_invitation_user(&base, "lifecycle-owner").await;
    let (editor, editor_id, editor_email, _) =
        register_invitation_user(&base, "lifecycle-editor").await;
    let (leaving_editor, leaving_editor_id, leaving_editor_email, _) =
        register_invitation_user(&base, "leave-editor").await;
    let (viewer, viewer_id, viewer_email, _) =
        register_invitation_user(&base, "lifecycle-viewer").await;
    let (awaiting, awaiting_id, awaiting_email, _) =
        register_invitation_user(&base, "lifecycle-awaiting").await;
    let (leaving_awaiting, leaving_awaiting_id, leaving_awaiting_email, _) =
        register_invitation_user(&base, "leave-awaiting").await;
    let (_, pending_id, pending_email, _) =
        register_invitation_user(&base, "lifecycle-pending").await;
    let (unrelated, _, _, _) = register_invitation_user(&base, "lifecycle-unrelated").await;

    let form_id = create_test_form(&owner, &base, "collaborator-lifecycle").await;
    insert_membership(form_id, editor_id, "editor", "active").await;
    insert_membership(form_id, leaving_editor_id, "editor", "active").await;
    insert_membership(form_id, viewer_id, "viewer", "active").await;
    insert_membership(form_id, awaiting_id, "viewer", "awaiting_keys").await;
    insert_membership(form_id, leaving_awaiting_id, "editor", "awaiting_keys").await;
    let invitation_id =
        insert_pending_collaboration_invitation(form_id, pending_id, &pending_email, "editor")
            .await;
    let owner_member_id = membership_id(form_id, owner_id).await;
    let editor_member_id = membership_id(form_id, editor_id).await;
    let leaving_editor_member_id = membership_id(form_id, leaving_editor_id).await;
    let viewer_member_id = membership_id(form_id, viewer_id).await;
    let awaiting_member_id = membership_id(form_id, awaiting_id).await;
    let leaving_awaiting_member_id = membership_id(form_id, leaving_awaiting_id).await;

    let collaboration = owner
        .get(format!("{base}/api/v1/forms/{form_id}/collaboration"))
        .send()
        .await
        .unwrap();
    assert_eq!(collaboration.status(), 200);
    let collaboration_body: serde_json::Value = collaboration.json().await.unwrap();
    let members = collaboration_body["data"]["members"].as_array().unwrap();
    for (member_id, email, role, state) in [
        (owner_member_id, owner_email.as_str(), "owner", "active"),
        (editor_member_id, editor_email.as_str(), "editor", "active"),
        (
            leaving_editor_member_id,
            leaving_editor_email.as_str(),
            "editor",
            "active",
        ),
        (viewer_member_id, viewer_email.as_str(), "viewer", "active"),
        (
            awaiting_member_id,
            awaiting_email.as_str(),
            "viewer",
            "awaiting_keys",
        ),
        (
            leaving_awaiting_member_id,
            leaving_awaiting_email.as_str(),
            "editor",
            "awaiting_keys",
        ),
    ] {
        let member = members
            .iter()
            .find(|item| item["id"] == member_id.to_string())
            .expect("owner collaboration list omitted a member");
        assert_eq!(member["email"], email);
        assert_eq!(member["role"], role);
        assert_eq!(member["state"], state);
    }
    let invitations = collaboration_body["data"]["invitations"]
        .as_array()
        .unwrap();
    let pending = invitations
        .iter()
        .find(|item| item["id"] == invitation_id.to_string())
        .expect("owner collaboration list omitted a pending invitation");
    assert_eq!(pending["invited_email"], pending_email);
    assert_eq!(pending["role"], "editor");
    assert_eq!(pending["status"], "pending");
    assert!(pending["expires_at"].as_str().is_some());
    let serialized = serde_json::to_string(&collaboration_body).unwrap();
    assert!(!serialized.contains("encrypted_form_data_key"));
    assert!(!serialized.contains("encrypted_form_private_key"));
    assert!(!serialized.contains("wrapped_sharing_private_key"));
    assert!(!serialized.contains("token_hash"));

    for client in [
        &editor,
        &leaving_editor,
        &viewer,
        &awaiting,
        &leaving_awaiting,
        &unrelated,
    ] {
        assert_generic_not_found(
            client
                .get(format!("{base}/api/v1/forms/{form_id}/collaboration"))
                .send()
                .await
                .unwrap(),
        )
        .await;
    }

    let db = test_db().await;
    let before_grant = sqlx::query!(
        "SELECT encrypted_form_data_key, encrypted_form_private_key
         FROM form_members WHERE id = $1",
        editor_member_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let demote = owner
        .patch(format!(
            "{base}/api/v1/forms/{form_id}/members/{editor_member_id}"
        ))
        .json(&json!({ "role": "viewer" }))
        .send()
        .await
        .unwrap();
    assert_eq!(demote.status(), 200);
    let promote = owner
        .patch(format!(
            "{base}/api/v1/forms/{form_id}/members/{editor_member_id}"
        ))
        .json(&json!({ "role": "editor" }))
        .send()
        .await
        .unwrap();
    assert_eq!(promote.status(), 200);
    let after_grant = sqlx::query!(
        "SELECT role, encrypted_form_data_key, encrypted_form_private_key
         FROM form_members WHERE id = $1",
        editor_member_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(after_grant.role, "editor");
    assert_eq!(
        after_grant.encrypted_form_data_key,
        before_grant.encrypted_form_data_key
    );
    assert_eq!(
        after_grant.encrypted_form_private_key,
        before_grant.encrypted_form_private_key
    );
    for (target_member_id, expected_role) in
        [(editor_member_id, "editor"), (viewer_member_id, "viewer")]
    {
        let before = sqlx::query!(
            "SELECT role, encrypted_form_data_key, encrypted_form_private_key
             FROM form_members WHERE id = $1",
            target_member_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let rejected = owner
            .patch(format!(
                "{base}/api/v1/forms/{form_id}/members/{target_member_id}"
            ))
            .json(&json!({ "role": "owner" }))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), 400);
        let rejection_body: serde_json::Value = rejected.json().await.unwrap();
        assert_eq!(rejection_body["error"]["code"], "bad_request");
        assert_eq!(rejection_body["error"]["message"], "Invalid request");
        let after = sqlx::query!(
            "SELECT role, encrypted_form_data_key, encrypted_form_private_key
             FROM form_members WHERE id = $1",
            target_member_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(after.role, expected_role);
        assert_eq!(after.role, before.role);
        assert_eq!(
            after.encrypted_form_data_key,
            before.encrypted_form_data_key
        );
        assert_eq!(
            after.encrypted_form_private_key,
            before.encrypted_form_private_key
        );
    }
    assert_generic_not_found(
        owner
            .patch(format!(
                "{base}/api/v1/forms/{form_id}/members/{owner_member_id}"
            ))
            .json(&json!({ "role": "viewer" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_generic_not_found(
        editor
            .patch(format!(
                "{base}/api/v1/forms/{form_id}/members/{editor_member_id}"
            ))
            .json(&json!({ "role": "viewer" }))
            .send()
            .await
            .unwrap(),
    )
    .await;

    for client in [&editor, &viewer] {
        assert_generic_not_found(
            client
                .delete(format!("{base}/api/v1/forms/{form_id}"))
                .send()
                .await
                .unwrap(),
        )
        .await;
    }
    assert!(
        sqlx::query_scalar!(
            "SELECT accepting_responses FROM forms WHERE id = $1",
            form_id
        )
        .fetch_one(&db)
        .await
        .unwrap()
    );
    assert_generic_not_found(
        owner
            .delete(format!(
                "{base}/api/v1/forms/{form_id}/members/{owner_member_id}"
            ))
            .send()
            .await
            .unwrap(),
    )
    .await;

    let remove_editor = owner
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/members/{editor_member_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(remove_editor.status(), 200);
    assert_generic_not_found(
        editor
            .get(format!("{base}/api/v1/forms/{form_id}"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let remove_awaiting = owner
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/members/{awaiting_member_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(remove_awaiting.status(), 200);
    assert_eq!(
        sqlx::query_scalar!(
            "SELECT count(*) FROM form_members WHERE id = $1",
            awaiting_member_id
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0),
        0
    );
    assert_generic_not_found(
        awaiting
            .delete(format!("{base}/api/v1/forms/{form_id}/members/me"))
            .send()
            .await
            .unwrap(),
    )
    .await;

    for (client, member_id) in [
        (&leaving_editor, leaving_editor_member_id),
        (&leaving_awaiting, leaving_awaiting_member_id),
    ] {
        assert_eq!(
            sqlx::query_scalar!("SELECT count(*) FROM form_members WHERE id = $1", member_id)
                .fetch_one(&db)
                .await
                .unwrap()
                .unwrap_or(0),
            1
        );
        let leave = client
            .delete(format!("{base}/api/v1/forms/{form_id}/members/me"))
            .send()
            .await
            .unwrap();
        assert_eq!(leave.status(), 200);
        assert_eq!(
            sqlx::query_scalar!("SELECT count(*) FROM form_members WHERE id = $1", member_id)
                .fetch_one(&db)
                .await
                .unwrap()
                .unwrap_or(0),
            0
        );
    }

    let leave = viewer
        .delete(format!("{base}/api/v1/forms/{form_id}/members/me"))
        .send()
        .await
        .unwrap();
    assert_eq!(leave.status(), 200);
    assert_generic_not_found(
        viewer
            .get(format!("{base}/api/v1/forms/{form_id}"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_generic_not_found(
        owner
            .delete(format!("{base}/api/v1/forms/{form_id}/members/me"))
            .send()
            .await
            .unwrap(),
    )
    .await;

    assert_generic_not_found(
        editor
            .delete(format!("{base}/api/v1/forms/{form_id}"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_generic_not_found(
        unrelated
            .delete(format!("{base}/api/v1/forms/{form_id}"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let delete = owner
        .delete(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(delete.status(), 200);
    assert_eq!(
        sqlx::query_scalar!("SELECT count(*) FROM forms WHERE id = $1", form_id)
            .fetch_one(&db)
            .await
            .unwrap()
            .unwrap_or(0),
        0
    );
}

#[tokio::test]
async fn ownership_transfer_requires_an_active_collaborator_and_changes_both_roles_atomically() {
    let base = common::base_url();
    let (owner, owner_id, _, _) = register_invitation_user(&base, "transfer-owner").await;
    let (editor, editor_id, _, _) = register_invitation_user(&base, "transfer-editor").await;
    let (_, awaiting_id, _, _) = register_invitation_user(&base, "transfer-awaiting").await;
    let (_, pending_user_id, pending_email, _) =
        register_invitation_user(&base, "transfer-pending").await;
    let (_, _, _, _) = register_invitation_user(&base, "transfer-unrelated").await;
    let form_id = create_test_form(&owner, &base, "ownership-transfer").await;
    insert_membership(form_id, editor_id, "editor", "active").await;
    insert_membership(form_id, awaiting_id, "viewer", "awaiting_keys").await;
    let editor_member_id = membership_id(form_id, editor_id).await;
    let awaiting_member_id = membership_id(form_id, awaiting_id).await;
    let pending_invitation_id =
        insert_pending_collaboration_invitation(form_id, pending_user_id, &pending_email, "viewer")
            .await;

    for member_id in [awaiting_member_id, pending_invitation_id, Uuid::now_v7()] {
        assert_generic_not_found(
            owner
                .post(format!("{base}/api/v1/forms/{form_id}/transfer-ownership"))
                .json(&json!({ "member_id": member_id }))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let db = test_db().await;
        let unchanged_owner = sqlx::query_scalar!(
            "SELECT user_id FROM form_members WHERE form_id = $1 AND role = 'owner'",
            form_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unchanged_owner, owner_id);
    }

    let transfer = owner
        .post(format!("{base}/api/v1/forms/{form_id}/transfer-ownership"))
        .json(&json!({ "member_id": editor_member_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(transfer.status(), 200);
    let db = test_db().await;
    let roles = sqlx::query!(
        "SELECT user_id, role FROM form_members
         WHERE form_id = $1 AND user_id IN ($2, $3)",
        form_id,
        owner_id,
        editor_id,
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert!(
        roles
            .iter()
            .any(|row| row.user_id == owner_id && row.role == "editor")
    );
    assert!(
        roles
            .iter()
            .any(|row| row.user_id == editor_id && row.role == "owner")
    );
    assert_eq!(roles.iter().filter(|row| row.role == "owner").count(), 1);
    assert_generic_not_found(
        owner
            .get(format!("{base}/api/v1/forms/{form_id}/collaboration"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        editor
            .get(format!("{base}/api/v1/forms/{form_id}/collaboration"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn admin_transfer_accepts_only_existing_active_editors_and_moves_usage_atomically() {
    let base = common::base_url();
    let (admin, admin_id, _, admin_session_token) =
        register_invitation_user(&base, "admin-transfer-admin").await;
    promote_manual_user_to_admin(admin_id).await;
    let _demote = DemoteAdminOnDrop(admin_id);
    set_manual_session_totp_verified(&admin_session_token, admin_id).await;

    let (owner, owner_id, _, _) = register_invitation_user(&base, "admin-transfer-owner").await;
    let (_, editor_id, _, _) = register_invitation_user(&base, "admin-transfer-editor").await;
    let (_, viewer_id, _, _) = register_invitation_user(&base, "admin-transfer-viewer").await;
    let (_, awaiting_editor_id, _, _) =
        register_invitation_user(&base, "admin-transfer-awaiting-editor").await;

    set_account_quota(owner_id, 2, 32).await;
    set_account_quota(editor_id, 2, 32).await;

    let form_id = create_test_form(&owner, &base, "admin-transfer").await;
    insert_membership(form_id, editor_id, "editor", "active").await;
    insert_membership(form_id, viewer_id, "viewer", "active").await;
    insert_membership(form_id, awaiting_editor_id, "editor", "awaiting_keys").await;
    let editor_member_id = membership_id(form_id, editor_id).await;
    let viewer_member_id = membership_id(form_id, viewer_id).await;
    let awaiting_member_id = membership_id(form_id, awaiting_editor_id).await;

    let upload = upload_attachment(&base, form_id, vec![4_u8, 5, 6]).await;
    assert_eq!(upload.status(), 200);
    assert_eq!(fetch_account_usage(owner_id).await, (1, 3));

    for member_id in [viewer_member_id, awaiting_member_id, Uuid::now_v7()] {
        assert_generic_not_found(
            admin
                .post(format!("{base}/api/v1/admin/forms/{form_id}/transfer"))
                .json(&json!({ "member_id": member_id }))
                .send()
                .await
                .unwrap(),
        )
        .await;
    }

    let rejected_before = count_audit_events("form_transferred", "rejected").await;
    let succeeded_before = count_audit_events("form_transferred", "succeeded").await;

    let transfer = admin
        .post(format!("{base}/api/v1/admin/forms/{form_id}/transfer"))
        .json(&json!({ "member_id": editor_member_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(transfer.status(), 200);

    let db = test_db().await;
    let roles = sqlx::query!(
        "SELECT user_id, role, encrypted_form_data_key, encrypted_form_private_key
         FROM form_members
         WHERE form_id = $1 AND user_id IN ($2, $3)",
        form_id,
        owner_id,
        editor_id,
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert!(roles.iter().any(|row| row.user_id == owner_id
        && row.role == "editor"
        && row.encrypted_form_data_key.as_deref() == Some("admin-transfer-data-key")
        && row.encrypted_form_private_key.as_deref() == Some("admin-transfer-private-key")));
    assert!(roles.iter().any(|row| row.user_id == editor_id
        && row.role == "owner"
        && row.encrypted_form_data_key.as_deref() == Some("editor-data-key")
        && row.encrypted_form_private_key.as_deref() == Some("editor-private-key")));
    assert_eq!(fetch_account_usage(owner_id).await, (0, 0));
    assert_eq!(fetch_account_usage(editor_id).await, (1, 3));
    assert_eq!(
        count_audit_events("form_transferred", "rejected").await,
        rejected_before
    );
    assert_eq!(
        count_audit_events("form_transferred", "succeeded").await,
        succeeded_before + 1
    );
}

#[tokio::test]
async fn ownership_transfer_simultaneous_requests_leave_exactly_one_owner() {
    let base = common::base_url();
    let (owner, owner_id, _, _) = register_invitation_user(&base, "transfer-race-owner").await;
    let (_, editor_id, _, _) = register_invitation_user(&base, "transfer-race-editor").await;
    let (_, viewer_id, _, _) = register_invitation_user(&base, "transfer-race-viewer").await;
    let form_id = create_test_form(&owner, &base, "ownership-transfer-race").await;
    insert_membership(form_id, editor_id, "editor", "active").await;
    insert_membership(form_id, viewer_id, "viewer", "active").await;
    let editor_member_id = membership_id(form_id, editor_id).await;
    let viewer_member_id = membership_id(form_id, viewer_id).await;
    let first_owner = owner.clone();
    let second_owner = owner.clone();
    let first_url = format!("{base}/api/v1/forms/{form_id}/transfer-ownership");
    let second_url = first_url.clone();

    let db = test_db().await;
    let mut blocker = db.begin().await.unwrap();
    let blocker_backend_pid = sqlx::query_scalar!(r#"SELECT pg_backend_pid() AS "pid!""#)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let first = tokio::spawn(async move {
        first_owner
            .post(first_url)
            .json(&json!({ "member_id": editor_member_id }))
            .send()
            .await
            .unwrap()
    });
    let second = tokio::spawn(async move {
        second_owner
            .post(second_url)
            .json(&json!({ "member_id": viewer_member_id }))
            .send()
            .await
            .unwrap()
    });
    wait_for_blocked_requests(&db, blocker_backend_pid, 2).await;
    blocker.commit().await.unwrap();
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    let mut statuses = [first.status().as_u16(), second.status().as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 404]);
    let owners = sqlx::query_scalar!(
        "SELECT user_id FROM form_members WHERE form_id = $1 AND role = 'owner'",
        form_id,
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(owners.len(), 1);
    assert!(owners[0] == editor_id || owners[0] == viewer_id);
    let former_owner_role = sqlx::query_scalar!(
        "SELECT role FROM form_members WHERE form_id = $1 AND user_id = $2",
        form_id,
        owner_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(former_owner_role, "editor");
}

#[tokio::test]
async fn ownership_transfer_moves_form_and_attachment_usage_to_the_new_owner() {
    let base = common::base_url();
    let (owner, owner_id, _, _) = register_invitation_user(&base, "transfer-usage-owner").await;
    let (editor, editor_id, _, _) = register_invitation_user(&base, "transfer-usage-editor").await;
    set_account_quota(owner_id, 2, 32).await;
    set_account_quota(editor_id, 2, 32).await;

    let form_id = create_test_form(&owner, &base, "ownership-transfer-usage").await;
    insert_membership(form_id, editor_id, "editor", "active").await;
    let editor_member_id = membership_id(form_id, editor_id).await;

    let upload = upload_attachment(&base, form_id, vec![7_u8, 8, 9]).await;
    assert_eq!(upload.status(), 200);
    assert_eq!(fetch_account_usage(owner_id).await, (1, 3));

    let transfer = owner
        .post(format!("{base}/api/v1/forms/{form_id}/transfer-ownership"))
        .json(&json!({ "member_id": editor_member_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(transfer.status(), 200);
    assert_eq!(fetch_account_usage(owner_id).await, (0, 0));
    assert_eq!(fetch_account_usage(editor_id).await, (1, 3));

    let owner_new_form = create_test_form(&owner, &base, "ownership-transfer-freed-owner").await;
    assert_eq!(fetch_account_usage(owner_id).await, (1, 0));

    let delete = editor
        .delete(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(delete.status(), 200);
    assert_eq!(fetch_account_usage(editor_id).await, (0, 0));
    assert_eq!(fetch_account_usage(owner_id).await, (1, 0));

    let delete_new_form = owner
        .delete(format!("{base}/api/v1/forms/{owner_new_form}"))
        .send()
        .await
        .unwrap();
    assert_eq!(delete_new_form.status(), 200);
    assert_eq!(fetch_account_usage(owner_id).await, (0, 0));
}

#[tokio::test]
async fn ownership_transfer_rejects_when_target_owner_cannot_absorb_attachment_usage() {
    let base = common::base_url();
    let (owner, owner_id, _, _) = register_invitation_user(&base, "transfer-quota-owner").await;
    let (_, editor_id, _, _) = register_invitation_user(&base, "transfer-quota-editor").await;
    set_account_quota(owner_id, 2, 32).await;
    set_account_quota(editor_id, 2, 2).await;

    let form_id = create_test_form(&owner, &base, "ownership-transfer-byte-limit").await;
    insert_membership(form_id, editor_id, "editor", "active").await;
    let editor_member_id = membership_id(form_id, editor_id).await;

    let upload = upload_attachment(&base, form_id, vec![1_u8, 2, 3]).await;
    assert_eq!(upload.status(), 200);
    assert_eq!(fetch_account_usage(owner_id).await, (1, 3));

    let transfer = owner
        .post(format!("{base}/api/v1/forms/{form_id}/transfer-ownership"))
        .json(&json!({ "member_id": editor_member_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(transfer.status(), 429);
    let transfer_body: serde_json::Value = transfer.json().await.unwrap();
    assert_eq!(transfer_body["error"]["code"], "rate_limited");

    let db = test_db().await;
    let roles = sqlx::query!(
        "SELECT user_id, role FROM form_members
         WHERE form_id = $1 AND user_id IN ($2, $3)",
        form_id,
        owner_id,
        editor_id,
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert!(
        roles
            .iter()
            .any(|row| row.user_id == owner_id && row.role == "owner")
    );
    assert!(
        roles
            .iter()
            .any(|row| row.user_id == editor_id && row.role == "editor")
    );
    assert_eq!(fetch_account_usage(owner_id).await, (1, 3));
    assert_eq!(fetch_account_usage(editor_id).await, (0, 0));
}

#[tokio::test]
async fn secure_provisioning_lists_only_current_owner_work_and_activates_idempotently() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "provision-owner").await;
    let (recipient, recipient_id, recipient_email, _) =
        register_invitation_user(&base, "prov-recipient").await;
    let (_, no_key_id, _, _) = register_invitation_user(&base, "provision-no-key").await;
    let (other_owner, _, _, _) = register_invitation_user(&base, "provision-other-owner").await;
    let (_, other_recipient_id, _, _) =
        register_invitation_user(&base, "provision-other-recipient").await;
    let form_id = create_test_form(&owner, &base, "secure-provisioning").await;
    let other_form_id = create_test_form(&other_owner, &base, "other-provisioning").await;
    insert_membership(form_id, recipient_id, "editor", "awaiting_keys").await;
    insert_membership(form_id, no_key_id, "viewer", "awaiting_keys").await;
    insert_membership(other_form_id, other_recipient_id, "viewer", "awaiting_keys").await;
    let member_id = membership_id(form_id, recipient_id).await;
    let recipient_public_key = sharing_public_key(31);
    let wrapped_account_private_key =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([41_u8; 72]);
    set_account_sharing_key(
        recipient_id,
        &recipient_public_key,
        &wrapped_account_private_key,
    )
    .await;
    set_account_sharing_key(
        other_recipient_id,
        &sharing_public_key(32),
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([42_u8; 72]),
    )
    .await;

    let list = owner
        .get(format!("{base}/api/v1/sharing/provisioning"))
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), 200);
    let list_body: serde_json::Value = list.json().await.unwrap();
    let items = list_body["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item["form_id"], form_id.to_string());
    assert_eq!(item["member_id"], member_id.to_string());
    assert_eq!(item["recipient_sharing_public_key"], recipient_public_key);
    assert_eq!(item["owner_key_scheme"], "master_wrap_v1");
    assert_eq!(
        item["owner_encrypted_form_data_key"],
        "secure-provisioning-data-key"
    );
    assert_eq!(
        item["owner_encrypted_form_private_key"],
        "secure-provisioning-private-key"
    );
    let serialized = serde_json::to_string(&list_body).unwrap();
    assert!(!serialized.contains("wrapped_sharing_private_key"));
    assert!(!serialized.contains(&wrapped_account_private_key));
    assert!(!serialized.contains(&recipient_email));

    let before_mail = common::delivery_count_for(&recipient_email).await;
    let grant = json!({
        "recipient_sharing_public_key": recipient_public_key,
        "encrypted_form_data_key": "sealed-recipient-data-key",
        "encrypted_form_private_key": "sealed-recipient-private-key",
    });
    let activate = owner
        .put(format!(
            "{base}/api/v1/forms/{form_id}/members/{member_id}/key-grant"
        ))
        .json(&grant)
        .send()
        .await
        .unwrap();
    assert_eq!(activate.status(), 200);
    let activate_body: serde_json::Value = activate.json().await.unwrap();
    assert_eq!(activate_body["data"]["membership_state"], "active");
    let db = test_db().await;
    let stored = sqlx::query!(
        "SELECT state, key_scheme, encrypted_form_data_key, encrypted_form_private_key
         FROM form_members WHERE id = $1",
        member_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(stored.state, "active");
    assert_eq!(stored.key_scheme.as_deref(), Some("account_sealed_box_v1"));
    assert_eq!(
        stored.encrypted_form_data_key.as_deref(),
        Some("sealed-recipient-data-key")
    );
    assert_eq!(
        stored.encrypted_form_private_key.as_deref(),
        Some("sealed-recipient-private-key")
    );
    assert_eq!(
        common::delivery_count_for(&recipient_email).await,
        before_mail + 1
    );
    let readiness_mail = latest_mail_content_for(&recipient_email).await;
    assert!(!readiness_mail.contains("secure-provisioning-title"));
    assert_eq!(
        recipient
            .get(format!("{base}/api/v1/forms/{form_id}"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    let retry = owner
        .put(format!(
            "{base}/api/v1/forms/{form_id}/members/{member_id}/key-grant"
        ))
        .json(&grant)
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), 200);
    assert_eq!(
        common::delivery_count_for(&recipient_email).await,
        before_mail + 1
    );
    let empty = owner
        .get(format!("{base}/api/v1/sharing/provisioning"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert!(empty["data"]["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn secure_provisioning_rejects_stale_or_incomplete_grants_without_activation() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "provision-validation-owner").await;
    let (_, recipient_id, _, _) =
        register_invitation_user(&base, "provision-validation-recipient").await;
    let form_id = create_test_form(&owner, &base, "provision-validation").await;
    insert_membership(form_id, recipient_id, "viewer", "awaiting_keys").await;
    let member_id = membership_id(form_id, recipient_id).await;
    let public_key = sharing_public_key(51);
    set_account_sharing_key(
        recipient_id,
        &public_key,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([52_u8; 72]),
    )
    .await;

    let incomplete = owner
        .put(format!(
            "{base}/api/v1/forms/{form_id}/members/{member_id}/key-grant"
        ))
        .json(&json!({
            "recipient_sharing_public_key": public_key,
            "encrypted_form_data_key": "sealed-data-only",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(incomplete.status(), 400);
    assert_generic_not_found(
        owner
            .put(format!(
                "{base}/api/v1/forms/{form_id}/members/{member_id}/key-grant"
            ))
            .json(&json!({
                "recipient_sharing_public_key": sharing_public_key(53),
                "encrypted_form_data_key": "sealed-data",
                "encrypted_form_private_key": "sealed-private",
            }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let db = test_db().await;
    let state = sqlx::query_scalar!("SELECT state FROM form_members WHERE id = $1", member_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(state, "awaiting_keys");
}

#[tokio::test]
async fn secure_provisioning_removal_race_never_recreates_membership() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "provision-race-owner").await;
    let (_, recipient_id, _, _) = register_invitation_user(&base, "provision-race-recipient").await;
    let form_id = create_test_form(&owner, &base, "provision-removal-race").await;
    insert_membership(form_id, recipient_id, "viewer", "awaiting_keys").await;
    let member_id = membership_id(form_id, recipient_id).await;
    let public_key = sharing_public_key(61);
    set_account_sharing_key(
        recipient_id,
        &public_key,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([62_u8; 72]),
    )
    .await;
    let removing_owner = owner.clone();
    let provisioning_owner = owner.clone();
    let remove_url = format!("{base}/api/v1/forms/{form_id}/members/{member_id}");
    let provision_url = format!("{remove_url}/key-grant");

    let db = test_db().await;
    let mut blocker = db.begin().await.unwrap();
    let blocker_backend_pid = sqlx::query_scalar!(r#"SELECT pg_backend_pid() AS "pid!""#)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let remove =
        tokio::spawn(async move { removing_owner.delete(remove_url).send().await.unwrap() });
    let provision = tokio::spawn(async move {
        provisioning_owner
            .put(provision_url)
            .json(&json!({
                "recipient_sharing_public_key": public_key,
                "encrypted_form_data_key": "race-sealed-data",
                "encrypted_form_private_key": "race-sealed-private",
            }))
            .send()
            .await
            .unwrap()
    });
    wait_for_blocked_requests(&db, blocker_backend_pid, 2).await;
    blocker.commit().await.unwrap();
    let remove = remove.await.unwrap();
    let provision = provision.await.unwrap();
    assert_eq!(remove.status(), 200);
    assert!(matches!(provision.status().as_u16(), 200 | 404));
    let count = sqlx::query_scalar!("SELECT count(*) FROM form_members WHERE id = $1", member_id)
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(count, 0);
}

#[tokio::test]
async fn viewer_cannot_delete_a_response() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "delete-response-owner").await;
    let (viewer, viewer_id, viewer_email, viewer_session) =
        register_invitation_user(&base, "delete-response-viewer").await;
    let form_id = create_test_form(&owner, &base, "delete-response-viewer-form").await;
    let (_invitation_id, token) = insert_acceptance_invitation(
        form_id,
        viewer_id,
        &viewer_email.to_uppercase(),
        "viewer",
        true,
    )
    .await;

    let continuation_cookie = continue_invitation(&viewer, &base, &token).await;
    let accepted = viewer
        .post(format!("{base}/api/v1/invitations/current/accept"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&viewer_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);

    let submitted: serde_json::Value = owner
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response_id = submitted["data"]["id"].as_str().unwrap().to_string();

    let deleted = viewer
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/responses/{response_id}"
        ))
        .json(&json!({ "attachment_ids": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), reqwest::StatusCode::NOT_FOUND);

    let listed: serde_json::Value = owner
        .get(format!("{base}/api/v1/forms/{form_id}/responses"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        listed["data"]["responses"].as_array().unwrap().len(),
        1,
        "a Viewer's rejected delete must not remove the response",
    );
}

#[tokio::test]
async fn editor_can_delete_a_response() {
    let base = common::base_url();
    let (owner, _, _, _) = register_invitation_user(&base, "delete-response-editor-owner").await;
    let (editor, editor_id, editor_email, editor_session) =
        register_invitation_user(&base, "delete-response-editor").await;
    let form_id = create_test_form(&owner, &base, "delete-response-editor-form").await;
    let (_invitation_id, token) = insert_acceptance_invitation(
        form_id,
        editor_id,
        &editor_email.to_uppercase(),
        "editor",
        true,
    )
    .await;

    let continuation_cookie = continue_invitation(&editor, &base, &token).await;
    let accepted = editor
        .post(format!("{base}/api/v1/invitations/current/accept"))
        .header(
            reqwest::header::COOKIE,
            invitation_cookie_header(&editor_session, &continuation_cookie),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);

    let submitted: serde_json::Value = owner
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response_id = submitted["data"]["id"].as_str().unwrap().to_string();

    let deleted = editor
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/responses/{response_id}"
        ))
        .json(&json!({ "attachment_ids": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);

    let listed: serde_json::Value = owner
        .get(format!("{base}/api/v1/forms/{form_id}/responses"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        listed["data"]["responses"].as_array().unwrap().len(),
        0,
        "an Editor's delete must remove the response",
    );
}
