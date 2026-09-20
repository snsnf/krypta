mod common;

use reqwest::Client;
use serde_json::json;
use sqlx::PgPool;
use totp_rs::Totp;

const PASSWORD: &str = "correct horse battery staple";

fn base() -> String {
    std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string())
}

// The authenticator helpers live in `common` because the recovery suite needs
// them too: `code_from_next_step` in particular encodes a rule of the design
// (enrolment spends its own timestep), and two copies of that rule would drift.
use common::{authenticator_from, code_from_next_step, code_now};

async fn register(client: &Client, email: &str) {
    common::register_test_account(&base(), client, email, PASSWORD).await;
}

async fn enrol(client: &Client) -> (Totp, Vec<String>) {
    let setup: serde_json::Value = client
        .post(format!("{}/api/v1/auth/2fa/setup", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let uri = setup["data"]["provisioning_uri"].as_str().unwrap();
    let totp = authenticator_from(uri);

    let res = client
        .post(format!("{}/api/v1/auth/2fa/enable", base()))
        .json(&json!({
            "code": code_now(&totp),
            "reauthentication_receipt":
                common::reauthentication_receipt(&base(), client, PASSWORD).await,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "enable should accept a fresh code");
    let body: serde_json::Value = res.json().await.unwrap();
    let codes = body["data"]["recovery_codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect();
    (totp, codes)
}

#[tokio::test]
async fn login_requires_a_code_once_enrolled_and_then_issues_a_session() {
    let email = format!("totp-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let (totp, _) = enrol(&client).await;

    // A fresh client, so only the credential is on hand.
    let fresh = Client::builder().cookie_store(true).build().unwrap();
    let login: serde_json::Value = fresh
        .post(format!("{}/api/v1/auth/login", base()))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(login["data"]["totp_required"], json!(true));
    let pending = login["data"]["pending_token"].as_str().unwrap().to_string();

    // The password step alone must not authenticate.
    let me = fresh
        .get(format!("{}/api/v1/auth/me", base()))
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 401, "password alone must not grant a session");

    let verify = fresh
        .post(format!("{}/api/v1/auth/2fa/verify", base()))
        .json(&json!({ "pending_token": pending, "code": code_from_next_step(&totp).await }))
        .send()
        .await
        .unwrap();
    assert_eq!(verify.status(), 200);
    let body: serde_json::Value = verify.json().await.unwrap();
    assert!(body["data"]["user_id"].as_str().is_some());

    assert_eq!(
        fresh
            .get(format!("{}/api/v1/auth/me", base()))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn an_authenticated_totp_account_can_reauthenticate_with_its_verifier() {
    let email = format!("totp-reauth-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    enrol(&client).await;

    let response = client
        .post(format!("{}/api/v1/auth/reauthenticate", base()))
        .json(&json!({ "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["data"]["user_id"].as_str().is_some());
    assert!(body["data"]["pending_token"].is_null());
    assert!(body["data"]["totp_required"].is_null());
}

#[tokio::test]
async fn a_pending_token_cannot_be_reused() {
    let email = format!("totp-reuse-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let (totp, _) = enrol(&client).await;

    let fresh = Client::builder().build().unwrap();
    let login: serde_json::Value = fresh
        .post(format!("{}/api/v1/auth/login", base()))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending = login["data"]["pending_token"].as_str().unwrap().to_string();

    // A wrong code burns the handle, so the password step has to be repeated
    // rather than the code guessed over and over.
    let first = fresh
        .post(format!("{}/api/v1/auth/2fa/verify", base()))
        .json(&json!({ "pending_token": pending, "code": "000000" }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 401);

    let second = fresh
        .post(format!("{}/api/v1/auth/2fa/verify", base()))
        .json(&json!({ "pending_token": pending, "code": code_now(&totp) }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        second.status(),
        401,
        "a spent pending token must not be redeemable"
    );
}

#[tokio::test]
async fn a_recovery_code_works_once_and_only_once() {
    let email = format!("totp-recovery-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let (_, codes) = enrol(&client).await;
    assert_eq!(codes.len(), 8);
    let code = codes[0].clone();

    for (attempt, expected) in [(1, 200), (2, 401)] {
        let fresh = Client::builder().build().unwrap();
        let login: serde_json::Value = fresh
            .post(format!("{}/api/v1/auth/login", base()))
            .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let pending = login["data"]["pending_token"].as_str().unwrap();

        let res = fresh
            .post(format!("{}/api/v1/auth/2fa/verify", base()))
            .json(&json!({ "pending_token": pending, "code": code }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            expected,
            "recovery code attempt {attempt} should be {expected}"
        );
    }
}

#[tokio::test]
async fn the_same_code_cannot_be_replayed_within_its_window() {
    let email = format!("totp-replay-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let (totp, _) = enrol(&client).await;
    let code = code_now(&totp);

    let mut statuses = Vec::new();
    for _ in 0..2 {
        let fresh = Client::builder().build().unwrap();
        let login: serde_json::Value = fresh
            .post(format!("{}/api/v1/auth/login", base()))
            .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let pending = login["data"]["pending_token"].as_str().unwrap();
        statuses.push(
            fresh
                .post(format!("{}/api/v1/auth/2fa/verify", base()))
                .json(&json!({ "pending_token": pending, "code": code }))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
        );
    }

    // enable() already consumed this step, so both login attempts are replays.
    assert_eq!(
        statuses,
        vec![401, 401],
        "a code already used must not be accepted again"
    );
}

#[tokio::test]
async fn suspended_accounts_cannot_finish_a_pending_totp_login() {
    let email = format!("totp-suspended-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let (totp, _) = enrol(&client).await;

    let fresh = Client::builder().build().unwrap();
    let login: serde_json::Value = fresh
        .post(format!("{}/api/v1/auth/login", base()))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending = login["data"]["pending_token"].as_str().unwrap().to_string();

    let db = test_db().await;
    sqlx::query("UPDATE users SET suspended_at = now() WHERE email = $1")
        .bind(&email)
        .execute(&db)
        .await
        .unwrap();

    let verify = fresh
        .post(format!("{}/api/v1/auth/2fa/verify", base()))
        .json(&json!({ "pending_token": pending, "code": code_from_next_step(&totp).await }))
        .send()
        .await
        .unwrap();
    assert_eq!(verify.status(), 401);
    let body: serde_json::Value = verify.json().await.unwrap();
    assert_eq!(body["error"]["code"], "unauthorized");
    assert!(
        body["data"]["user_id"].is_null(),
        "suspended accounts must not complete the TOTP step"
    );

    let me = fresh
        .get(format!("{}/api/v1/auth/me", base()))
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 401);
}

#[tokio::test]
async fn code_guesses_are_capped_per_account_not_only_per_address() {
    let email = format!("totp-guess-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let (_, codes) = enrol(&client).await;

    // Disable checks a code from an authenticated session and used to accept
    // as many guesses as the caller cared to send. Enrolment already spent one
    // attempt, so the cap of ten per minute is reached within the next ten.
    let mut statuses = Vec::new();
    for _ in 0..12 {
        let attempt = client
            .post(format!("{}/api/v1/auth/2fa/disable", base()))
            .json(&json!({ "code": "000000" }))
            .send()
            .await
            .unwrap();
        statuses.push(attempt.status().as_u16());
    }
    assert_eq!(statuses[0], 400, "a wrong code is still just a wrong code");
    assert!(
        statuses.contains(&429),
        "twelve wrong guesses must trip the per-account cap, got {statuses:?}"
    );
    assert!(
        !statuses.contains(&200),
        "no wrong guess may ever succeed, got {statuses:?}"
    );

    // Once capped, even the right recovery code waits for the window: the
    // limiter runs before the check, or it would meter only failures.
    let capped = client
        .post(format!("{}/api/v1/auth/2fa/disable", base()))
        .json(&json!({ "code": codes[0] }))
        .send()
        .await
        .unwrap();
    assert_eq!(capped.status(), 429);
}

#[tokio::test]
async fn disabling_requires_a_valid_code_and_restores_single_step_login() {
    let email = format!("totp-disable-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let (_, codes) = enrol(&client).await;

    let bad = client
        .post(format!("{}/api/v1/auth/2fa/disable", base()))
        .json(&json!({ "code": "000000" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400, "a wrong code must not disable 2FA");

    // A recovery code is accepted here too, which matters when the phone is lost.
    let good = client
        .post(format!("{}/api/v1/auth/2fa/disable", base()))
        .json(&json!({ "code": codes[1] }))
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), 200);

    let fresh = Client::builder().cookie_store(true).build().unwrap();
    let login: serde_json::Value = fresh
        .post(format!("{}/api/v1/auth/login", base()))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        login["data"]["totp_required"].is_null(),
        "login should be single-step again"
    );
    assert!(login["data"]["user_id"].as_str().is_some());
}

async fn test_db() -> PgPool {
    dotenvy::dotenv().ok();
    PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap()
}

/// Enrolling a factor from a session alone would let whoever holds a stolen
/// session lock the real owner out at their next login.
#[tokio::test]
async fn enabling_requires_a_fresh_password_proof() {
    let email = format!("totp-reauth-{}@example.com", uuid::Uuid::now_v7());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register(&client, &email).await;
    let setup: serde_json::Value = client
        .post(format!("{}/api/v1/auth/2fa/setup", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let totp = authenticator_from(setup["data"]["provisioning_uri"].as_str().unwrap());

    let res = client
        .post(format!("{}/api/v1/auth/2fa/enable", base()))
        .json(&json!({ "code": code_now(&totp), "reauthentication_receipt": "not-a-receipt" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    let me: serde_json::Value = client
        .get(format!("{}/api/v1/auth/me", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me["data"]["totp_enabled"], false);
}
