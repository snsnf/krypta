//! Regenerating a vault recovery code from account settings.
//!
//! The account key must never change here, so the server-visible surface is
//! narrow: the recovery wrapper row is replaced, the old recovery code row is
//! marked spent, a fresh one is inserted, and the password wrapper and
//! session are untouched. `regeneration_swaps_the_wrapper_and_rotates_the_code`
//! pins the database side of that; `old_code_stops_working_new_code_works`
//! proves it end to end through the real recovery flow.

mod common;

use reqwest::Client;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

const PASSWORD: &str = "correct horse battery staple";

fn base() -> String {
    common::base_url()
}

async fn test_db() -> PgPool {
    dotenvy::dotenv().ok();
    PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap()
}

async fn reauthenticate_receipt(client: &Client, email: &str) -> String {
    let response = client
        .post(format!("{}/api/v1/auth/reauthenticate", base()))
        .json(&json!({ "verifier": common::auth_verifier(email, PASSWORD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "reauthenticate was refused");
    response.json::<serde_json::Value>().await.unwrap()["data"]["reauthentication_receipt"]
        .as_str()
        .unwrap()
        .to_string()
}

struct Replacement {
    recovery_verifier: String,
    wrapped_account_key_recovery: String,
}

fn replacement() -> Replacement {
    Replacement {
        recovery_verifier: common::opaque_verifier(),
        wrapped_account_key_recovery: common::opaque_wrapped_account_key(),
    }
}

async fn regenerate(
    client: &Client,
    receipt: &str,
    replacement: &Replacement,
) -> reqwest::Response {
    client
        .post(format!("{}/api/v1/account/recovery-code", base()))
        .json(&json!({
            "reauthentication_receipt": receipt,
            "recovery_verifier": replacement.recovery_verifier,
            "wrapped_account_key_recovery": replacement.wrapped_account_key_recovery,
        }))
        .send()
        .await
        .unwrap()
}

/// The happy path, checked at the database: the recovery wrapper now holds the
/// new blob, the old code row is spent, a new live row exists, and the
/// password wrapper never moved.
#[tokio::test]
async fn regeneration_swaps_the_wrapper_and_rotates_the_code() {
    let db = test_db().await;
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("regen-{}@example.com", Uuid::now_v7());
    let account = common::register_test_account(&base(), &client, &email, PASSWORD).await;

    let receipt = reauthenticate_receipt(&client, &email).await;
    let replacement = replacement();
    let response = regenerate(&client, &receipt, &replacement).await;
    assert_eq!(response.status(), 200, "regeneration was refused");

    let wrapper: String = sqlx::query_scalar(
        "SELECT wrapped_account_key FROM account_key_wrappers \
         WHERE user_id = $1 AND method = 'recovery_code'",
    )
    .bind(account.user_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(wrapper, replacement.wrapped_account_key_recovery);

    let password_wrapper: String = sqlx::query_scalar(
        "SELECT wrapped_account_key FROM account_key_wrappers \
         WHERE user_id = $1 AND method = 'password'",
    )
    .bind(account.user_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        password_wrapper, account.wrapped_account_key,
        "the password wrapper must not move when only the recovery code is regenerated"
    );

    let live_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vault_recovery_codes \
         WHERE user_id = $1 AND used_at IS NULL",
    )
    .bind(account.user_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(live_count, 1, "exactly one live recovery code must remain");

    let spent_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vault_recovery_codes \
         WHERE user_id = $1 AND used_at IS NOT NULL",
    )
    .bind(account.user_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        spent_count, 1,
        "the original recovery code must be retained, spent"
    );
}

/// A missing or wrong receipt must not rotate anything: no session alone
/// should ever be enough to mint standing vault access.
#[tokio::test]
async fn a_missing_or_invalid_receipt_is_rejected() {
    let db = test_db().await;
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("regen-bad-receipt-{}@example.com", Uuid::now_v7());
    let account = common::register_test_account(&base(), &client, &email, PASSWORD).await;

    let replacement = replacement();

    let missing = regenerate(&client, "not-a-real-receipt", &replacement).await;
    assert_eq!(missing.status(), 401);

    // A receipt minted for a different account must not work either.
    let other_email = format!("regen-other-{}@example.com", Uuid::now_v7());
    let other_client = Client::builder().cookie_store(true).build().unwrap();
    common::register_test_account(&base(), &other_client, &other_email, PASSWORD).await;
    let other_receipt = reauthenticate_receipt(&other_client, &other_email).await;
    let cross_account = regenerate(&client, &other_receipt, &replacement).await;
    assert_eq!(cross_account.status(), 401);

    let live_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vault_recovery_codes \
         WHERE user_id = $1 AND used_at IS NULL",
    )
    .bind(account.user_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        live_count, 1,
        "a rejected regeneration must not touch the live recovery code"
    );
}

/// After regeneration, the previous recovery code is dead and the new one is
/// live, proven through the real `/auth/recover/start` + `/auth/recover/verify`
/// pair rather than a database assertion.
#[tokio::test]
async fn old_code_stops_working_new_code_works() {
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("regen-flow-{}@example.com", Uuid::now_v7());
    let account = common::register_test_account(&base(), &client, &email, PASSWORD).await;

    let receipt = reauthenticate_receipt(&client, &email).await;
    let replacement = replacement();
    let response = regenerate(&client, &receipt, &replacement).await;
    assert_eq!(response.status(), 200, "regeneration was refused");

    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;

    let old_attempt = common::recover_verify(
        &base(),
        &Client::builder().build().unwrap(),
        &pending_token,
        &code,
        &account.recovery_verifier,
        None,
    )
    .await;
    assert_eq!(
        old_attempt.status(),
        401,
        "the recovery code shown at signup must stop working immediately"
    );

    // Recovery is single-shot per pending token/email code pairing in this
    // suite's flow, so a fresh start is needed for the second attempt.
    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;

    let new_attempt = common::recover_verify(
        &base(),
        &Client::builder().build().unwrap(),
        &pending_token,
        &code,
        &replacement.recovery_verifier,
        None,
    )
    .await;
    assert_eq!(
        new_attempt.status(),
        200,
        "the newly generated recovery code must work"
    );
}
