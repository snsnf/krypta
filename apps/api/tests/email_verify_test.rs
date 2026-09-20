mod common;

use common::{
    base_url, delivery_count_for, latest_code_for, latest_delivery_for, make_resend_eligible,
    next_delivery_for, pending_record, pending_ttl,
};
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Barrier;

const PASSWORD: &str = "correct horse battery staple";

fn guaranteed_different_code(code: &str) -> String {
    if code == "000000" {
        "000001".to_string()
    } else {
        "000000".to_string()
    }
}

async fn register_pending(client: &Client, email: &str) -> (serde_json::Value, String) {
    let body: serde_json::Value = client
        .post(format!("{}/api/v1/auth/register", base_url()))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = body["data"]["pending_token"].as_str().unwrap().to_string();
    (body, token)
}

async fn verify(client: &Client, token: &str, code: &str) -> reqwest::Response {
    client
        .post(format!("{}/api/v1/auth/verify-email", base_url()))
        .json(&json!({
            "pending_token": token,
            "code": code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn register_returns_a_pending_handle_and_no_session() {
    let base = base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("verify-{}@example.com", uuid::Uuid::now_v7());

    let res = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), 200);
    assert!(
        res.headers().get("set-cookie").is_none(),
        "register must not issue a session before the address is verified"
    );
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["data"]["verification_required"], json!(true));
    assert!(body["data"]["pending_token"].as_str().is_some());
    // Registration must leak no key material at all: not an account key
    // wrapper, not a salt, not anything beyond the handle needed to redeem the
    // mailed code. Asserting the exact key set is what keeps a later field
    // from being added here unnoticed.
    let mut keys: Vec<&String> = body["data"]
        .as_object()
        .expect("register data must be an object")
        .keys()
        .collect();
    keys.sort();
    assert_eq!(keys, ["pending_token", "verification_required"]);

    // The code really was mailed.
    let code = latest_code_for(&email).await;
    assert_eq!(code.len(), 6);
}

#[tokio::test]
async fn registering_an_existing_address_is_indistinguishable() {
    let base = base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("dup-{}@example.com", uuid::Uuid::now_v7());
    let password = "correct horse battery staple";

    common::register_test_account(&base, &client, &email, password).await;

    let second = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, "a different long password") }))
        .send()
        .await
        .unwrap();

    assert_eq!(second.status(), 200, "the duplicate case must not 400");
    assert!(
        second.headers().get("set-cookie").is_none(),
        "the duplicate case must not issue a session either"
    );
    let body: serde_json::Value = second.json().await.unwrap();
    assert_eq!(body["data"]["verification_required"], json!(true));
    assert!(body["data"]["pending_token"].as_str().is_some());
}

#[tokio::test]
async fn a_correct_code_creates_the_account_and_a_session() {
    let base = base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("ok-{}@example.com", uuid::Uuid::now_v7());

    common::register_test_account(&base, &client, &email, PASSWORD).await;

    // The session the verify step issued is real.
    let me = client
        .get(format!("{base}/api/v1/auth/me"))
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 200);
    let body: serde_json::Value = me.json().await.unwrap();
    assert_eq!(body["data"]["email"], json!(email));
}

#[tokio::test]
async fn a_wrong_code_is_rejected_and_the_handle_dies_after_the_cap() {
    let base = base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("wrong-{}@example.com", uuid::Uuid::now_v7());

    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
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
    let real_code = latest_code_for(&email).await;

    let wrong_code = guaranteed_different_code(&real_code);

    // Five guaranteed-wrong guesses exhaust the record.
    for _ in 0..5 {
        let res = client
            .post(format!("{base}/api/v1/auth/verify-email"))
            .json(&json!({
                "pending_token": pending_token,
                "code": wrong_code,
                "wrapped_account_key_password": common::opaque_wrapped_account_key(),
                "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
                "recovery_verifier": common::opaque_verifier(),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);
    }

    // Even the right code cannot revive it.
    let res = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": real_code,
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn a_decoy_handle_never_verifies() {
    let base = base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("decoy-{}@example.com", uuid::Uuid::now_v7());
    let password = "correct horse battery staple";

    common::register_test_account(&base, &client, &email, password).await;

    let second: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, password) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let decoy_token = second["data"]["pending_token"].as_str().unwrap();

    // Every possible code fails against a decoy; try a handful.
    for code in ["000000", "123456", "999999"] {
        let res = client
            .post(format!("{base}/api/v1/auth/verify-email"))
            .json(&json!({
                "pending_token": decoy_token,
                "code": code,
                "wrapped_account_key_password": common::opaque_wrapped_account_key(),
                "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
                "recovery_verifier": common::opaque_verifier(),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);
    }
}

#[tokio::test]
async fn an_unknown_handle_is_rejected() {
    let base = base_url();
    let client = Client::new();
    let res = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": "not-a-real-handle",
            "code": "123456",
            "wrapped_account_key_password": common::opaque_wrapped_account_key(),
            "wrapped_account_key_recovery": common::opaque_wrapped_account_key(),
            "recovery_verifier": common::opaque_verifier(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn resending_immediately_is_refused_by_the_cooldown() {
    let base = base_url();
    let client = Client::new();
    let email = format!("resend-{}@example.com", uuid::Uuid::now_v7());

    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"].as_str().unwrap();
    latest_code_for(&email).await;

    let res = client
        .post(format!("{base}/api/v1/auth/resend"))
        .json(&json!({ "pending_token": pending_token }))
        .send()
        .await
        .unwrap();

    assert_eq!(
        res.status(),
        429,
        "a resend inside the cooldown window must be refused"
    );
}

#[tokio::test]
async fn resending_with_an_unknown_handle_is_rejected() {
    let base = base_url();
    let client = Client::new();
    let res = client
        .post(format!("{base}/api/v1/auth/resend"))
        .json(&json!({ "pending_token": "not-a-real-handle" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn duplicate_registration_has_the_same_response_shape_as_fresh_registration() {
    let client = Client::new();
    let email = format!("shape-{}@example.com", uuid::Uuid::now_v7());
    let (mut fresh, token) = register_pending(&client, &email).await;
    let code = latest_code_for(&email).await;
    assert_eq!(verify(&client, &token, &code).await.status(), 200);

    let (mut duplicate, _) = register_pending(&client, &email).await;
    fresh["data"]["pending_token"] = json!("<opaque>");
    duplicate["data"]["pending_token"] = json!("<opaque>");
    assert_eq!(duplicate, fresh);
}

#[tokio::test]
async fn login_fails_until_the_email_has_been_verified() {
    let base = base_url();
    let client = Client::new();
    let email = format!("unverified-login-{}@example.com", uuid::Uuid::now_v7());
    register_pending(&client, &email).await;

    let login = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": email, "verifier": common::auth_verifier(&email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 401);
}

#[tokio::test]
async fn successful_resend_invalidates_the_old_code_and_accepts_the_new_one() {
    let base = base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("new-code-{}@example.com", uuid::Uuid::now_v7());
    let (_, token) = register_pending(&client, &email).await;
    let (old_message_id, old_code) = latest_delivery_for(&email).await;
    make_resend_eligible(&token).await;

    let resend = client
        .post(format!("{base}/api/v1/auth/resend"))
        .json(&json!({ "pending_token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 200);
    let (_, new_code) = next_delivery_for(&email, &old_message_id).await;
    assert_ne!(new_code, old_code, "resend must rotate the code");

    assert_eq!(verify(&client, &token, &old_code).await.status(), 401);
    assert_eq!(verify(&client, &token, &new_code).await.status(), 200);
}

#[tokio::test]
async fn failed_attempts_carry_across_resend_and_the_fifth_failure_deletes_state() {
    let base = base_url();
    let client = Client::new();
    let email = format!("attempt-carry-{}@example.com", uuid::Uuid::now_v7());
    let (_, token) = register_pending(&client, &email).await;
    let (old_message_id, old_code) = latest_delivery_for(&email).await;
    let wrong_old = guaranteed_different_code(&old_code);
    for _ in 0..4 {
        assert_eq!(verify(&client, &token, &wrong_old).await.status(), 401);
    }

    make_resend_eligible(&token).await;
    let resend = client
        .post(format!("{base}/api/v1/auth/resend"))
        .json(&json!({ "pending_token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 200);
    let (_, new_code) = next_delivery_for(&email, &old_message_id).await;
    let wrong_new = guaranteed_different_code(&new_code);

    assert_eq!(verify(&client, &token, &wrong_new).await.status(), 401);
    assert!(
        pending_record(&token).await.is_none(),
        "the fifth failed guess must delete the pending state"
    );
    assert_eq!(verify(&client, &token, &new_code).await.status(), 401);
}

#[tokio::test]
async fn no_more_than_three_resends_are_delivered() {
    let base = base_url();
    let client = Client::new();
    let email = format!("max-resends-{}@example.com", uuid::Uuid::now_v7());
    let (_, token) = register_pending(&client, &email).await;
    let (mut previous_id, _) = latest_delivery_for(&email).await;

    for _ in 0..3 {
        make_resend_eligible(&token).await;
        let resend = client
            .post(format!("{base}/api/v1/auth/resend"))
            .json(&json!({ "pending_token": token }))
            .send()
            .await
            .unwrap();
        assert_eq!(resend.status(), 200);
        previous_id = next_delivery_for(&email, &previous_id).await.0;
    }
    assert_eq!(delivery_count_for(&email).await, 4);

    make_resend_eligible(&token).await;
    let fourth = client
        .post(format!("{base}/api/v1/auth/resend"))
        .json(&json!({ "pending_token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(fourth.status(), 429);
    assert_eq!(delivery_count_for(&email).await, 4);
}

#[tokio::test]
async fn resend_preserves_the_original_expiry_and_redis_ttl() {
    let base = base_url();
    let client = Client::new();
    let email = format!("expiry-{}@example.com", uuid::Uuid::now_v7());
    let (_, token) = register_pending(&client, &email).await;
    latest_code_for(&email).await;
    let before_record = pending_record(&token).await.unwrap();
    let before_ttl = pending_ttl(&token).await;
    make_resend_eligible(&token).await;

    let resend = client
        .post(format!("{base}/api/v1/auth/resend"))
        .json(&json!({ "pending_token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 200);
    let after_record = pending_record(&token).await.unwrap();
    let after_ttl = pending_ttl(&token).await;
    assert_eq!(after_record["expires_at"], before_record["expires_at"]);
    assert!(
        after_ttl <= before_ttl,
        "resend extended Redis TTL from {before_ttl}s to {after_ttl}s"
    );
}

#[tokio::test]
async fn verified_request_is_idempotent_after_user_and_session_side_effects() {
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("idempotent-{}@example.com", uuid::Uuid::now_v7());
    let (_, token) = register_pending(&client, &email).await;
    let code = latest_code_for(&email).await;

    let first = verify(&client, &token, &code).await;
    assert_eq!(first.status(), 200);
    let first_body: serde_json::Value = first.json().await.unwrap();
    let retry = verify(&client, &token, &code).await;
    assert_eq!(retry.status(), 200);
    let retry_body: serde_json::Value = retry.json().await.unwrap();
    assert_eq!(retry_body["data"]["user_id"], first_body["data"]["user_id"]);
    assert_eq!(retry_body, first_body);
}

#[tokio::test]
async fn concurrent_wrong_codes_cannot_lose_attempts() {
    let client = Client::new();
    let email = format!("concurrent-wrong-{}@example.com", uuid::Uuid::now_v7());
    let (_, token) = register_pending(&client, &email).await;
    let real_code = latest_code_for(&email).await;
    let wrong_code = guaranteed_different_code(&real_code);
    let barrier = Arc::new(Barrier::new(6));
    let mut tasks = Vec::new();

    for _ in 0..5 {
        let barrier = barrier.clone();
        let token = token.clone();
        let wrong_code = wrong_code.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            verify(&Client::new(), &token, &wrong_code).await.status()
        }));
    }
    barrier.wait().await;
    for task in tasks {
        assert_eq!(task.await.unwrap(), 401);
    }
    assert_eq!(verify(&client, &token, &real_code).await.status(), 401);
}

#[tokio::test]
async fn concurrent_resends_deliver_exactly_one_new_message() {
    let base = base_url();
    let client = Client::new();
    let email = format!("concurrent-resend-{}@example.com", uuid::Uuid::now_v7());
    let (_, token) = register_pending(&client, &email).await;
    let (previous_id, _) = latest_delivery_for(&email).await;
    make_resend_eligible(&token).await;
    let barrier = Arc::new(Barrier::new(9));
    let mut tasks = Vec::new();

    for _ in 0..8 {
        let base = base.clone();
        let barrier = barrier.clone();
        let token = token.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            Client::new()
                .post(format!("{base}/api/v1/auth/resend"))
                .json(&json!({ "pending_token": token }))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }));
    }
    barrier.wait().await;
    let mut statuses = Vec::new();
    for task in tasks {
        statuses.push(task.await.unwrap());
    }
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 429, 429, 429, 429, 429, 429, 429]);
    next_delivery_for(&email, &previous_id).await;
    assert_eq!(delivery_count_for(&email).await, 2);
}

#[tokio::test]
async fn malformed_verification_bodies_use_the_standard_error_envelope() {
    let base = base_url();
    let client = Client::new();

    for path in ["verify-email", "resend"] {
        let res = client
            .post(format!("{base}/api/v1/auth/{path}"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body("{")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let body: serde_json::Value = res
            .json()
            .await
            .unwrap_or_else(|_| panic!("{path} returned a non-envelope rejection"));
        assert_eq!(body["success"], json!(false));
        assert_eq!(body["data"], json!({}));
        assert_eq!(body["meta"], json!({}));
        assert_eq!(body["error"]["code"], json!("bad_request"));
    }
}

/// Every decorated spelling of one inbox used to get its own per-address
/// counter while all of them were delivered to that inbox. They are refused
/// now, before anything is keyed or mailed.
#[tokio::test]
async fn a_decorated_address_is_refused_before_anything_is_mailed() {
    let client = Client::new();
    let bare = format!("decorated-{}@example.com", uuid::Uuid::now_v7());
    for decorated in [format!("Someone <{bare}>"), format!(" {bare}")] {
        let response = client
            .post(format!("{}/api/v1/auth/register", base_url()))
            .json(&json!({
                "email": decorated,
                "verifier": common::auth_verifier(&bare, PASSWORD),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "{decorated:?}");
    }
    assert_eq!(common::delivery_count_for(&bare).await, 0);
}
