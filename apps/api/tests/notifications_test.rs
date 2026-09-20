mod common;

use uuid::Uuid;

async fn test_db() -> sqlx::PgPool {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL").unwrap();
    sqlx::PgPool::connect(&database_url).await.unwrap()
}

#[tokio::test]
async fn form_members_carries_notification_columns() {
    let db = test_db().await;
    let found: i64 = sqlx::query_scalar(
        "SELECT count(*)
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'form_members'
           AND column_name IN ('notify_on_response', 'last_notified_at')",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(found, 2, "migration 0016 did not add both columns");
}

#[tokio::test]
async fn collaborators_default_to_notifications_off() {
    let db = test_db().await;
    let column_default: Option<String> = sqlx::query_scalar(
        "SELECT column_default
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'form_members'
           AND column_name = 'notify_on_response'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(column_default.as_deref(), Some("false"));
}

use reqwest::Client;
use serde_json::json;

fn base() -> String {
    common::base_url()
}

#[tokio::test]
async fn a_member_sets_only_their_own_notification_preference() {
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("notify-pref-{}@example.com", Uuid::now_v7());
    common::register_test_account(&base(), &client, &email, "correct horse battery").await;

    let created: serde_json::Value = client
        .post(format!("{}/api/v1/forms", base()))
        .json(&json!({
            "title_ciphertext": "title",
            "schema_ciphertext": "schema",
            "form_public_key": "public-key",
            "wrapped_form_data_key": "data-key",
            "wrapped_form_private_key": "private-key",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let form_id = created["data"]["id"].as_str().unwrap();

    // A newly created form's owner starts opted in.
    let form: serde_json::Value = client
        .get(format!("{}/api/v1/forms/{form_id}", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(form["data"]["notify_on_response"], json!(true));

    let patched: serde_json::Value = client
        .patch(format!("{}/api/v1/forms/{form_id}/members/me", base()))
        .json(&json!({ "notify_on_response": false }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(patched["success"], json!(true));
    assert_eq!(patched["data"]["notify_on_response"], json!(false));

    let form: serde_json::Value = client
        .get(format!("{}/api/v1/forms/{form_id}", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(form["data"]["notify_on_response"], json!(false));
}

// "Every owner row has notify_on_response = true" is not a property of the
// form_members table as a whole: direct-SQL fixtures elsewhere in the test
// suite (sharing::invitations::tests, sharing::cleanup::tests,
// attachments::cleanup::tests) INSERT INTO form_members with role = 'owner'
// without naming notify_on_response, so those rows legitimately take the
// column's false default. The only stable form of this property is per-form,
// scoped to a form created through the API.
#[tokio::test]
async fn a_form_created_through_the_api_opts_its_owner_in() {
    let db = test_db().await;
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("notify-optin-{}@example.com", Uuid::now_v7());
    common::register_test_account(&base(), &client, &email, "correct horse battery").await;

    let created: serde_json::Value = client
        .post(format!("{}/api/v1/forms", base()))
        .json(&json!({
            "title_ciphertext": "title",
            "schema_ciphertext": "schema",
            "form_public_key": "public-key",
            "wrapped_form_data_key": "data-key",
            "wrapped_form_private_key": "private-key",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let form_id: Uuid = created["data"]["id"].as_str().unwrap().parse().unwrap();

    let notify_on_response: bool = sqlx::query_scalar(
        "SELECT notify_on_response
         FROM form_members
         WHERE form_id = $1 AND role = 'owner'",
    )
    .bind(form_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(notify_on_response, "form creation did not opt its owner in");
}

#[tokio::test]
async fn a_non_member_cannot_set_a_notification_preference() {
    let owner = Client::builder().cookie_store(true).build().unwrap();
    let owner_email = format!("notify-owner-{}@example.com", Uuid::now_v7());
    common::register_test_account(&base(), &owner, &owner_email, "correct horse battery").await;

    let created: serde_json::Value = owner
        .post(format!("{}/api/v1/forms", base()))
        .json(&json!({
            "title_ciphertext": "title",
            "schema_ciphertext": "schema",
            "form_public_key": "public-key",
            "wrapped_form_data_key": "data-key",
            "wrapped_form_private_key": "private-key",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let form_id = created["data"]["id"].as_str().unwrap();

    let stranger = Client::builder().cookie_store(true).build().unwrap();
    let stranger_email = format!("notify-stranger-{}@example.com", Uuid::now_v7());
    common::register_test_account(&base(), &stranger, &stranger_email, "correct horse battery")
        .await;

    let response = stranger
        .patch(format!("{}/api/v1/forms/{form_id}/members/me", base()))
        .json(&json!({ "notify_on_response": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
}
