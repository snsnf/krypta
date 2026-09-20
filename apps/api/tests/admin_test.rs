mod common;

use argon2::{Algorithm, Argon2, Params, PasswordHasher, Version};
use password_hash::{SaltString, rand_core::OsRng};
use redis::AsyncCommands;
use reqwest::Client;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::{Mutex, MutexGuard};
use totp_rs::Totp;
use uuid::Uuid;

const PASSWORD: &str = "correct horse battery staple";

async fn suite_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

fn ensure_test_env() {
    let defaults = [
        (
            "DATABASE_URL",
            "postgres://krypta:krypta_dev_password@localhost:5433/krypta",
        ),
        ("REDIS_URL", "redis://localhost:6379"),
        ("S3_ENDPOINT", "http://localhost:3900"),
        ("S3_ACCESS_KEY", "access"),
        ("S3_SECRET_KEY", "secret"),
        ("S3_BUCKET", "krypta"),
        ("S3_OPERATION_TIMEOUT_SECONDS", "30"),
        ("ATTACHMENT_UPLOAD_STALE_SECONDS", "120"),
        ("ATTACHMENT_CLEANUP_INTERVAL_SECONDS", "60"),
        ("REGISTER_RATE_LIMIT_PER_HOUR", "50"),
        ("LOGIN_RATE_LIMIT_PER_MINUTE", "100"),
        ("SMTP_HOST", "localhost"),
        ("SMTP_PORT", "1025"),
        ("SMTP_USER", ""),
        ("SMTP_PASSWORD", ""),
        ("SMTP_TLS", "none"),
        ("MAIL_FROM", "krypta <no-reply@localhost>"),
        ("VERIFY_CODE_TTL_SECONDS", "900"),
        ("VERIFY_MAX_ATTEMPTS", "5"),
        ("RESEND_COOLDOWN_SECONDS", "60"),
        ("REGISTER_EMAIL_RATE_LIMIT_PER_HOUR", "50"),
        ("VERIFY_RATE_LIMIT_PER_MINUTE", "100"),
        ("WEB_BASE_URL", "http://localhost:3000"),
        ("INVITE_RATE_LIMIT_PER_HOUR", "20"),
        ("INVITE_RATE_LIMIT_PER_DAY", "100"),
        ("INVITE_RECIPIENT_RATE_LIMIT_PER_HOUR", "3"),
        ("INVITE_CONTINUATION_RATE_LIMIT_PER_HOUR", "30"),
    ];

    for (name, value) in defaults {
        if std::env::var_os(name).is_none() {
            unsafe { std::env::set_var(name, value) };
        }
    }
}

fn reserve_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct TestApi {
    child: Child,
    base_url: String,
}

impl Drop for TestApi {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn start_api(initial_admin_email: Option<&str>) -> TestApi {
    start_api_with_env(initial_admin_email, &[]).await
}

/// The five Stripe settings, blanked.
///
/// An instance default is only the authority on a limit when the instance
/// does not bill: with Stripe configured the plan layer resolves above it, by
/// design. A test that asserts an instance default is enforced therefore has
/// to start an API with billing off, and blanking is the only way to do that
/// here. The child runs in `CARGO_MANIFEST_DIR`, so `dotenvy` reads the
/// developer's own `apps/api/.env`, and merely removing the variables from
/// the environment would let that file supply them again. `Config` treats an
/// empty value as unset for exactly this reason.
const STRIPE_UNCONFIGURED: &[(&str, &str)] = &[
    ("STRIPE_SECRET_KEY", ""),
    ("STRIPE_WEBHOOK_SECRET", ""),
    ("STRIPE_PORTAL_RETURN_URL", ""),
    ("STRIPE_PRICE_MONTHLY", ""),
    ("STRIPE_PRICE_YEARLY", ""),
];

/// The five Stripe settings, filled with values that switch billing on and
/// reach nothing: no test here makes an outbound call to Stripe.
const STRIPE_CONFIGURED: &[(&str, &str)] = &[
    ("STRIPE_SECRET_KEY", "sk_test_admin_suite"),
    ("STRIPE_WEBHOOK_SECRET", "whsec_admin_suite"),
    (
        "STRIPE_PORTAL_RETURN_URL",
        "http://localhost:3000/dashboard/settings",
    ),
    ("STRIPE_PRICE_MONTHLY", "price_admin_suite_monthly"),
    ("STRIPE_PRICE_YEARLY", "price_admin_suite_yearly"),
];

// `TestApi::drop` kills and waits on `child`; clippy cannot see that reap
// through the early return below.
#[allow(clippy::zombie_processes)]
async fn start_api_with_env(
    initial_admin_email: Option<&str>,
    extra_env: &[(&str, &str)],
) -> TestApi {
    ensure_test_env();

    let port = reserve_port();
    let mut command = Command::new(env!("CARGO_BIN_EXE_api"));
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match initial_admin_email {
        Some(email) => {
            command.env("KRYPTA_INITIAL_ADMIN_EMAIL", email);
        }
        None => {
            command.env_remove("KRYPTA_INITIAL_ADMIN_EMAIL");
        }
    }
    for (name, value) in extra_env {
        command.env(name, value);
    }

    let child = command.spawn().expect("api binary should start");
    let base_url = format!("http://127.0.0.1:{port}");
    let client = Client::new();

    for _ in 0..100 {
        if let Ok(response) = client.get(format!("{base_url}/health")).send().await
            && response.status().is_success()
        {
            return TestApi { child, base_url };
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    panic!("api did not become healthy on port {port}");
}

async fn test_db() -> PgPool {
    ensure_test_env();
    let db = PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    reset_instance_settings(&db).await;
    db
}

async fn reset_instance_settings(db: &PgPool) {
    let register_rate_limit = std::env::var("REGISTER_RATE_LIMIT_PER_HOUR")
        .unwrap()
        .parse::<i32>()
        .unwrap();
    let login_rate_limit = std::env::var("LOGIN_RATE_LIMIT_PER_MINUTE")
        .unwrap()
        .parse::<i32>()
        .unwrap();

    sqlx::query(
        "UPDATE instance_settings
         SET registration_enabled = TRUE,
             register_rate_limit_per_hour = $1,
             login_rate_limit_per_minute = $2,
             default_max_forms = 100,
             default_max_attachment_bytes = 1073741824,
             updated_at = now()
         WHERE id = TRUE",
    )
    .bind(register_rate_limit)
    .bind(login_rate_limit)
    .execute(db)
    .await
    .unwrap();
}

async fn reset_bootstrap(db: &PgPool) {
    sqlx::query(
        "UPDATE instance_bootstrap SET claimed_user_id = NULL, claimed_at = NULL WHERE id = TRUE",
    )
    .execute(db)
    .await
    .unwrap();
}

async fn delete_users(db: &PgPool, emails: &[&str]) {
    for email in emails {
        sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(email)
            .execute(db)
            .await
            .unwrap();
    }
}

async fn register(client: &Client, base_url: &str, email: &str) {
    clear_rate_limit_key("register:127.0.0.1").await;
    clear_rate_limit_key(&format!(
        "register_email:{:x}",
        Sha256::digest(email.to_lowercase().as_bytes())
    ))
    .await;
    common::register_test_account(base_url, client, email, PASSWORD).await;
}

fn authenticator_from(uri: &str) -> Totp {
    Totp::from_url(uri).expect("server should return a valid otpauth URI")
}

fn code_now(totp: &Totp) -> String {
    totp.generate_current().to_string()
}

async fn code_from_next_step(totp: &Totp) -> String {
    let unix_now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    tokio::time::sleep(Duration::from_secs(30 - (unix_now % 30) + 1)).await;
    code_now(totp)
}

async fn enable_totp(client: &Client, base_url: &str) -> Totp {
    let setup: serde_json::Value = client
        .post(format!("{base_url}/api/v1/auth/2fa/setup"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let totp = authenticator_from(setup["data"]["provisioning_uri"].as_str().unwrap());

    let enable = client
        .post(format!("{base_url}/api/v1/auth/2fa/enable"))
        .json(&json!({
            "code": code_now(&totp),
            "reauthentication_receipt":
                common::reauthentication_receipt(base_url, client, PASSWORD).await,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(enable.status(), 200);

    totp
}

async fn promote_to_admin(db: &PgPool, email: &str) {
    sqlx::query("UPDATE users SET instance_admin = TRUE WHERE email = $1")
        .bind(email)
        .execute(db)
        .await
        .unwrap();
}

async fn fetch_user_id(db: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn fetch_instance_admin(db: &PgPool, email: &str) -> bool {
    sqlx::query_scalar("SELECT instance_admin FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn bootstrap_claimed_user_id(db: &PgPool) -> Option<Uuid> {
    sqlx::query_scalar("SELECT claimed_user_id FROM instance_bootstrap WHERE id = TRUE")
        .fetch_one(db)
        .await
        .unwrap()
}

async fn count_admins(db: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM users WHERE instance_admin = TRUE")
        .fetch_one(db)
        .await
        .unwrap()
}

async fn login_with_totp(client: &Client, base_url: &str, email: &str, totp: &Totp) {
    let login: serde_json::Value = client
        .post(format!("{base_url}/api/v1/auth/login"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let pending_token = login["data"]["pending_token"].as_str().unwrap();
    let verify = client
        .post(format!("{base_url}/api/v1/auth/2fa/verify"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code_from_next_step(totp).await
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(verify.status(), 200);
}

async fn create_form(client: &Client, base_url: &str) -> Uuid {
    let response: serde_json::Value = client
        .post(format!("{base_url}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "ct-title",
            "schema_ciphertext": "ct-schema",
            "form_public_key": "form-public-key",
            "wrapped_form_private_key": "wrapped-private-key",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    response["data"]["id"].as_str().unwrap().parse().unwrap()
}

async fn create_form_response(client: &Client, base_url: &str) -> reqwest::Response {
    client
        .post(format!("{base_url}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "ct-title",
            "schema_ciphertext": "ct-schema",
            "form_public_key": "form-public-key",
            "wrapped_form_private_key": "wrapped-private-key",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap()
}

async fn insert_active_membership(db: &PgPool, form_id: Uuid, user_id: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO form_members (
            id, form_id, user_id, role, state, key_scheme,
            encrypted_form_data_key, encrypted_form_private_key
         ) VALUES ($1, $2, $3, $4, 'active', 'account_sealed_box_v1', $5, $6)",
    )
    .bind(Uuid::now_v7())
    .bind(form_id)
    .bind(user_id)
    .bind(role)
    .bind(format!("{role}-data-key"))
    .bind(format!("{role}-private-key"))
    .execute(db)
    .await
    .unwrap();
}

async fn fetch_account_usage(db: &PgPool, user_id: Uuid) -> (i32, i64) {
    sqlx::query_as::<_, (i32, i64)>(
        "SELECT forms_used, attachment_bytes_used
         FROM account_usage
         WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn purge_form(db: &PgPool, form_id: Uuid) {
    sqlx::query("DELETE FROM responses WHERE form_id = $1")
        .bind(form_id)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM attachments WHERE form_id = $1")
        .bind(form_id)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM form_members WHERE form_id = $1")
        .bind(form_id)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM forms WHERE id = $1")
        .bind(form_id)
        .execute(db)
        .await
        .unwrap();
}

async fn submit_public_response(base_url: &str, form_id: Uuid, ciphertext: &str) {
    let response = Client::new()
        .post(format!("{base_url}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": ciphertext }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

async fn session_index_count(user_id: Uuid) -> usize {
    let mut redis = test_redis().await;
    redis
        .scard(format!("user_sessions:{user_id}"))
        .await
        .unwrap()
}

async fn reauthenticate_receipt(client: &Client, base_url: &str, email: &str) -> String {
    let response = client
        .post(format!("{base_url}/api/v1/auth/reauthenticate"))
        .json(&json!({ "verifier": common::auth_verifier(email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json::<serde_json::Value>().await.unwrap()["data"]["reauthentication_receipt"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn count_rows(db: &PgPool, table: &str, user_id: Uuid) -> i64 {
    let query = format!("SELECT count(*) FROM {table} WHERE user_id = $1");
    sqlx::query_scalar::<_, i64>(&query)
        .bind(user_id)
        .fetch_one(db)
        .await
        .unwrap()
}

fn session_storage_key(token: &str) -> String {
    format!("session:{:x}", Sha256::digest(token.as_bytes()))
}

fn user_sessions_key(user_id: Uuid) -> String {
    format!("user_sessions:{user_id}")
}

/// The stored hash for a manually inserted account.
///
/// The server hashes the verifier the browser derives, not the password, so a
/// hand-built row has to store the same thing or its owner cannot log in.
fn hashed_verifier(email: &str) -> String {
    let params = Params::new(19_456, 2, 1, None).unwrap();
    let salt = SaltString::generate(&mut OsRng);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password(common::auth_verifier(email, PASSWORD).as_bytes(), &salt)
        .unwrap()
        .to_string()
}

async fn insert_manual_user(email: &str) -> Uuid {
    let user_id = Uuid::now_v7();
    let db = test_db().await;
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, email_verified_at)
         VALUES ($1, $2, $3, now())",
    )
    .bind(user_id)
    .bind(email)
    .bind(hashed_verifier(email))
    .execute(&db)
    .await
    .unwrap();
    // Signup writes both wrappers and the recovery code in the same transaction
    // as the user row, and an account without a password wrapper can decrypt
    // nothing, so the API refuses to authenticate it. A hand-built row has to
    // carry the same three rows to be a realistic account.
    for method in ["password", "recovery_code"] {
        sqlx::query(
            "INSERT INTO account_key_wrappers (id, user_id, method, wrapped_account_key)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(Uuid::now_v7())
        .bind(user_id)
        .bind(method)
        .bind(common::opaque_wrapped_account_key())
        .execute(&db)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO vault_recovery_codes (id, user_id, verifier_hash) VALUES ($1, $2, $3)",
    )
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(hashed_verifier(email))
    .execute(&db)
    .await
    .unwrap();
    user_id
}

async fn insert_manual_admin(email: &str) -> Uuid {
    let user_id = insert_manual_user(email).await;
    sqlx::query(
        "UPDATE users
         SET instance_admin = TRUE,
             totp_secret = '\\x01'::bytea,
             totp_enabled = TRUE
         WHERE id = $1",
    )
    .bind(user_id)
    .execute(&test_db().await)
    .await
    .unwrap();
    user_id
}

async fn session_client_for_user(user_id: Uuid, totp_verified: bool) -> Client {
    session_client_for_user_with_generation(user_id, totp_verified, 0).await
}

async fn session_client_for_user_with_generation(
    user_id: Uuid,
    totp_verified: bool,
    generation: i64,
) -> Client {
    let session_token = format!("manual-session-{}", Uuid::now_v7());
    let key = session_storage_key(&session_token);
    // This writes a raw session record straight into Redis, not an HTTP
    // response body, and it deliberately keeps the pre-rename key name
    // "totp_verified" rather than "second_factor_verified". That is the only
    // integration-level coverage that Session's serde alias still accepts a
    // session written under the old name. Do not "finish the rename" here.
    let session = json!({
        "user_id": user_id,
        "generation": generation,
        "totp_verified": totp_verified,
        "created_at": "2026-08-28T00:00:00Z",
        "absolute_expires_at": "2099-01-01T00:00:00Z",
    })
    .to_string();
    let mut redis = test_redis().await;
    let _: () = redis.set_ex(&key, session, 3600).await.unwrap();
    let _: () = redis.sadd(user_sessions_key(user_id), &key).await.unwrap();
    let _: () = redis
        .expire(user_sessions_key(user_id), 90 * 24 * 60 * 60)
        .await
        .unwrap();

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::COOKIE,
        format!("__Host-session={session_token}").parse().unwrap(),
    );
    Client::builder().default_headers(headers).build().unwrap()
}

async fn test_redis() -> redis::aio::ConnectionManager {
    ensure_test_env();
    let client = redis::Client::open(std::env::var("REDIS_URL").unwrap()).unwrap();
    redis::aio::ConnectionManager::new(client).await.unwrap()
}

async fn clear_rate_limit_key(key: &str) {
    let mut redis = test_redis().await;
    let _: () = redis.del(format!("ratelimit:{key}")).await.unwrap();
}

async fn count_audit_events(db: &PgPool, action: &str, result: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM admin_audit_events WHERE action = $1 AND result = $2")
        .bind(action)
        .bind(result)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn wait_for_blocked_requests(db: &PgPool, blocker_backend_pid: i32, expected: i64) {
    for _ in 0..80 {
        let blocked = sqlx::query_scalar!(
            r#"WITH RECURSIVE blocked(pid) AS (
                   SELECT activity.pid
                   FROM pg_stat_activity activity
                   WHERE $1 = ANY(pg_blocking_pids(activity.pid))
                   UNION
                   SELECT activity.pid
                   FROM pg_stat_activity activity
                   JOIN blocked blocker
                     ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
               )
               SELECT count(*) AS "count!" FROM blocked"#,
            blocker_backend_pid,
        )
        .fetch_one(db)
        .await
        .unwrap();
        if blocked >= expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("expected {expected} requests to block");
}

async fn wait_for_account_deletion_started(db: &PgPool, user_id: Uuid) {
    for _ in 0..80 {
        let started: bool = sqlx::query_scalar(
            "SELECT deletion_started_at IS NOT NULL
             FROM users
             WHERE id = $1",
        )
        .bind(user_id)
        .fetch_one(db)
        .await
        .unwrap();
        if started {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("account deletion did not enter the deletion-started state");
}

#[tokio::test]
async fn admin_guard_leaves_bootstrap_unclaimed_when_no_email_is_configured() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let email = format!("admin-none-{}@example.com", Uuid::now_v7());
    delete_users(&db, &[&email]).await;

    let api = start_api(None).await;
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &api.base_url, &email).await;

    assert!(!fetch_instance_admin(&db, &email).await);
    assert_eq!(bootstrap_claimed_user_id(&db).await, None);

    reset_bootstrap(&db).await;
    delete_users(&db, &[&email]).await;
}

#[tokio::test]
async fn admin_guard_only_the_configured_verified_email_claims_the_single_bootstrap() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let configured_email = format!("first-admin-{nonce}@example.com").to_ascii_lowercase();
    let configured_env = format!("  FIRST-ADMIN-{nonce}@Example.com  ");
    let second_configured_email = format!("second-admin-{nonce}@example.com");
    let ordinary_email = format!("ordinary-{nonce}@example.com");
    delete_users(
        &db,
        &[&configured_email, &second_configured_email, &ordinary_email],
    )
    .await;

    let api = start_api(Some(&configured_env)).await;
    let ordinary_client = Client::builder().cookie_store(true).build().unwrap();
    register(&ordinary_client, &api.base_url, &ordinary_email).await;
    assert!(!fetch_instance_admin(&db, &ordinary_email).await);
    assert_eq!(bootstrap_claimed_user_id(&db).await, None);

    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &configured_email).await;
    let first_admin_id = fetch_user_id(&db, &configured_email).await;
    assert!(fetch_instance_admin(&db, &configured_email).await);
    assert_eq!(bootstrap_claimed_user_id(&db).await, Some(first_admin_id));

    drop(api);

    let api = start_api(Some(&second_configured_email)).await;
    let second_admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(
        &second_admin_client,
        &api.base_url,
        &second_configured_email,
    )
    .await;

    assert!(fetch_instance_admin(&db, &configured_email).await);
    assert!(!fetch_instance_admin(&db, &second_configured_email).await);
    assert_eq!(bootstrap_claimed_user_id(&db).await, Some(first_admin_id));
    assert_eq!(count_admins(&db).await, 1);

    reset_bootstrap(&db).await;
    delete_users(
        &db,
        &[&configured_email, &second_configured_email, &ordinary_email],
    )
    .await;
}

#[tokio::test]
async fn admin_guard_replayed_verification_keeps_a_single_admin_claim() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let email = format!("replay-admin-{}@example.com", Uuid::now_v7());
    delete_users(&db, &[&email]).await;

    let api = start_api(Some(&email)).await;
    let client_a = Client::builder().build().unwrap();
    let client_b = Client::builder().build().unwrap();

    let register: serde_json::Value = client_a
        .post(format!("{}/api/v1/auth/register", api.base_url))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"]
        .as_str()
        .unwrap()
        .to_string();
    let code = common::latest_code_for(&email).await;
    // The same browser retrying, so the same wrapper: whichever request loses
    // the insert race must still converge rather than fail.
    let wrapper = common::opaque_wrapped_account_key();
    let verify_body = json!({
        "pending_token": pending_token,
        "code": code,
        "wrapped_account_key_password": wrapper,
        "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
        "recovery_verifier": common::opaque_verifier(),
    });

    let (first, second) = tokio::join!(
        client_a
            .post(format!("{}/api/v1/auth/verify-email", api.base_url))
            .json(&verify_body)
            .send(),
        client_b
            .post(format!("{}/api/v1/auth/verify-email", api.base_url))
            .json(&verify_body)
            .send(),
    );

    assert_eq!(first.unwrap().status(), 200);
    assert_eq!(second.unwrap().status(), 200);

    let user_id = fetch_user_id(&db, &email).await;
    assert!(fetch_instance_admin(&db, &email).await);
    assert_eq!(bootstrap_claimed_user_id(&db).await, Some(user_id));
    assert_eq!(count_admins(&db).await, 1);

    reset_bootstrap(&db).await;
    delete_users(&db, &[&email]).await;
}

#[tokio::test]
async fn admin_guard_requires_admin_role_totp_enrolment_and_a_totp_verified_session() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let ordinary_email = format!("ordinary-guard-{nonce}@example.com");
    let admin_email = format!("admin-guard-{nonce}@example.com");
    delete_users(&db, &[&ordinary_email, &admin_email]).await;

    let api = start_api(None).await;

    let ordinary_client = Client::builder().cookie_store(true).build().unwrap();
    register(&ordinary_client, &api.base_url, &ordinary_email).await;
    let ordinary_response = ordinary_client
        .get(format!("{}/api/v1/admin/accounts", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(ordinary_response.status(), 401);
    let ordinary_body: serde_json::Value = ordinary_response.json().await.unwrap();
    assert_eq!(ordinary_body["error"]["code"], "unauthorized");
    assert_eq!(ordinary_body["data"], json!({}));

    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;

    let no_totp = admin_client
        .get(format!("{}/api/v1/admin/accounts", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(no_totp.status(), 401);
    let no_totp_body: serde_json::Value = no_totp.json().await.unwrap();
    assert_eq!(no_totp_body["error"]["code"], "unauthorized");
    assert_eq!(no_totp_body["data"], json!({}));

    let totp = enable_totp(&admin_client, &api.base_url).await;
    let stale_me: serde_json::Value = admin_client
        .get(format!("{}/api/v1/auth/me", api.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stale_me["data"]["totp_enabled"], true);
    assert_eq!(stale_me["data"]["second_factor_verified"], false);
    let stale_session = admin_client
        .get(format!("{}/api/v1/admin/accounts", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(stale_session.status(), 401);
    let stale_body: serde_json::Value = stale_session.json().await.unwrap();
    assert_eq!(stale_body["error"]["code"], "unauthorized");
    assert_eq!(stale_body["data"], json!({}));

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&fresh_admin_client, &api.base_url, &admin_email, &totp).await;
    let fresh_me: serde_json::Value = fresh_admin_client
        .get(format!("{}/api/v1/auth/me", api.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(fresh_me["data"]["totp_enabled"], true);
    assert_eq!(fresh_me["data"]["second_factor_verified"], true);
    let success = fresh_admin_client
        .get(format!("{}/api/v1/admin/accounts", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(success.status(), 200);
    let success_body: serde_json::Value = success.json().await.unwrap();
    assert!(success_body["data"]["accounts"].is_array());

    reset_bootstrap(&db).await;
    delete_users(&db, &[&ordinary_email, &admin_email]).await;
}

#[tokio::test]
async fn settings_and_metadata_settings_validation_and_registration_toggle() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("settings-admin-{nonce}@example.com");
    let blocked_email = format!("settings-blocked-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &blocked_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let totp = enable_totp(&admin_client, &api.base_url).await;

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&fresh_admin_client, &api.base_url, &admin_email, &totp).await;

    let current_settings = fresh_admin_client
        .get(format!("{}/api/v1/admin/settings", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(current_settings.status(), 200);
    let current_body: serde_json::Value = current_settings.json().await.unwrap();
    assert_eq!(current_body["data"]["registration_enabled"], true);
    assert!(current_body["data"]["mail_configured"].is_boolean());
    assert!(current_body["data"].get("smtp_host").is_none());
    let original_settings = current_body["data"].clone();

    let invalid_patch = fresh_admin_client
        .patch(format!("{}/api/v1/admin/settings", api.base_url))
        .json(&json!({ "register_rate_limit_per_hour": 0 }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_patch.status(), 400);
    let invalid_body: serde_json::Value = invalid_patch.json().await.unwrap();
    assert_eq!(invalid_body["error"]["code"], "bad_request");

    let disabled_patch = fresh_admin_client
        .patch(format!("{}/api/v1/admin/settings", api.base_url))
        .json(&json!({
            "registration_enabled": false,
            "register_rate_limit_per_hour": 7,
            "default_max_forms": 321,
            "default_max_attachment_bytes": 4096
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(disabled_patch.status(), 200);
    let disabled_body: serde_json::Value = disabled_patch.json().await.unwrap();
    assert_eq!(disabled_body["data"]["registration_enabled"], false);
    assert_eq!(disabled_body["data"]["register_rate_limit_per_hour"], 7);
    assert_eq!(disabled_body["data"]["default_max_forms"], 321);
    assert_eq!(disabled_body["data"]["default_max_attachment_bytes"], 4096);

    let blocked_register = Client::new()
        .post(format!("{}/api/v1/auth/register", api.base_url))
        .json(&json!({
            "email": blocked_email,
            "verifier": common::auth_verifier(&blocked_email, PASSWORD),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_register.status(), 400);
    let blocked_body: serde_json::Value = blocked_register.json().await.unwrap();
    assert_eq!(blocked_body["error"]["code"], "bad_request");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE email = $1")
            .bind(&blocked_email)
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );

    let restore = fresh_admin_client
        .patch(format!("{}/api/v1/admin/settings", api.base_url))
        .json(&json!({
            "registration_enabled": original_settings["registration_enabled"],
            "register_rate_limit_per_hour": original_settings["register_rate_limit_per_hour"],
            "login_rate_limit_per_minute": original_settings["login_rate_limit_per_minute"],
            "default_max_forms": original_settings["default_max_forms"],
            "default_max_attachment_bytes": original_settings["default_max_attachment_bytes"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(restore.status(), 200);

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &blocked_email]).await;
}

#[tokio::test]
async fn settings_and_metadata_account_and_audit_lists_stay_redacted() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("metadata-admin-{nonce}@example.com");
    let account_email = format!("metadata-account-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &account_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let totp = enable_totp(&admin_client, &api.base_url).await;

    let account_client = Client::builder().cookie_store(true).build().unwrap();
    register(&account_client, &api.base_url, &account_email).await;
    let account_id = fetch_user_id(&db, &account_email).await;
    sqlx::query(
        "UPDATE users
         SET suspended_at = now(),
             totp_secret = 'redacted-secret',
             totp_enabled = TRUE
         WHERE id = $1",
    )
    .bind(account_id)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET max_forms = EXCLUDED.max_forms,
             max_attachment_bytes = EXCLUDED.max_attachment_bytes",
    )
    .bind(account_id)
    .bind(17_i32)
    .bind(8_192_i64)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO account_usage (user_id, forms_used, attachment_bytes_used)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET forms_used = EXCLUDED.forms_used,
             attachment_bytes_used = EXCLUDED.attachment_bytes_used",
    )
    .bind(account_id)
    .bind(3_i32)
    .bind(2_048_i64)
    .execute(&db)
    .await
    .unwrap();

    let actor_id = fetch_user_id(&db, &admin_email).await;
    let audit_event_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, 'settings_updated', 'succeeded')",
    )
    .bind(audit_event_id)
    .bind(actor_id)
    .bind(account_id)
    .execute(&db)
    .await
    .unwrap();

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&fresh_admin_client, &api.base_url, &admin_email, &totp).await;

    let accounts_response = fresh_admin_client
        .get(format!(
            "{}/api/v1/admin/accounts?search={}",
            api.base_url, account_email
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(accounts_response.status(), 200);
    let accounts_body: serde_json::Value = accounts_response.json().await.unwrap();
    let accounts = accounts_body["data"]["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 1);
    let account = &accounts[0];
    assert_eq!(account["id"], account_id.to_string());
    assert_eq!(account["instance_admin"], false);
    assert_eq!(account["suspended"], true);
    assert_eq!(account["totp_enabled"], true);
    assert_eq!(account["max_forms"], 17);
    assert_eq!(account["max_attachment_bytes"], 8192);
    assert_eq!(account["forms_used"], 3);
    assert_eq!(account["attachment_bytes_used"], 2048);
    assert!(account["created_at"].is_string());
    for forbidden in [
        "email",
        "password_hash",
        "master_key_salt",
        "totp_secret",
        "sharing_public_key",
        "encrypted_private_key",
        "encrypted_form_data_key",
        "encrypted_form_private_key",
        "schema_ciphertext",
        "title_ciphertext",
    ] {
        assert!(
            account.get(forbidden).is_none(),
            "account list leaked {forbidden}"
        );
    }

    let audit_response = fresh_admin_client
        .get(format!(
            "{}/api/v1/admin/audit?action=settings_updated&result=succeeded&limit=1",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(audit_response.status(), 200);
    let audit_body: serde_json::Value = audit_response.json().await.unwrap();
    let event = &audit_body["data"]["events"].as_array().unwrap()[0];
    assert_eq!(event["id"], audit_event_id.to_string());
    assert_eq!(event["actor_user_id"], actor_id.to_string());
    assert_eq!(event["target_user_id"], account_id.to_string());
    assert_eq!(event["action"], "settings_updated");
    assert_eq!(event["result"], "succeeded");
    assert!(event["created_at"].is_string());
    for forbidden in [
        "email",
        "actor_email",
        "target_email",
        "ciphertext",
        "totp_secret",
        "master_key_salt",
        "detail",
        "smtp_host",
    ] {
        assert!(
            event.get(forbidden).is_none(),
            "audit list leaked {forbidden}"
        );
    }

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &account_email]).await;
}

#[tokio::test]
async fn lifecycle_suspend_and_reactivate_revoke_sessions_without_recreating_them_and_audit_results()
 {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-admin-{nonce}@example.com");
    let target_email = format!("lifecycle-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let admin_totp = enable_totp(&admin_client, &api.base_url).await;

    let target_client = Client::builder().cookie_store(true).build().unwrap();
    register(&target_client, &api.base_url, &target_email).await;
    let target_second_client = Client::builder().cookie_store(true).build().unwrap();
    let login = target_second_client
        .post(format!("{}/api/v1/auth/login", api.base_url))
        .json(&json!({ "email": target_email, "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200);

    let admin_session = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&admin_session, &api.base_url, &admin_email, &admin_totp).await;

    let target_user_id = fetch_user_id(&db, &target_email).await;
    let suspended_before = count_audit_events(&db, "account_suspended", "succeeded").await;
    let reactivated_before = count_audit_events(&db, "account_reactivated", "succeeded").await;
    assert_eq!(session_index_count(target_user_id).await, 2);

    let suspend = admin_session
        .post(format!(
            "{}/api/v1/admin/accounts/{target_user_id}/suspend",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(suspend.status(), 200);
    assert_eq!(session_index_count(target_user_id).await, 0);
    assert_eq!(
        target_client
            .get(format!("{}/api/v1/auth/me", api.base_url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        target_second_client
            .get(format!("{}/api/v1/auth/me", api.base_url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let suspended_login = Client::new()
        .post(format!("{}/api/v1/auth/login", api.base_url))
        .json(&json!({ "email": target_email, "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(suspended_login.status(), 401);

    let reactivate = admin_session
        .post(format!(
            "{}/api/v1/admin/accounts/{target_user_id}/reactivate",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(reactivate.status(), 200);
    assert_eq!(session_index_count(target_user_id).await, 0);
    assert_eq!(
        target_client
            .get(format!("{}/api/v1/auth/me", api.base_url))
            .send()
            .await
            .unwrap()
            .status(),
        401,
        "reactivation must not recreate a session"
    );
    let resumed_login = Client::new()
        .post(format!("{}/api/v1/auth/login", api.base_url))
        .json(&json!({ "email": target_email, "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(resumed_login.status(), 200);

    assert_eq!(
        count_audit_events(&db, "account_suspended", "succeeded").await,
        suspended_before + 1
    );
    assert_eq!(
        count_audit_events(&db, "account_reactivated", "succeeded").await,
        reactivated_before + 1
    );

    let audit = admin_session
        .get(format!(
            "{}/api/v1/admin/audit?action=account_suspended&result=succeeded&limit=1",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(audit.status(), 200);
    let audit_body: serde_json::Value = audit.json().await.unwrap();
    let event = &audit_body["data"]["events"].as_array().unwrap()[0];
    assert_eq!(event["target_user_id"], target_user_id.to_string());
    for forbidden in ["email", "actor_email", "target_email", "detail", "password"] {
        assert!(
            event.get(forbidden).is_none(),
            "audit list leaked {forbidden}"
        );
    }

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &target_email]).await;
}

#[tokio::test]
async fn lifecycle_rejects_self_and_final_admin_account_actions_and_audits_rejections() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-final-admin-{nonce}@example.com");
    let second_admin_email = format!("lifecycle-second-admin-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &second_admin_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let admin_totp = enable_totp(&admin_client, &api.base_url).await;

    let admin_session = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&admin_session, &api.base_url, &admin_email, &admin_totp).await;
    let admin_user_id = fetch_user_id(&db, &admin_email).await;
    let suspended_rejected_before = count_audit_events(&db, "account_suspended", "rejected").await;
    let deleted_rejected_before = count_audit_events(&db, "account_deleted", "rejected").await;

    for path in [
        format!(
            "{}/api/v1/admin/accounts/{admin_user_id}/suspend",
            api.base_url
        ),
        format!("{}/api/v1/admin/accounts/{admin_user_id}", api.base_url),
    ] {
        let response = if path.ends_with("/suspend") {
            admin_session.post(path).send().await.unwrap()
        } else {
            let receipt = reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await;
            admin_session
                .delete(path)
                .json(&json!({ "reauthentication_receipt": receipt }))
                .send()
                .await
                .unwrap()
        };
        assert_eq!(response.status(), 409);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "conflict");
    }

    let second_admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&second_admin_client, &api.base_url, &second_admin_email).await;
    promote_to_admin(&db, &second_admin_email).await;

    let delete_self_receipt =
        reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await;
    let delete_self = admin_session
        .delete(format!(
            "{}/api/v1/admin/accounts/{admin_user_id}",
            api.base_url
        ))
        .json(&json!({ "reauthentication_receipt": delete_self_receipt }))
        .send()
        .await
        .unwrap();
    assert_eq!(delete_self.status(), 409);
    let delete_self_body: serde_json::Value = delete_self.json().await.unwrap();
    assert_eq!(delete_self_body["error"]["code"], "conflict");

    let suspend_self = admin_session
        .post(format!(
            "{}/api/v1/admin/accounts/{admin_user_id}/suspend",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(suspend_self.status(), 409);
    let suspend_self_body: serde_json::Value = suspend_self.json().await.unwrap();
    assert_eq!(suspend_self_body["error"]["code"], "conflict");

    assert_eq!(
        count_audit_events(&db, "account_suspended", "rejected").await,
        suspended_rejected_before + 2
    );
    assert_eq!(
        count_audit_events(&db, "account_deleted", "rejected").await,
        deleted_rejected_before + 2
    );

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &second_admin_email]).await;
}

#[tokio::test]
async fn lifecycle_delete_requires_a_session_bound_reauth_receipt_and_rejects_password_bodies() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-delete-admin-{nonce}@example.com");
    let target_email = format!("lifecycle-delete-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let admin_totp = enable_totp(&admin_client, &api.base_url).await;

    let target_client = Client::builder().cookie_store(true).build().unwrap();
    register(&target_client, &api.base_url, &target_email).await;
    let target_user_id = fetch_user_id(&db, &target_email).await;

    let admin_session = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&admin_session, &api.base_url, &admin_email, &admin_totp).await;
    let second_admin_session = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(
        &second_admin_session,
        &api.base_url,
        &admin_email,
        &admin_totp,
    )
    .await;
    let deleted_rejected_before = count_audit_events(&db, "account_deleted", "rejected").await;

    let password_body = admin_session
        .delete(format!(
            "{}/api/v1/admin/accounts/{target_user_id}",
            api.base_url
        ))
        .json(&json!({ "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(password_body.status(), 400);
    let password_body_json: serde_json::Value = password_body.json().await.unwrap();
    assert_eq!(password_body_json["error"]["code"], "bad_request");

    let first_receipt = reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await;
    let wrong_session = second_admin_session
        .delete(format!(
            "{}/api/v1/admin/accounts/{target_user_id}",
            api.base_url
        ))
        .json(&json!({ "reauthentication_receipt": first_receipt }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_session.status(), 401);
    let wrong_session_body: serde_json::Value = wrong_session.json().await.unwrap();
    assert_eq!(wrong_session_body["error"]["code"], "unauthorized");

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id = $1")
            .bind(target_user_id)
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        count_audit_events(&db, "account_deleted", "rejected").await,
        deleted_rejected_before + 1
    );

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &target_email]).await;
}

#[tokio::test]
async fn lifecycle_delete_blocks_new_form_creation_before_owned_form_cleanup_finishes() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-delete-race-admin-{nonce}@example.com");
    let target_email = format!("lifecycle-delete-race-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api(None).await;

    let admin_user_id = insert_manual_admin(&admin_email).await;
    let admin_session = session_client_for_user(admin_user_id, true).await;
    let target_user_id = insert_manual_user(&target_email).await;
    let target_client = session_client_for_user(target_user_id, false).await;
    let owned_form_id = create_form(&target_client, &api.base_url).await;

    let mut pause_transaction = db.begin().await.unwrap();
    let pause_backend_pid = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
        .fetch_one(&mut *pause_transaction)
        .await
        .unwrap();
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM forms WHERE id = $1 FOR UPDATE")
        .bind(owned_form_id)
        .fetch_one(&mut *pause_transaction)
        .await
        .unwrap();

    let receipt = reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await;
    let delete = tokio::spawn({
        let admin = admin_session.clone();
        let base_url = api.base_url.clone();
        async move {
            admin
                .delete(format!("{base_url}/api/v1/admin/accounts/{target_user_id}"))
                .json(&json!({ "reauthentication_receipt": receipt }))
                .send()
                .await
                .unwrap()
        }
    });
    wait_for_blocked_requests(&db, pause_backend_pid, 1).await;
    wait_for_account_deletion_started(&db, target_user_id).await;

    let create_while_deleting = create_form_response(&target_client, &api.base_url).await;
    assert_eq!(create_while_deleting.status(), 401);
    let create_while_deleting_body: serde_json::Value = create_while_deleting.json().await.unwrap();
    assert_eq!(create_while_deleting_body["error"]["code"], "unauthorized");

    pause_transaction.rollback().await.unwrap();
    assert_eq!(delete.await.unwrap().status(), 200);

    let ownerless_forms: i64 = sqlx::query_scalar(
        "SELECT count(*)
         FROM forms
         WHERE NOT EXISTS (
             SELECT 1
             FROM form_members
             WHERE form_members.form_id = forms.id
               AND form_members.role = 'owner'
               AND form_members.state = 'active'
         )",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(ownerless_forms, 0);

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &target_email]).await;
}

#[tokio::test]
async fn lifecycle_suspend_barrier_keeps_stale_sessions_invalid_after_reactivation() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-suspend-barrier-admin-{nonce}@example.com");
    let target_email = format!("lifecycle-suspend-barrier-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api(None).await;
    let admin_user_id = insert_manual_admin(&admin_email).await;
    let admin_session = session_client_for_user(admin_user_id, true).await;
    let target_user_id = insert_manual_user(&target_email).await;

    let suspend = admin_session
        .post(format!(
            "{}/api/v1/admin/accounts/{target_user_id}/suspend",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(suspend.status(), 200);

    let stale_session = session_client_for_user_with_generation(target_user_id, false, 0).await;
    assert_eq!(
        stale_session
            .get(format!("{}/api/v1/auth/me", api.base_url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    let reactivate = admin_session
        .post(format!(
            "{}/api/v1/admin/accounts/{target_user_id}/reactivate",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(reactivate.status(), 200);

    assert_eq!(
        stale_session
            .get(format!("{}/api/v1/auth/me", api.base_url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &target_email]).await;
}

#[tokio::test]
async fn lifecycle_suspend_and_reactivate_invalidates_stale_pending_totp_login_but_allows_a_fresh_one()
 {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-pending-totp-admin-{nonce}@example.com");
    let target_email = format!("lifecycle-pending-totp-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api(None).await;
    let admin_user_id = insert_manual_admin(&admin_email).await;
    let admin_session = session_client_for_user(admin_user_id, true).await;

    let target_user_id = insert_manual_user(&target_email).await;
    let target_client = session_client_for_user(target_user_id, false).await;
    let target_totp = enable_totp(&target_client, &api.base_url).await;

    let stale_login_client = Client::builder().cookie_store(true).build().unwrap();
    let stale_login: serde_json::Value = stale_login_client
        .post(format!("{}/api/v1/auth/login", api.base_url))
        .json(&json!({ "email": target_email, "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let stale_pending = stale_login["data"]["pending_token"]
        .as_str()
        .unwrap()
        .to_string();

    let suspend = admin_session
        .post(format!(
            "{}/api/v1/admin/accounts/{target_user_id}/suspend",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(suspend.status(), 200);

    let reactivate = admin_session
        .post(format!(
            "{}/api/v1/admin/accounts/{target_user_id}/reactivate",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(reactivate.status(), 200);

    let stale_verify = stale_login_client
        .post(format!("{}/api/v1/auth/2fa/verify", api.base_url))
        .json(&json!({
            "pending_token": stale_pending,
            "code": code_from_next_step(&target_totp).await
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(stale_verify.status(), 401);
    let stale_verify_body: serde_json::Value = stale_verify.json().await.unwrap();
    assert_eq!(stale_verify_body["error"]["code"], "unauthorized");

    assert_eq!(
        stale_login_client
            .get(format!("{}/api/v1/auth/me", api.base_url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    let fresh_login_client = Client::builder().cookie_store(true).build().unwrap();
    let fresh_login: serde_json::Value = fresh_login_client
        .post(format!("{}/api/v1/auth/login", api.base_url))
        .json(&json!({ "email": target_email, "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let fresh_pending = fresh_login["data"]["pending_token"]
        .as_str()
        .unwrap()
        .to_string();

    let fresh_verify = fresh_login_client
        .post(format!("{}/api/v1/auth/2fa/verify", api.base_url))
        .json(&json!({
            "pending_token": fresh_pending,
            "code": code_from_next_step(&target_totp).await
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(fresh_verify.status(), 200);
    assert_eq!(
        fresh_login_client
            .get(format!("{}/api/v1/auth/me", api.base_url))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &target_email]).await;
}

#[tokio::test]
async fn lifecycle_delete_rejects_shared_owners_then_removes_account_data_and_owned_ciphertext_after_transfer()
 {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-delete-owner-admin-{nonce}@example.com");
    let target_email = format!("lifecycle-delete-owner-target-{nonce}@example.com");
    let editor_email = format!("lifecycle-delete-owner-editor-{nonce}@example.com");
    let host_email = format!("lifecycle-delete-owner-host-{nonce}@example.com");
    delete_users(
        &db,
        &[&admin_email, &target_email, &editor_email, &host_email],
    )
    .await;

    let api = start_api(None).await;
    let admin_user_id = insert_manual_admin(&admin_email).await;
    let admin_session = session_client_for_user(admin_user_id, true).await;

    let target_user_id = insert_manual_user(&target_email).await;
    let target_client = session_client_for_user(target_user_id, false).await;
    let editor_user_id = insert_manual_user(&editor_email).await;
    let host_user_id = insert_manual_user(&host_email).await;
    let host_client = session_client_for_user(host_user_id, false).await;

    let shared_form_id = create_form(&target_client, &api.base_url).await;
    insert_active_membership(&db, shared_form_id, editor_user_id, "editor").await;
    let editor_member_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM form_members WHERE form_id = $1 AND user_id = $2",
    )
    .bind(shared_form_id)
    .bind(editor_user_id)
    .fetch_one(&db)
    .await
    .unwrap();

    let owned_form_id = create_form(&target_client, &api.base_url).await;
    submit_public_response(&api.base_url, owned_form_id, "ciphertext-response").await;

    let host_form_id = create_form(&host_client, &api.base_url).await;
    insert_active_membership(&db, host_form_id, target_user_id, "editor").await;

    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, 9, 4096)
         ON CONFLICT (user_id) DO UPDATE
         SET max_forms = EXCLUDED.max_forms,
             max_attachment_bytes = EXCLUDED.max_attachment_bytes",
    )
    .bind(target_user_id)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query!(
        "INSERT INTO totp_recovery_codes (id, user_id, code_hash)
         VALUES ($1, $2, 'test-recovery-hash')",
        Uuid::now_v7(),
        target_user_id,
    )
    .execute(&db)
    .await
    .unwrap();

    clear_rate_limit_key(&format!("reauthenticate:127.0.0.1:{target_user_id}")).await;
    let deleted_rejected_before = count_audit_events(&db, "account_deleted", "rejected").await;
    let transfer_succeeded_before = count_audit_events(&db, "form_transferred", "succeeded").await;
    let deleted_succeeded_before = count_audit_events(&db, "account_deleted", "succeeded").await;

    let shared_owner_receipt =
        reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await;
    let blocked_delete = admin_session
        .delete(format!(
            "{}/api/v1/admin/accounts/{target_user_id}",
            api.base_url
        ))
        .json(&json!({ "reauthentication_receipt": shared_owner_receipt }))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_delete.status(), 409);
    let blocked_delete_body: serde_json::Value = blocked_delete.json().await.unwrap();
    assert_eq!(blocked_delete_body["error"]["code"], "conflict");

    let transfer = admin_session
        .post(format!(
            "{}/api/v1/admin/forms/{shared_form_id}/transfer",
            api.base_url
        ))
        .json(&json!({ "member_id": editor_member_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(transfer.status(), 200);

    clear_rate_limit_key(&format!("reauthenticate:127.0.0.1:{target_user_id}")).await;
    let delete_receipt = reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await;
    let delete = admin_session
        .delete(format!(
            "{}/api/v1/admin/accounts/{target_user_id}",
            api.base_url
        ))
        .json(&json!({ "reauthentication_receipt": delete_receipt }))
        .send()
        .await
        .unwrap();
    let delete_status = delete.status();
    let delete_body: serde_json::Value = delete.json().await.unwrap();
    let owned_forms_after_delete_attempt: i64 =
        sqlx::query_scalar("SELECT count(*) FROM forms WHERE id = $1")
            .bind(owned_form_id)
            .fetch_one(&db)
            .await
            .unwrap();
    let target_rows_after_delete_attempt: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE id = $1")
            .bind(target_user_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        delete_status, 200,
        "delete failed: {delete_body}; owned_form_rows={owned_forms_after_delete_attempt}; target_rows={target_rows_after_delete_attempt}"
    );

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM forms WHERE id = $1")
            .bind(owned_form_id)
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM responses WHERE form_id = $1")
            .bind(owned_form_id)
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachments WHERE form_id = $1")
            .bind(owned_form_id)
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM form_members WHERE form_id = $1 AND user_id = $2"
        )
        .bind(host_form_id)
        .bind(target_user_id)
        .fetch_one(&db)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        count_rows(&db, "totp_recovery_codes", target_user_id).await,
        0
    );
    assert_eq!(count_rows(&db, "account_quotas", target_user_id).await, 0);
    assert_eq!(count_rows(&db, "account_usage", target_user_id).await, 0);
    assert_eq!(session_index_count(target_user_id).await, 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id = $1")
            .bind(target_user_id)
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        count_audit_events(&db, "account_deleted", "rejected").await,
        deleted_rejected_before + 1
    );
    let rejected_target_user_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT target_user_id
         FROM admin_audit_events
         WHERE action = 'account_deleted' AND result = 'rejected'
         ORDER BY created_at DESC, id DESC
         LIMIT 1",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(rejected_target_user_id, Some(target_user_id));
    assert_eq!(
        count_audit_events(&db, "form_transferred", "succeeded").await,
        transfer_succeeded_before + 1
    );
    assert_eq!(
        count_audit_events(&db, "account_deleted", "succeeded").await,
        deleted_succeeded_before + 1
    );
    let succeeded_target_user_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT target_user_id
         FROM admin_audit_events
         WHERE action = 'account_deleted' AND result = 'succeeded'
         ORDER BY created_at DESC, id DESC
         LIMIT 1",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(succeeded_target_user_id, Some(target_user_id));

    // `target_email` is already gone via the admin deletion above; `editor_email`
    // and `host_email` still own forms (the transferred form and `host_form_id`
    // respectively), so deleting those users here would violate
    // `form_members_user_id_fkey`. Only the admin account needs cleanup.
    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email]).await;
}

#[tokio::test]
async fn eligible_ownership_transfers_are_admin_guarded_metadata_only_and_include_active_editor_memberships()
 {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("eligible-transfer-admin-{nonce}@example.com");
    let owner_email = format!("eligible-transfer-owner-{nonce}@example.com");
    let editor_email = format!("eligible-transfer-editor-{nonce}@example.com");
    let awaiting_email = format!("eligible-transfer-awaiting-{nonce}@example.com");
    delete_users(
        &db,
        &[&admin_email, &owner_email, &editor_email, &awaiting_email],
    )
    .await;

    let api = start_api(None).await;
    let admin_id = insert_manual_admin(&admin_email).await;
    let admin_session = session_client_for_user(admin_id, true).await;
    let owner_id = insert_manual_user(&owner_email).await;
    let owner_session = session_client_for_user(owner_id, false).await;
    let editor_id = insert_manual_user(&editor_email).await;
    let awaiting_editor_id = insert_manual_user(&awaiting_email).await;

    let shared_form_id = create_form(&owner_session, &api.base_url).await;
    insert_active_membership(&db, shared_form_id, editor_id, "editor").await;
    sqlx::query(
        "INSERT INTO form_members (
            id, form_id, user_id, role, state, key_scheme,
            encrypted_form_data_key, encrypted_form_private_key
         ) VALUES ($1, $2, $3, 'editor', 'awaiting_keys', NULL, NULL, NULL)",
    )
    .bind(Uuid::now_v7())
    .bind(shared_form_id)
    .bind(awaiting_editor_id)
    .execute(&db)
    .await
    .unwrap();
    let active_editor_member_id: Uuid =
        sqlx::query_scalar("SELECT id FROM form_members WHERE form_id = $1 AND user_id = $2")
            .bind(shared_form_id)
            .bind(editor_id)
            .fetch_one(&db)
            .await
            .unwrap();
    let unshared_form_id = create_form(&owner_session, &api.base_url).await;

    let response = admin_session
        .get(format!(
            "{}/api/v1/admin/accounts/{owner_id}/eligible-transfers",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(
        body["data"]["transfers"],
        json!([{
            "form_id": shared_form_id.to_string(),
            "editor_member_ids": [active_editor_member_id.to_string()],
        }])
    );
    let transfer = &body["data"]["transfers"][0];
    for forbidden in [
        "title_ciphertext",
        "schema_ciphertext",
        "form_public_key",
        "wrapped_form_private_key",
        "wrapped_form_data_key",
        "editor_user_ids",
    ] {
        assert!(
            transfer.get(forbidden).is_none(),
            "transfer leaked {forbidden}"
        );
    }
    assert_ne!(transfer["form_id"], json!(unshared_form_id.to_string()));

    let ordinary_session = session_client_for_user(owner_id, false).await;
    let denied = ordinary_session
        .get(format!(
            "{}/api/v1/admin/accounts/{owner_id}/eligible-transfers",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);

    purge_form(&db, shared_form_id).await;
    purge_form(&db, unshared_form_id).await;
    delete_users(
        &db,
        &[&admin_email, &owner_email, &editor_email, &awaiting_email],
    )
    .await;
    reset_bootstrap(&db).await;
}

#[tokio::test]
async fn settings_and_metadata_admin_has_no_form_membership_bypass() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let owner_email = format!("owner-{nonce}@example.com");
    let admin_email = format!("admin-rbac-{nonce}@example.com");
    delete_users(&db, &[&owner_email, &admin_email]).await;

    let api = start_api(None).await;
    let owner_client = Client::builder().cookie_store(true).build().unwrap();
    register(&owner_client, &api.base_url, &owner_email).await;
    let form_id = create_form(&owner_client, &api.base_url).await;

    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let totp = enable_totp(&admin_client, &api.base_url).await;

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&fresh_admin_client, &api.base_url, &admin_email, &totp).await;
    let forbidden_form = fresh_admin_client
        .get(format!("{}/api/v1/forms/{form_id}", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden_form.status(), 404);
    let forbidden_body: serde_json::Value = forbidden_form.json().await.unwrap();
    assert_eq!(forbidden_body["error"]["code"], "not_found");

    sqlx::query("DELETE FROM form_members WHERE form_id = $1")
        .bind(form_id)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM forms WHERE id = $1")
        .bind(form_id)
        .execute(&db)
        .await
        .unwrap();
    reset_bootstrap(&db).await;
    delete_users(&db, &[&owner_email, &admin_email]).await;
}

#[tokio::test]
async fn settings_and_metadata_quota_and_suspension_enforce_public_write_policy() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let default_owner_email = format!("quota-default-{nonce}@example.com");
    let override_owner_email = format!("quota-override-{nonce}@example.com");
    let race_owner_email = format!("quota-race-{nonce}@example.com");
    let suspended_owner_email = format!("quota-suspended-{nonce}@example.com");
    let editor_email = format!("quota-editor-{nonce}@example.com");
    delete_users(
        &db,
        &[
            &default_owner_email,
            &override_owner_email,
            &race_owner_email,
            &suspended_owner_email,
            &editor_email,
        ],
    )
    .await;

    // Billing off: see `STRIPE_UNCONFIGURED`. This test is about the instance
    // default, which the plan layer would otherwise resolve above.
    let api = start_api_with_env(None, STRIPE_UNCONFIGURED).await;

    sqlx::query(
        "UPDATE instance_settings
         SET default_max_forms = 1,
             default_max_attachment_bytes = 1073741824,
             updated_at = now()
         WHERE id = TRUE",
    )
    .execute(&db)
    .await
    .unwrap();

    let default_owner = Client::builder().cookie_store(true).build().unwrap();
    register(&default_owner, &api.base_url, &default_owner_email).await;
    let default_owner_id = fetch_user_id(&db, &default_owner_email).await;

    let default_first = create_form_response(&default_owner, &api.base_url).await;
    assert_eq!(default_first.status(), 200);
    let default_form_id = default_first.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();

    let default_second = create_form_response(&default_owner, &api.base_url).await;
    assert_eq!(default_second.status(), 429);
    let default_second_body: serde_json::Value = default_second.json().await.unwrap();
    assert_eq!(default_second_body["error"]["code"], "rate_limited");
    assert_eq!(fetch_account_usage(&db, default_owner_id).await, (1, 0));

    let deleted = default_owner
        .delete(format!("{}/api/v1/forms/{default_form_id}", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);
    assert_eq!(fetch_account_usage(&db, default_owner_id).await, (0, 0));

    let default_recreate = create_form_response(&default_owner, &api.base_url).await;
    assert_eq!(default_recreate.status(), 200);
    let default_recreate_id =
        default_recreate.json::<serde_json::Value>().await.unwrap()["data"]["id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();

    let override_owner = Client::builder().cookie_store(true).build().unwrap();
    register(&override_owner, &api.base_url, &override_owner_email).await;
    let override_owner_id = fetch_user_id(&db, &override_owner_email).await;
    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, 2, 1073741824)
         ON CONFLICT (user_id) DO UPDATE
         SET max_forms = EXCLUDED.max_forms,
             max_attachment_bytes = EXCLUDED.max_attachment_bytes",
    )
    .bind(override_owner_id)
    .execute(&db)
    .await
    .unwrap();

    let override_first = create_form_response(&override_owner, &api.base_url).await;
    assert_eq!(override_first.status(), 200);
    let override_first_id = override_first.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let override_second = create_form_response(&override_owner, &api.base_url).await;
    assert_eq!(override_second.status(), 200);
    let override_second_id =
        override_second.json::<serde_json::Value>().await.unwrap()["data"]["id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
    let override_third = create_form_response(&override_owner, &api.base_url).await;
    assert_eq!(override_third.status(), 429);
    let override_third_body: serde_json::Value = override_third.json().await.unwrap();
    assert_eq!(override_third_body["error"]["code"], "rate_limited");
    assert_eq!(fetch_account_usage(&db, override_owner_id).await, (2, 0));

    let race_owner = Client::builder().cookie_store(true).build().unwrap();
    register(&race_owner, &api.base_url, &race_owner_email).await;
    let race_owner_id = fetch_user_id(&db, &race_owner_email).await;
    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, 1, 1073741824)
         ON CONFLICT (user_id) DO UPDATE
         SET max_forms = EXCLUDED.max_forms,
             max_attachment_bytes = EXCLUDED.max_attachment_bytes",
    )
    .bind(race_owner_id)
    .execute(&db)
    .await
    .unwrap();

    let race_a = race_owner.clone();
    let race_b = race_owner.clone();
    let (race_first, race_second) = tokio::join!(
        create_form_response(&race_a, &api.base_url),
        create_form_response(&race_b, &api.base_url)
    );
    let race_first_status = race_first.status();
    let race_second_status = race_second.status();
    let race_created_id = if race_first_status == 200 {
        Some(
            race_first.json::<serde_json::Value>().await.unwrap()["data"]["id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        )
    } else if race_second_status == 200 {
        Some(
            race_second.json::<serde_json::Value>().await.unwrap()["data"]["id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        )
    } else {
        None
    };
    assert!(
        matches!(
            (race_first_status.as_u16(), race_second_status.as_u16()),
            (200, 429) | (429, 200)
        ),
        "expected one success and one quota rejection, got {race_first_status} and {race_second_status}"
    );
    assert_eq!(fetch_account_usage(&db, race_owner_id).await, (1, 0));
    let race_owned_forms: i64 = sqlx::query_scalar(
        "SELECT count(*)
         FROM form_members
         WHERE user_id = $1 AND role = 'owner' AND state = 'active'",
    )
    .bind(race_owner_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(race_owned_forms, 1);

    let suspended_owner = Client::builder().cookie_store(true).build().unwrap();
    register(&suspended_owner, &api.base_url, &suspended_owner_email).await;
    let suspended_owner_id = fetch_user_id(&db, &suspended_owner_email).await;
    let suspended_form_id = create_form(&suspended_owner, &api.base_url).await;

    let editor = Client::builder().cookie_store(true).build().unwrap();
    register(&editor, &api.base_url, &editor_email).await;
    let editor_id = fetch_user_id(&db, &editor_email).await;
    insert_active_membership(&db, suspended_form_id, editor_id, "editor").await;
    sqlx::query("UPDATE users SET suspended_at = now() WHERE id = $1")
        .bind(suspended_owner_id)
        .execute(&db)
        .await
        .unwrap();

    let public_get = Client::new()
        .get(format!(
            "{}/api/v1/forms/{suspended_form_id}/public",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(public_get.status(), 200);

    let editor_get = editor
        .get(format!("{}/api/v1/forms/{suspended_form_id}", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(editor_get.status(), 200);

    let suspended_submit = Client::new()
        .post(format!(
            "{}/api/v1/forms/{suspended_form_id}/responses",
            api.base_url
        ))
        .json(&json!({ "ciphertext": "sealed-response" }))
        .send()
        .await
        .unwrap();
    assert_eq!(suspended_submit.status(), 404);
    let suspended_submit_body: serde_json::Value = suspended_submit.json().await.unwrap();
    assert_eq!(suspended_submit_body["error"]["code"], "not_found");

    for form_id in [
        default_recreate_id,
        override_first_id,
        override_second_id,
        suspended_form_id,
    ] {
        purge_form(&db, form_id).await;
    }
    if let Some(form_id) = race_created_id {
        purge_form(&db, form_id).await;
    }
    reset_instance_settings(&db).await;
    reset_bootstrap(&db).await;
    delete_users(
        &db,
        &[
            &default_owner_email,
            &override_owner_email,
            &race_owner_email,
            &suspended_owner_email,
            &editor_email,
        ],
    )
    .await;
}

#[tokio::test]
async fn settings_and_metadata_login_and_reauth_consume_live_login_limit() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("dynamic-limit-admin-{nonce}@example.com");
    let target_email = format!("dynamic-limit-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let admin_totp = enable_totp(&admin_client, &api.base_url).await;

    let target_client = Client::builder().cookie_store(true).build().unwrap();
    register(&target_client, &api.base_url, &target_email).await;
    let target_user_id = fetch_user_id(&db, &target_email).await;

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(
        &fresh_admin_client,
        &api.base_url,
        &admin_email,
        &admin_totp,
    )
    .await;

    let patched = fresh_admin_client
        .patch(format!("{}/api/v1/admin/settings", api.base_url))
        .json(&json!({ "login_rate_limit_per_minute": 1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), 200);

    clear_rate_limit_key(&format!("login:127.0.0.1:{target_email}")).await;
    let first_login = Client::new()
        .post(format!("{}/api/v1/auth/login", api.base_url))
        .json(&json!({ "email": target_email, "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(first_login.status(), 200);

    let second_login = Client::new()
        .post(format!("{}/api/v1/auth/login", api.base_url))
        .json(&json!({ "email": target_email, "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(second_login.status(), 429);
    let second_login_body: serde_json::Value = second_login.json().await.unwrap();
    assert_eq!(second_login_body["error"]["code"], "rate_limited");

    clear_rate_limit_key(&format!("reauthenticate:127.0.0.1:{target_user_id}")).await;
    let first_reauth = target_client
        .post(format!("{}/api/v1/auth/reauthenticate", api.base_url))
        .json(&json!({ "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(first_reauth.status(), 200);

    let second_reauth = target_client
        .post(format!("{}/api/v1/auth/reauthenticate", api.base_url))
        .json(&json!({ "verifier": common::auth_verifier(&target_email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(second_reauth.status(), 429);
    let second_reauth_body: serde_json::Value = second_reauth.json().await.unwrap();
    assert_eq!(second_reauth_body["error"]["code"], "rate_limited");

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &target_email]).await;
}

#[tokio::test]
async fn settings_and_metadata_malformed_admin_query_parameters_use_api_envelope() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let admin_email = format!("query-envelope-{}@example.com", Uuid::now_v7());
    delete_users(&db, &[&admin_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let totp = enable_totp(&admin_client, &api.base_url).await;

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&fresh_admin_client, &api.base_url, &admin_email, &totp).await;

    let bad_accounts = fresh_admin_client
        .get(format!("{}/api/v1/admin/accounts?limit=nope", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_accounts.status(), 400);
    let bad_accounts_body: serde_json::Value = bad_accounts.json().await.unwrap();
    assert_eq!(bad_accounts_body["success"], false);
    assert_eq!(bad_accounts_body["data"], json!({}));
    assert_eq!(bad_accounts_body["meta"], json!({}));
    assert_eq!(bad_accounts_body["error"]["code"], "bad_request");

    let bad_audit = fresh_admin_client
        .get(format!(
            "{}/api/v1/admin/audit?cursor_id=not-a-uuid",
            api.base_url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_audit.status(), 400);
    let bad_audit_body: serde_json::Value = bad_audit.json().await.unwrap();
    assert_eq!(bad_audit_body["success"], false);
    assert_eq!(bad_audit_body["data"], json!({}));
    assert_eq!(bad_audit_body["meta"], json!({}));
    assert_eq!(bad_audit_body["error"]["code"], "bad_request");

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email]).await;
}

#[tokio::test]
async fn settings_and_metadata_accounts_cursor_requires_an_extra_row() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("accounts-cursor-admin-{nonce}@example.com");
    let first_email = format!("accounts-cursor-a-{nonce}@example.com");
    let second_email = format!("accounts-cursor-b-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &first_email, &second_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let totp = enable_totp(&admin_client, &api.base_url).await;

    let first_client = Client::builder().cookie_store(true).build().unwrap();
    register(&first_client, &api.base_url, &first_email).await;

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&fresh_admin_client, &api.base_url, &admin_email, &totp).await;

    let exact_limit = fresh_admin_client
        .get(format!(
            "{}/api/v1/admin/accounts?search={}&limit=1",
            api.base_url, first_email
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(exact_limit.status(), 200);
    let exact_limit_body: serde_json::Value = exact_limit.json().await.unwrap();
    assert!(exact_limit_body["data"]["next_cursor"].is_null());

    let second_client = Client::builder().cookie_store(true).build().unwrap();
    register(&second_client, &api.base_url, &second_email).await;

    let more_than_limit = fresh_admin_client
        .get(format!("{}/api/v1/admin/accounts?limit=1", api.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(more_than_limit.status(), 200);
    let more_than_limit_body: serde_json::Value = more_than_limit.json().await.unwrap();
    assert!(more_than_limit_body["data"]["next_cursor"].is_object());

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &first_email, &second_email]).await;
}

#[tokio::test]
async fn settings_and_metadata_audit_cursor_requires_an_extra_row() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("audit-cursor-admin-{nonce}@example.com");
    let target_email = format!("audit-cursor-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api(None).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let totp = enable_totp(&admin_client, &api.base_url).await;

    let target_client = Client::builder().cookie_store(true).build().unwrap();
    register(&target_client, &api.base_url, &target_email).await;
    let actor_id = fetch_user_id(&db, &admin_email).await;
    let target_id = fetch_user_id(&db, &target_email).await;
    let action = "form_transferred";
    let result = "failed";
    let baseline = count_audit_events(&db, action, result).await;
    let limit = usize::try_from(baseline + 1).unwrap();
    assert!(
        limit <= 100,
        "audit baseline unexpectedly exceeded test bound"
    );

    let first_event_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(first_event_id)
    .bind(actor_id)
    .bind(target_id)
    .bind(action)
    .bind(result)
    .execute(&db)
    .await
    .unwrap();

    let fresh_admin_client = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&fresh_admin_client, &api.base_url, &admin_email, &totp).await;

    let first_page = fresh_admin_client
        .get(format!(
            "{}/api/v1/admin/audit?action={action}&result={result}&limit={limit}",
            api.base_url,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(first_page.status(), 200);
    let first_page_body: serde_json::Value = first_page.json().await.unwrap();
    assert!(first_page_body["data"]["next_cursor"].is_null());

    let second_event_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(second_event_id)
    .bind(actor_id)
    .bind(target_id)
    .bind(action)
    .bind(result)
    .execute(&db)
    .await
    .unwrap();

    let more_than_limit = fresh_admin_client
        .get(format!(
            "{}/api/v1/admin/audit?action={action}&result={result}&limit={limit}",
            api.base_url,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(more_than_limit.status(), 200);
    let more_than_limit_body: serde_json::Value = more_than_limit.json().await.unwrap();
    assert!(more_than_limit_body["data"]["next_cursor"].is_object());

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email, &target_email]).await;
}

#[tokio::test]
async fn lifecycle_delete_refuses_an_account_that_is_still_subscribed() {
    let _guard = suite_lock().await;
    let db = test_db().await;
    reset_bootstrap(&db).await;

    let nonce = Uuid::now_v7();
    let admin_email = format!("lifecycle-subscribed-admin-{nonce}@example.com");
    let target_email = format!("lifecycle-subscribed-target-{nonce}@example.com");
    delete_users(&db, &[&admin_email, &target_email]).await;

    let api = start_api_with_env(None, STRIPE_CONFIGURED).await;
    let admin_client = Client::builder().cookie_store(true).build().unwrap();
    register(&admin_client, &api.base_url, &admin_email).await;
    promote_to_admin(&db, &admin_email).await;
    let admin_totp = enable_totp(&admin_client, &api.base_url).await;
    let admin_session = Client::builder().cookie_store(true).build().unwrap();
    login_with_totp(&admin_session, &api.base_url, &admin_email, &admin_totp).await;

    let target_client = Client::builder().cookie_store(true).build().unwrap();
    register(&target_client, &api.base_url, &target_email).await;
    let target_user_id = fetch_user_id(&db, &target_email).await;
    sqlx::query(
        "INSERT INTO subscriptions (user_id, plan_id, stripe_customer_id, status)
         VALUES ($1, 'pro', $2, 'past_due')",
    )
    .bind(target_user_id)
    .bind(format!("cus_{nonce}"))
    .execute(&db)
    .await
    .unwrap();
    let rejected_before = count_audit_events(&db, "account_deleted", "rejected").await;

    let delete = |receipt: String| {
        let session = &admin_session;
        let url = format!("{}/api/v1/admin/accounts/{target_user_id}", api.base_url);
        async move {
            session
                .delete(url)
                .json(&json!({ "reauthentication_receipt": receipt }))
                .send()
                .await
                .unwrap()
        }
    };

    // A past_due subscription is still being billed, so it still blocks.
    let refused =
        delete(reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await).await;
    assert_eq!(refused.status(), 409);
    let body: serde_json::Value = refused.json().await.unwrap();
    assert_eq!(body["error"]["code"], "active_subscription");
    assert_eq!(
        count_audit_events(&db, "account_deleted", "rejected").await,
        rejected_before + 1
    );
    assert_eq!(
        count_audit_events_for(&db, target_user_id, "account_deletion_started").await,
        0
    );

    // Once Stripe reports it canceled, the same deletion goes through, and
    // the start of it is on the record next to the end.
    sqlx::query("UPDATE subscriptions SET status = 'canceled' WHERE user_id = $1")
        .bind(target_user_id)
        .execute(&db)
        .await
        .unwrap();
    let deleted =
        delete(reauthenticate_receipt(&admin_session, &api.base_url, &admin_email).await).await;
    assert_eq!(deleted.status(), 200);
    assert_eq!(
        count_audit_events_for(&db, target_user_id, "account_deletion_started").await,
        1
    );
    assert_eq!(
        count_audit_events_for(&db, target_user_id, "account_deleted").await,
        2
    );

    reset_bootstrap(&db).await;
    delete_users(&db, &[&admin_email]).await;
}

async fn count_audit_events_for(db: &PgPool, target_user_id: Uuid, action: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM admin_audit_events WHERE target_user_id = $1 AND action = $2",
    )
    .bind(target_user_id)
    .bind(action)
    .fetch_one(db)
    .await
    .unwrap()
}
