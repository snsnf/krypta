mod common;

use reqwest::Client;
use serde_json::json;
use sqlx::PgPool;

#[tokio::test]
async fn register_then_login_succeeds() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("test-{}@example.com", uuid::Uuid::now_v7());

    let account =
        common::register_test_account(&base, &client, &email, "correct horse battery staple").await;

    let login_res = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": email, "verifier": account.verifier }))
        .send()
        .await
        .unwrap();
    assert_eq!(login_res.status(), 200);
}

#[tokio::test]
async fn me_reflects_logged_in_user_and_logout_clears_session() {
    let base = common::base_url();
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    let email = format!("test-{}@example.com", uuid::Uuid::now_v7());

    common::register_test_account(&base, &client, &email, "correct horse battery staple").await;

    let me_res = client
        .get(format!("{base}/api/v1/auth/me"))
        .send()
        .await
        .unwrap();
    assert_eq!(me_res.status(), 200);
    let body: serde_json::Value = me_res.json().await.unwrap();
    assert_eq!(body["data"]["email"].as_str().unwrap(), email);
    assert_eq!(body["data"]["instance_admin"], json!(false));
    assert_eq!(body["data"]["totp_enabled"], json!(false));

    client
        .post(format!("{base}/api/v1/auth/logout"))
        .send()
        .await
        .unwrap();
    let me_after_logout = client
        .get(format!("{base}/api/v1/auth/me"))
        .send()
        .await
        .unwrap();
    assert_eq!(me_after_logout.status(), 401);
}

#[tokio::test]
async fn suspended_accounts_lose_existing_sessions_and_cannot_log_in() {
    let base = common::base_url();
    let email = format!("suspended-{}@example.com", uuid::Uuid::now_v7());
    let verifier = common::auth_verifier(&email, "correct horse battery staple");
    let client = Client::builder().build().unwrap();

    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"].as_str().unwrap();
    let code = common::latest_code_for(&email).await;
    let verify_res = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    let device_a = session_cookie_value(&verify_res).unwrap();

    let login_res = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap();
    let device_b = session_cookie_value(&login_res).unwrap();

    let db = test_db().await;
    sqlx::query("UPDATE users SET suspended_at = now() WHERE email = $1")
        .bind(&email)
        .execute(&db)
        .await
        .unwrap();

    for token in [&device_a, &device_b] {
        let me = client
            .get(format!("{base}/api/v1/auth/me"))
            .header("Cookie", format!("__Host-session={token}"))
            .send()
            .await
            .unwrap();
        assert_eq!(me.status(), 401);

        let logout_all = client
            .post(format!("{base}/api/v1/auth/logout-all"))
            .header("Cookie", format!("__Host-session={token}"))
            .send()
            .await
            .unwrap();
        assert_eq!(logout_all.status(), 401);
    }

    let suspended_login = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap();
    assert_eq!(suspended_login.status(), 401);
    assert!(
        suspended_login
            .headers()
            .get_all("set-cookie")
            .iter()
            .next()
            .is_none()
    );
    let body: serde_json::Value = suspended_login.json().await.unwrap();
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["data"], json!({}));
}

#[tokio::test]
async fn reauthentication_proves_password_without_rotating_the_session() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("reauth-{}@example.com", uuid::Uuid::now_v7());
    let password = "correct horse battery staple";
    let account = common::register_test_account(&base, &client, &email, password).await;

    let wrong = client
        .post(format!("{base}/api/v1/auth/reauthenticate"))
        .json(&json!({ "verifier": common::auth_verifier(&email, "a different wrong password") }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    assert!(
        wrong
            .headers()
            .get_all("set-cookie")
            .iter()
            .next()
            .is_none()
    );
    let wrong_body: serde_json::Value = wrong.json().await.unwrap();
    assert_eq!(wrong_body["error"]["code"], "unauthorized");
    assert_eq!(wrong_body["data"], json!({}));

    let correct = client
        .post(format!("{base}/api/v1/auth/reauthenticate"))
        .json(&json!({ "verifier": account.verifier }))
        .send()
        .await
        .unwrap();
    assert_eq!(correct.status(), 200);
    assert!(
        correct
            .headers()
            .get_all("set-cookie")
            .iter()
            .next()
            .is_none()
    );
    let body: serde_json::Value = correct.json().await.unwrap();
    assert!(body["data"]["user_id"].as_str().is_some());

    assert_eq!(
        client
            .get(format!("{base}/api/v1/auth/me"))
            .send()
            .await
            .unwrap()
            .status(),
        200,
        "reauthentication must retain the current opaque session"
    );
}

/// The persistent session cookie is now minted by `/auth/verify-email`, since
/// registering alone no longer authenticates anyone.
#[tokio::test]
async fn verify_email_sets_session_cookie_with_persistent_max_age() {
    let base = common::base_url();
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    let email = format!("test-{}@example.com", uuid::Uuid::now_v7());

    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, "correct horse battery staple") }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"].as_str().unwrap();
    let code = common::latest_code_for(&email).await;

    let verify_res = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(verify_res.status(), 200);

    let set_cookie = verify_res
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .find(|v| v.to_str().unwrap().contains("__Host-session"))
        .expect("session cookie should be set on verify-email")
        .to_str()
        .unwrap()
        .to_string();

    assert!(
        set_cookie.contains("Max-Age=7776000"),
        "session cookie should carry a 90-day (7776000s) Max-Age so it survives a browser restart, got: {set_cookie}"
    );
}

/// Session fixation: a token the caller arrives with must stop working once
/// they authenticate, otherwise one planted in a victim's browser survives
/// their login.
#[tokio::test]
async fn logging_in_invalidates_the_session_presented_with_the_request() {
    let base = common::base_url();
    let email = format!("rotate-{}@example.com", uuid::Uuid::now_v7());
    let verifier = common::auth_verifier(&email, "correct horse battery staple");

    // Cookie store off, so the token is carried by hand and can be compared.
    let client = Client::builder().build().unwrap();
    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"].as_str().unwrap();
    let code = common::latest_code_for(&email).await;
    let verify_res = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(verify_res.status(), 200);
    let first = session_cookie_value(&verify_res).expect("verify-email set a session");

    // The first token works.
    assert_eq!(me_status(&client, &base, &first).await, 200);

    let login_res = client
        .post(format!("{base}/api/v1/auth/login"))
        .header("Cookie", format!("__Host-session={first}"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap();
    assert_eq!(login_res.status(), 200);
    let second = session_cookie_value(&login_res).expect("login set a session");
    assert_ne!(first, second, "login must issue a different token");

    assert_eq!(
        me_status(&client, &base, &first).await,
        401,
        "the presented session must be revoked by logging in"
    );
    assert_eq!(me_status(&client, &base, &second).await, 200);
}

#[tokio::test]
async fn logout_all_revokes_sessions_created_on_other_clients() {
    let base = common::base_url();
    let email = format!("revokeall-{}@example.com", uuid::Uuid::now_v7());
    let verifier = common::auth_verifier(&email, "correct horse battery staple");

    let client = Client::builder().build().unwrap();
    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"].as_str().unwrap();
    let code = common::latest_code_for(&email).await;
    let verify_res = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    let device_a = session_cookie_value(&verify_res).unwrap();

    // A second, independent login stands in for another device.
    let login_res = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap();
    let device_b = session_cookie_value(&login_res).unwrap();

    assert_eq!(me_status(&client, &base, &device_a).await, 200);
    assert_eq!(me_status(&client, &base, &device_b).await, 200);

    let res = client
        .post(format!("{base}/api/v1/auth/logout-all"))
        .header("Cookie", format!("__Host-session={device_b}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["data"]["revoked"].as_u64().unwrap(), 2);

    assert_eq!(me_status(&client, &base, &device_a).await, 401);
    assert_eq!(me_status(&client, &base, &device_b).await, 401);
}

fn session_cookie_value(res: &reqwest::Response) -> Option<String> {
    res.headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| {
            v.strip_prefix("__Host-session=")
                .map(|rest| rest.split(';').next().unwrap_or("").to_string())
        })
        .filter(|v| !v.is_empty())
}

async fn me_status(client: &Client, base: &str, token: &str) -> u16 {
    client
        .get(format!("{base}/api/v1/auth/me"))
        .header("Cookie", format!("__Host-session={token}"))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn test_db() -> PgPool {
    dotenvy::dotenv().ok();
    PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap()
}

/// The plaintext password must not be an accepted credential any more: only the
/// verifier derived from it in the browser is.
#[tokio::test]
async fn login_requires_a_verifier_not_a_password() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("verifier-{}@example.com", uuid::Uuid::now_v7());
    let account =
        common::register_test_account(&base, &client, &email, "correct horse battery staple").await;

    let rejected = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": account.email, "password": account.password }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), 400);

    let accepted = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": account.email, "verifier": account.verifier }))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);
}

/// A verifier is a fixed 32 bytes. Anything else is a malformed request, and
/// rejecting it before the rate limiter means a garbage body cannot spend the
/// account's login budget.
#[tokio::test]
async fn login_rejects_a_verifier_of_the_wrong_size() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("shortverifier-{}@example.com", uuid::Uuid::now_v7());
    let account =
        common::register_test_account(&base, &client, &email, "correct horse battery staple").await;

    let response = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": account.email, "verifier": "dG9vLXNob3J0" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}

/// The wrapper the browser sent at signup has to come back on every
/// authenticated response, or the vault cannot be opened after a sign-in.
#[tokio::test]
async fn login_returns_the_password_wrapper() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("wrapper-{}@example.com", uuid::Uuid::now_v7());
    let account =
        common::register_test_account(&base, &client, &email, "correct horse battery staple").await;

    let verify_body: serde_json::Value = client
        .get(format!("{base}/api/v1/auth/me"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        verify_body["data"]["wrapped_account_key"].as_str().unwrap(),
        account.wrapped_account_key
    );

    let body: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": account.email, "verifier": account.verifier }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        body["data"]["wrapped_account_key"].as_str().unwrap(),
        account.wrapped_account_key
    );

    let reauth: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/reauthenticate"))
        .json(&json!({ "verifier": account.verifier }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        reauth["data"]["wrapped_account_key"].as_str().unwrap(),
        account.wrapped_account_key
    );
}

/// No account may exist without a password wrapper: one that did would
/// authenticate fine and decrypt nothing.
#[tokio::test]
async fn verify_email_rejects_a_signup_without_a_wrapper() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("nowrapper-{}@example.com", uuid::Uuid::now_v7());

    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, "correct horse battery staple") }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"].as_str().unwrap();
    let code = common::latest_code_for(&email).await;

    let missing = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({ "pending_token": pending_token, "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 400);

    let wrong_size = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": "dG9vLXNob3J0",
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_size.status(), 400);

    // A malformed body must not have burned the pending signup.
    let accepted = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);
}

/// The invariant the whole design rests on: a `users` row always has exactly
/// two wrappers and exactly one live recovery code, because all three rows are
/// written in the transaction that creates the user. No bootstrap-repair path
/// is ever needed, because no account can exist in a half-enrolled state.
#[tokio::test]
async fn signup_creates_both_wrappers_and_one_active_recovery_code() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("wrapperrow-{}@example.com", uuid::Uuid::now_v7());
    let account =
        common::register_test_account(&base, &client, &email, "correct horse battery staple").await;

    let db = test_db().await;
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT method, wrapped_account_key FROM account_key_wrappers \
         WHERE user_id = $1 ORDER BY method",
    )
    .bind(account.user_id)
    .fetch_all(&db)
    .await
    .unwrap();

    assert_eq!(
        rows.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        vec!["password", "recovery_code"]
    );
    assert_eq!(rows[0].1, account.wrapped_account_key);
    assert_eq!(rows[1].1, account.wrapped_account_key_recovery);

    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vault_recovery_codes WHERE user_id = $1 AND used_at IS NULL",
    )
    .bind(account.user_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(active, 1);

    // The stored value is an Argon2 hash, never the verifier the browser sent:
    // a database read must yield nothing replayable.
    let stored: String =
        sqlx::query_scalar("SELECT verifier_hash FROM vault_recovery_codes WHERE user_id = $1")
            .bind(account.user_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(stored.starts_with("$argon2id$"));
    assert_ne!(stored, account.recovery_verifier);
}

/// A signup that carries no recovery material must not produce an account. One
/// that did would be permanently unrecoverable if the password were forgotten,
/// which is the exact failure this plan exists to remove.
#[tokio::test]
async fn verify_email_rejects_a_signup_missing_the_recovery_material() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("norecovery-{}@example.com", uuid::Uuid::now_v7());

    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, "correct horse battery staple") }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"].as_str().unwrap();
    let code = common::latest_code_for(&email).await;

    let missing = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 400);

    let wrong_size = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": "dG9vLXNob3J0",
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_size.status(), 400);

    let bad_verifier = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": "dG9vLXNob3J0",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_verifier.status(), 400);

    // None of those malformed bodies may have burned the pending signup.
    let accepted: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(accepted["success"], json!(true));
}
