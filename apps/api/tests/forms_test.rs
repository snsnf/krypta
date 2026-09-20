mod common;

use reqwest::Client;
use serde_json::json;
use uuid::Uuid;

async fn test_db() -> sqlx::PgPool {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL").unwrap();
    sqlx::PgPool::connect(&database_url).await.unwrap()
}

async fn register_and_login(client: &Client, base: &str) {
    let email = format!("test-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(base, client, &email, "correct horse battery staple").await;
}

async fn current_version(client: &Client, base: &str, form_id: &str) -> i64 {
    let response = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json::<serde_json::Value>().await.unwrap()["data"]["version"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn create_then_list_forms() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "ct-title",
            "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey",
            "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create_res.status(), 200);
    let create_body: serde_json::Value = create_res.json().await.unwrap();
    let form_id = create_body["data"]["id"].as_str().unwrap().to_string();

    let list_res = client
        .get(format!("{base}/api/v1/forms"))
        .send()
        .await
        .unwrap();
    assert_eq!(list_res.status(), 200);
    let list_body: serde_json::Value = list_res.json().await.unwrap();
    let forms = list_body["data"]["forms"].as_array().unwrap();
    assert!(forms.iter().any(|f| f["id"].as_str().unwrap() == form_id));
}

/// The dashboard renames a form using the version its list was read at, so a
/// listed version has to work as `expected_version` and has to go stale as soon
/// as anyone writes. Re-reading the version just before the write instead would
/// defeat the guard entirely: it would pick up the other write's version, and
/// the rename would overwrite it with no conflict raised.
#[tokio::test]
async fn a_listed_version_works_as_expected_version_and_goes_stale() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "ct-title",
            "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey",
            "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let create_body: serde_json::Value = create_res.json().await.unwrap();
    let form_id = create_body["data"]["id"].as_str().unwrap().to_string();

    async fn listed_version(client: &Client, base: &str, form_id: &str) -> i64 {
        let res = client
            .get(format!("{base}/api/v1/forms"))
            .send()
            .await
            .unwrap();
        let body: serde_json::Value = res.json().await.unwrap();
        body["data"]["forms"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"].as_str().unwrap() == form_id)
            .unwrap()["version"]
            .as_i64()
            .unwrap()
    }

    let read_at = listed_version(&client, &base, &form_id).await;
    assert_eq!(read_at, 1);

    let renamed = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({ "title_ciphertext": "ct-renamed", "expected_version": read_at }))
        .send()
        .await
        .unwrap();
    assert_eq!(renamed.status(), 200);

    // The same version a second time is now stale, which is exactly the case
    // that a fresh pre-write read would have papered over.
    let stale = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({ "title_ciphertext": "ct-clobber", "expected_version": read_at }))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 409);

    assert_eq!(listed_version(&client, &base, &form_id).await, 2);
}

#[tokio::test]
async fn get_form_owner_vs_public() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let owner_res = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(owner_res.status(), 200);
    let owner_body: serde_json::Value = owner_res.json().await.unwrap();
    assert_eq!(owner_body["data"]["role"], "owner");
    assert_eq!(owner_body["data"]["membership_state"], "active");
    assert_eq!(owner_body["data"]["key_scheme"], "master_wrap_v1");
    assert_eq!(
        owner_body["data"]["encrypted_form_data_key"],
        "wrapped-data-key"
    );
    assert_eq!(
        owner_body["data"]["encrypted_form_private_key"],
        "wrapped-priv"
    );
    assert_eq!(owner_body["data"]["version"], 1);
    assert_eq!(owner_body["data"]["accepting_responses"], true);

    let anon_client = reqwest::Client::new();
    let public_res = anon_client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap();
    assert_eq!(public_res.status(), 200);
    let public_body: serde_json::Value = public_res.json().await.unwrap();
    assert!(
        public_body["data"]
            .get("wrapped_form_private_key")
            .is_none()
    );
    assert_eq!(
        public_body["data"]["title_ciphertext"].as_str().unwrap(),
        "ct-title"
    );
    assert_eq!(public_body["data"]["accepting_responses"], true);
}

#[tokio::test]
async fn anonymous_can_submit_response() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let anon_client = reqwest::Client::new();
    let submit_res = anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&serde_json::json!({ "ciphertext": "sealed-response-bytes" }))
        .send()
        .await
        .unwrap();
    assert_eq!(submit_res.status(), 200);
}

#[tokio::test]
async fn owner_can_list_responses_but_anon_cannot() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let anon_client = reqwest::Client::new();
    anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&serde_json::json!({ "ciphertext": "sealed-response-bytes" }))
        .send()
        .await
        .unwrap();

    let owner_list = client
        .get(format!("{base}/api/v1/forms/{form_id}/responses"))
        .send()
        .await
        .unwrap();
    assert_eq!(owner_list.status(), 200);
    let owner_body: serde_json::Value = owner_list.json().await.unwrap();
    assert_eq!(owner_body["data"]["responses"].as_array().unwrap().len(), 1);

    let anon_list = anon_client
        .get(format!("{base}/api/v1/forms/{form_id}/responses"))
        .send()
        .await
        .unwrap();
    assert_eq!(anon_list.status(), 401);
}

#[tokio::test]
async fn owner_can_update_form_title_and_schema() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let expected_version = current_version(&client, &base, &form_id).await;

    let patch_res = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title-updated",
            "schema_ciphertext": "ct-schema-updated",
            "expected_version": expected_version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_res.status(), 200);

    let get_res = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    let get_body: serde_json::Value = get_res.json().await.unwrap();
    assert_eq!(
        get_body["data"]["title_ciphertext"].as_str().unwrap(),
        "ct-title-updated"
    );
    assert_eq!(
        get_body["data"]["schema_ciphertext"].as_str().unwrap(),
        "ct-schema-updated"
    );
}

#[tokio::test]
async fn non_owner_cannot_update_form() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner_client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&owner_client, &base).await;

    let create_res = owner_client
        .post(format!("{base}/api/v1/forms"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let expected_version = current_version(&owner_client, &base, &form_id).await;

    let other_client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&other_client, &base).await;

    let patch_res = other_client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&serde_json::json!({
            "title_ciphertext": "hijacked-title",
            "schema_ciphertext": "hijacked-schema",
            "expected_version": expected_version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_res.status(), 404);
}

#[tokio::test]
async fn update_nonexistent_form_returns_not_found() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&client, &base).await;

    let random_id = uuid::Uuid::now_v7();
    let patch_res = client
        .patch(format!("{base}/api/v1/forms/{random_id}"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title",
            "schema_ciphertext": "ct-schema",
            "expected_version": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_res.status(), 404);
}

#[tokio::test]
async fn editable_form_returns_token_and_accepts_edit() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let expected_version = current_version(&client, &base, &form_id).await;

    let patch_res = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&serde_json::json!({
            "allow_response_editing": true,
            "expected_version": expected_version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_res.status(), 200);

    let get_res = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    let get_body: serde_json::Value = get_res.json().await.unwrap();
    assert_eq!(get_body["data"]["allow_response_editing"], true);

    let anon_client = reqwest::Client::new();
    let submit_res = anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&serde_json::json!({ "ciphertext": "sealed-response-bytes" }))
        .send()
        .await
        .unwrap();
    let submit_body: serde_json::Value = submit_res.json().await.unwrap();
    let edit_token = submit_body["data"]["edit_token"]
        .as_str()
        .unwrap()
        .to_string();

    let edit_res = anon_client
        .patch(format!("{base}/api/v1/forms/{form_id}/responses/edit"))
        .header("X-Response-Token", &edit_token)
        .json(&serde_json::json!({ "ciphertext": "sealed-response-bytes-v2" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit_res.status(), 200);

    let owner_list = client
        .get(format!("{base}/api/v1/forms/{form_id}/responses"))
        .send()
        .await
        .unwrap();
    let owner_body: serde_json::Value = owner_list.json().await.unwrap();
    assert_eq!(
        owner_body["data"]["responses"][0]["ciphertext"],
        "sealed-response-bytes-v2"
    );
}

#[tokio::test]
async fn non_editable_form_returns_no_token_and_rejects_edit() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&serde_json::json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let anon_client = reqwest::Client::new();
    let submit_res = anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&serde_json::json!({ "ciphertext": "sealed-response-bytes" }))
        .send()
        .await
        .unwrap();
    let submit_body: serde_json::Value = submit_res.json().await.unwrap();
    assert!(submit_body["data"]["edit_token"].is_null());

    let edit_res = anon_client
        .patch(format!("{base}/api/v1/forms/{form_id}/responses/edit"))
        .header("X-Response-Token", "not-a-real-token")
        .json(&serde_json::json!({ "ciphertext": "sealed-response-bytes-v2" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit_res.status(), 404);
}

#[tokio::test]
async fn stale_form_version_returns_conflict_without_overwriting_ciphertext() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(current_version(&client, &base, &form_id).await, 1);

    let first_save = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "title_ciphertext": "first-save",
            "expected_version": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first_save.status(), 200);
    let first_body: serde_json::Value = first_save.json().await.unwrap();
    assert_eq!(first_body["data"]["version"], 2);

    let stale_save = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "title_ciphertext": "stale-overwrite",
            "expected_version": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(stale_save.status(), 409);
    let stale_body: serde_json::Value = stale_save.json().await.unwrap();
    assert_eq!(stale_body["error"]["code"], "conflict");

    let form = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(form["data"]["title_ciphertext"], "first-save");
    assert_eq!(form["data"]["version"], 2);
}

#[tokio::test]
async fn closed_form_remains_publicly_readable_but_rejects_submissions() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;

    let create_res = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "ct-title", "schema_ciphertext": "ct-schema",
            "form_public_key": "pubkey", "wrapped_form_private_key": "wrapped-priv",
            "wrapped_form_data_key": "wrapped-data-key",
        }))
        .send()
        .await
        .unwrap();
    let form_id = create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let expected_version = current_version(&client, &base, &form_id).await;

    let close = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "accepting_responses": false,
            "expected_version": expected_version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(close.status(), 200);

    let anonymous = Client::new();
    let public = anonymous
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap();
    assert_eq!(public.status(), 200);
    let public_body: serde_json::Value = public.json().await.unwrap();
    assert_eq!(public_body["data"]["title_ciphertext"], "ct-title");
    assert_eq!(public_body["data"]["accepting_responses"], false);

    let submission = anonymous
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "must-not-be-stored" }))
        .send()
        .await
        .unwrap();
    assert_eq!(submission.status(), 409);
    let submission_body: serde_json::Value = submission.json().await.unwrap();
    assert_eq!(submission_body["error"]["code"], "form_closed");
    assert_eq!(submission_body["error"]["message"], "Form is closed");
}

async fn create_test_form(client: &Client, base: &str) -> String {
    let created: serde_json::Value = client
        .post(format!("{base}/api/v1/forms"))
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
    created["data"]["id"].as_str().unwrap().to_string()
}

/// PATCHes the limits. Calls the file's existing `current_version` helper
/// because every mutation carries `expected_version` and a stale one is a 409.
async fn set_limits(
    client: &Client,
    base: &str,
    form_id: &str,
    closes_at: Option<&str>,
    max_responses: Option<i32>,
) {
    let version = current_version(client, base, form_id).await;

    let mut body = json!({ "expected_version": version });
    if let Some(closes_at) = closes_at {
        body["closes_at"] = json!(closes_at);
    }
    if let Some(max_responses) = max_responses {
        body["max_responses"] = json!(max_responses);
    }
    let response = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "PATCH failed: {:?}",
        response.status()
    );
}

#[tokio::test]
async fn a_past_close_date_closes_the_form() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_limits(&client, &base, &form_id, Some("2000-01-01T00:00:00Z"), None).await;

    let public: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(public["data"]["accepting_responses"], json!(false));

    let submit = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap();
    assert_eq!(submit.status(), reqwest::StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_future_close_date_leaves_the_form_open() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_limits(&client, &base, &form_id, Some("2099-01-01T00:00:00Z"), None).await;

    let submit = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap();
    assert!(
        submit.status().is_success(),
        "a future close date must not close the form"
    );
}

#[tokio::test]
async fn a_reached_cap_closes_the_form_and_raising_it_reopens() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_limits(&client, &base, &form_id, None, Some(1)).await;

    let first = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap();
    assert!(first.status().is_success());

    let second = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), reqwest::StatusCode::CONFLICT);

    set_limits(&client, &base, &form_id, None, Some(2)).await;
    let third = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap();
    assert!(
        third.status().is_success(),
        "raising the cap must reopen the form"
    );
}

/// The reason this feature counts responses under the form's row lock.
///
/// Two submissions issued together against a form one below its cap must not
/// both succeed. If the count is taken before the lock, both read the same
/// value, both pass, and the cap is exceeded.
#[tokio::test]
async fn concurrent_submissions_cannot_exceed_the_cap() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_limits(&client, &base, &form_id, None, Some(1)).await;

    let anon_a = Client::new();
    let anon_b = Client::new();
    let url = format!("{base}/api/v1/forms/{form_id}/responses");
    let body = json!({ "ciphertext": "sealed" });
    let (a, b) = tokio::join!(
        anon_a.post(&url).json(&body).send(),
        anon_b.post(&url).json(&body).send(),
    );
    let statuses = [a.unwrap().status(), b.unwrap().status()];
    let accepted = statuses.iter().filter(|s| s.is_success()).count();
    assert_eq!(
        accepted, 1,
        "exactly one of two racing submissions may be accepted: {statuses:?}"
    );
}

#[tokio::test]
async fn a_zero_cap_is_refused_by_the_database() {
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let result = sqlx::query("UPDATE forms SET max_responses = 0 WHERE false")
        .execute(&db)
        .await;
    assert!(result.is_ok(), "a no-op update must not fail");

    let form_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO forms (id, title_ciphertext, schema_ciphertext, form_public_key, max_responses)
         VALUES ($1, 'title', 'schema', 'public-key', 0)",
    )
    .bind(form_id)
    .execute(&db)
    .await
    .expect_err("a cap of zero must violate the check constraint");
}

#[tokio::test]
async fn limits_can_be_set_and_then_cleared() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_limits(
        &client,
        &base,
        &form_id,
        Some("2000-01-01T00:00:00Z"),
        Some(1),
    )
    .await;
    let public: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(public["data"]["accepting_responses"], json!(false));

    // Explicit nulls clear both limits and reopen the form.
    let version = current_version(&client, &base, &form_id).await;
    let cleared = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "expected_version": version,
            "closes_at": serde_json::Value::Null,
            "max_responses": serde_json::Value::Null,
        }))
        .send()
        .await
        .unwrap();
    assert!(cleared.status().is_success());

    let public: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        public["data"]["accepting_responses"],
        json!(true),
        "clearing both limits must reopen the form",
    );
}

#[tokio::test]
async fn omitting_a_limit_leaves_it_unchanged() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_limits(&client, &base, &form_id, Some("2000-01-01T00:00:00Z"), None).await;

    // A PATCH that mentions neither limit must not disturb the close date.
    let version = current_version(&client, &base, &form_id).await;
    client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "expected_version": version,
            "title_ciphertext": "a new title",
        }))
        .send()
        .await
        .unwrap();

    let public: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        public["data"]["accepting_responses"],
        json!(false),
        "an unrelated PATCH must not clear the close date",
    );
}

#[tokio::test]
async fn get_form_returns_closes_at_as_a_parseable_string() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_limits(&client, &base, &form_id, Some("2099-06-15T12:30:00Z"), None).await;

    let form: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let closes_at = &form["data"]["closes_at"];
    // `time::OffsetDateTime`'s default serialization is a component array,
    // not a string. `is_string()` is the assertion that catches that;
    // merely asserting the field is present would not.
    assert!(
        closes_at.is_string(),
        "closes_at must serialize as a string, got {closes_at:?}",
    );
    let parsed = time::OffsetDateTime::parse(
        closes_at.as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("closes_at must parse as RFC3339");
    assert_eq!(
        parsed,
        time::macros::datetime!(2099-06-15 12:30:00 UTC),
        "closes_at must round-trip to the instant that was set",
    );
}

/// PATCHes the caller's own membership state (notification preference and/or
/// archive flag) for one form. Mirrors `set_limits`'s shape but hits
/// `members/me`, which carries no `expected_version`: it is keyed on the
/// session's own membership, not the form's optimistic-concurrency version.
async fn set_member_preferences(
    client: &Client,
    base: &str,
    form_id: &str,
    archived: Option<bool>,
) -> serde_json::Value {
    let mut body = json!({});
    if let Some(archived) = archived {
        body["archived"] = json!(archived);
    }
    let response = client
        .patch(format!("{base}/api/v1/forms/{form_id}/members/me"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "PATCH members/me failed: {:?}",
        response.status()
    );
    response.json().await.unwrap()
}

async fn list_form_ids(client: &Client, base: &str, archived: bool) -> Vec<String> {
    let url = if archived {
        format!("{base}/api/v1/forms?archived=1")
    } else {
        format!("{base}/api/v1/forms")
    };
    let list: serde_json::Value = client.get(url).send().await.unwrap().json().await.unwrap();
    list["data"]["forms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap().to_string())
        .collect()
}

/// Directly inserts an active `editor` membership for `user_id` on
/// `form_id`, bypassing the invitation flow the way `sharing_test.rs`'s own
/// helpers do; this suite only needs a second member to exist, not the
/// acceptance flow that creates one in production.
async fn insert_active_editor_membership(form_id: Uuid, user_id: Uuid) {
    let db = test_db().await;
    sqlx::query!(
        "INSERT INTO form_members (
            id, form_id, user_id, role, state, key_scheme,
            encrypted_form_data_key, encrypted_form_private_key
         ) VALUES ($1, $2, $3, 'editor', 'active', 'account_sealed_box_v1', $4, $5)",
        Uuid::now_v7(),
        form_id,
        user_id,
        "sealed-data-key",
        "sealed-private-key",
    )
    .execute(&db)
    .await
    .unwrap();
}

#[tokio::test]
async fn archiving_removes_a_form_from_the_default_list_and_shows_it_under_archived() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    assert!(
        list_form_ids(&client, &base, false)
            .await
            .contains(&form_id)
    );
    assert!(!list_form_ids(&client, &base, true).await.contains(&form_id));

    let updated = set_member_preferences(&client, &base, &form_id, Some(true)).await;
    assert!(updated["data"]["archived_at"].is_string());

    assert!(
        !list_form_ids(&client, &base, false)
            .await
            .contains(&form_id)
    );
    assert!(list_form_ids(&client, &base, true).await.contains(&form_id));
}

#[tokio::test]
async fn unarchiving_restores_a_form_to_the_default_list() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_member_preferences(&client, &base, &form_id, Some(true)).await;
    assert!(
        !list_form_ids(&client, &base, false)
            .await
            .contains(&form_id)
    );

    let updated = set_member_preferences(&client, &base, &form_id, Some(false)).await;
    assert_eq!(updated["data"]["archived_at"], serde_json::Value::Null);

    assert!(
        list_form_ids(&client, &base, false)
            .await
            .contains(&form_id)
    );
    assert!(!list_form_ids(&client, &base, true).await.contains(&form_id));
}

#[tokio::test]
async fn archiving_is_per_member_and_does_not_affect_a_collaborator() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());

    let owner_client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&owner_client, &base).await;
    let form_id = create_test_form(&owner_client, &base).await;
    let form_uuid = Uuid::parse_str(&form_id).unwrap();

    let editor_client = Client::builder().cookie_store(true).build().unwrap();
    let editor_email = format!("archive-editor-{}@example.com", Uuid::now_v7());
    let editor_account = common::register_test_account(
        &base,
        &editor_client,
        &editor_email,
        "correct horse battery staple",
    )
    .await;
    insert_active_editor_membership(form_uuid, editor_account.user_id).await;

    assert!(
        list_form_ids(&editor_client, &base, false)
            .await
            .contains(&form_id)
    );

    set_member_preferences(&owner_client, &base, &form_id, Some(true)).await;

    assert!(
        !list_form_ids(&owner_client, &base, false)
            .await
            .contains(&form_id)
    );
    assert!(
        list_form_ids(&editor_client, &base, false)
            .await
            .contains(&form_id),
        "the owner archiving their own view must not touch the editor's dashboard"
    );
    assert!(
        !list_form_ids(&editor_client, &base, true)
            .await
            .contains(&form_id)
    );
}

#[tokio::test]
async fn archiving_does_not_affect_accepting_responses() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    set_member_preferences(&client, &base, &form_id, Some(true)).await;

    let public: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(public["data"]["accepting_responses"], json!(true));

    let submit_response = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "ct-response" }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        submit_response.status(),
        200,
        "an archived form must still accept public submissions"
    );
}

#[tokio::test]
async fn an_owner_deletes_a_response() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    let submitted: serde_json::Value = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response_id = submitted["data"]["id"].as_str().unwrap().to_string();

    let deleted = client
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/responses/{response_id}"
        ))
        .json(&json!({ "attachment_ids": [] }))
        .send()
        .await
        .unwrap();
    assert!(deleted.status().is_success());

    let listed: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/responses"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["data"]["responses"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn a_response_id_from_another_form_is_not_deletable_through_this_form() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_a = create_test_form(&client, &base).await;
    let form_b = create_test_form(&client, &base).await;

    let submitted: serde_json::Value = client
        .post(format!("{base}/api/v1/forms/{form_b}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response_id = submitted["data"]["id"].as_str().unwrap().to_string();

    let deleted = client
        .delete(format!(
            "{base}/api/v1/forms/{form_a}/responses/{response_id}"
        ))
        .json(&json!({ "attachment_ids": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), reqwest::StatusCode::NOT_FOUND);

    let listed: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_b}/responses"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        listed["data"]["responses"].as_array().unwrap().len(),
        1,
        "the response must survive a delete addressed through the wrong form",
    );
}

#[tokio::test]
async fn an_unknown_attachment_id_fails_the_delete_and_keeps_the_response() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    let submitted: serde_json::Value = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response_id = submitted["data"]["id"].as_str().unwrap().to_string();

    let deleted = client
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/responses/{response_id}"
        ))
        .json(&json!({ "attachment_ids": [Uuid::now_v7().to_string()] }))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), reqwest::StatusCode::BAD_REQUEST);

    let listed: serde_json::Value = client
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
        "a rejected attachment id must roll the whole delete back",
    );
}

#[tokio::test]
async fn deleting_a_response_reopens_a_form_that_hit_its_cap() {
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    let version = current_version(&client, &base, &form_id).await;
    client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({ "expected_version": version, "max_responses": 1 }))
        .send()
        .await
        .unwrap();

    let submitted: serde_json::Value = client
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response_id = submitted["data"]["id"].as_str().unwrap().to_string();

    let public: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(public["data"]["accepting_responses"], json!(false));

    client
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/responses/{response_id}"
        ))
        .json(&json!({ "attachment_ids": [] }))
        .send()
        .await
        .unwrap();

    let public: serde_json::Value = client
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        public["data"]["accepting_responses"],
        json!(true),
        "deleting below the cap must reopen the form",
    );
}

/// Fires `limit` requests at a form nobody created, then one more. The limit is
/// checked before the form is looked up, so the first `limit` are 404 and the
/// next is refused. A fresh random form id keeps the counter private to this
/// test.
async fn assert_limited_after(limit: usize, request: impl Fn() -> reqwest::RequestBuilder) {
    for attempt in 0..limit {
        let status = request().send().await.unwrap().status();
        assert_eq!(status, 404, "attempt {attempt} should reach the lookup");
    }
    assert_eq!(request().send().await.unwrap().status(), 429);
}

#[tokio::test]
async fn public_form_reads_are_rate_limited_per_source_per_form() {
    let base = common::base_url();
    let client = Client::new();
    let form_id = Uuid::new_v4();
    assert_limited_after(600, || {
        client.get(format!("{base}/api/v1/forms/{form_id}/public"))
    })
    .await;
}

#[tokio::test]
async fn header_image_reads_are_rate_limited_per_source_per_form() {
    let base = common::base_url();
    let client = Client::new();
    let form_id = Uuid::new_v4();
    assert_limited_after(600, || {
        client.get(format!("{base}/api/v1/forms/{form_id}/header-image"))
    })
    .await;
}

#[tokio::test]
async fn response_edits_are_rate_limited_per_source_per_form() {
    let base = common::base_url();
    let client = Client::new();
    let form_id = Uuid::new_v4();
    assert_limited_after(10, || {
        client
            .patch(format!("{base}/api/v1/forms/{form_id}/responses/edit"))
            .header("x-response-token", "not-a-real-token")
            .json(&json!({ "ciphertext": "x" }))
    })
    .await;
}

#[tokio::test]
async fn responses_are_rate_limited_per_source_per_form() {
    let base = common::base_url();
    let client = Client::new();
    let form_id = Uuid::new_v4();
    assert_limited_after(20, || {
        client
            .post(format!("{base}/api/v1/forms/{form_id}/responses"))
            .json(&json!({ "ciphertext": "c" }))
    })
    .await;
}

#[tokio::test]
async fn reopening_a_closed_form_is_refused_at_the_open_form_limit() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let me: serde_json::Value = client
        .get(format!("{base}/api/v1/auth/me"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let user_id = Uuid::parse_str(me["data"]["user_id"].as_str().unwrap()).unwrap();
    let db = test_db().await;
    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, 1, 1048576)
         ON CONFLICT (user_id) DO UPDATE SET max_forms = EXCLUDED.max_forms",
    )
    .bind(user_id)
    .execute(&db)
    .await
    .unwrap();

    // Close the only open form, which frees the slot for a second one.
    let first = create_test_form(&client, &base).await;
    let version = current_version(&client, &base, &first).await;
    let closed = client
        .patch(format!("{base}/api/v1/forms/{first}"))
        .json(&json!({ "accepting_responses": false, "expected_version": version }))
        .send()
        .await
        .unwrap();
    assert!(closed.status().is_success());
    create_test_form(&client, &base).await;

    // Reopening the first would make two open forms against a limit of one.
    let version = current_version(&client, &base, &first).await;
    let reopened = client
        .patch(format!("{base}/api/v1/forms/{first}"))
        .json(&json!({ "accepting_responses": true, "expected_version": version }))
        .send()
        .await
        .unwrap();
    assert_eq!(reopened.status(), 429);
    assert_eq!(current_version(&client, &base, &first).await, version);

    // An edit that leaves the form closed is not a reopen and still succeeds.
    let renamed = client
        .patch(format!("{base}/api/v1/forms/{first}"))
        .json(&json!({ "title_ciphertext": "renamed", "expected_version": version }))
        .send()
        .await
        .unwrap();
    assert!(renamed.status().is_success());
}

/// Reads every page of a form's responses the way the dashboard does.
async fn all_response_pages(client: &Client, base: &str, form_id: &str) -> Vec<Vec<String>> {
    let mut pages = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let url = match &cursor {
            Some(cursor) => format!("{base}/api/v1/forms/{form_id}/responses?cursor={cursor}"),
            None => format!("{base}/api/v1/forms/{form_id}/responses"),
        };
        let body: serde_json::Value = client.get(url).send().await.unwrap().json().await.unwrap();
        pages.push(
            body["data"]["responses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["id"].as_str().unwrap().to_string())
                .collect(),
        );
        match body["data"]["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => return pages,
        }
    }
}

async fn insert_responses(
    db: &sqlx::PgPool,
    form_id: &str,
    count: usize,
    bytes: usize,
) -> Vec<String> {
    let form_id = Uuid::parse_str(form_id).unwrap();
    let ciphertext = "x".repeat(bytes);
    let mut ids = Vec::new();
    for _ in 0..count {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO responses (id, form_id, ciphertext) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(form_id)
            .bind(&ciphertext)
            .execute(db)
            .await
            .unwrap();
        ids.push(id.to_string());
    }
    ids
}

#[tokio::test]
async fn responses_are_listed_in_pages_that_together_hold_every_one_once() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let db = test_db().await;

    // Past the row cap: two pages, in submission order, nothing repeated.
    let form_id = create_test_form(&client, &base).await;
    let ids = insert_responses(&db, &form_id, 501, 16).await;
    let pages = all_response_pages(&client, &base, &form_id).await;
    assert_eq!(pages.iter().map(Vec::len).collect::<Vec<_>>(), vec![500, 1]);
    assert_eq!(pages.concat(), ids);

    // Past the byte budget: a page takes a row while the bytes before it are
    // under 4 MiB, so it closes after the row that crosses the budget, and a
    // row larger than the whole budget still starts a page of its own.
    let form_id = create_test_form(&client, &base).await;
    let mut ids = insert_responses(&db, &form_id, 3, 2_500_000).await;
    ids.extend(insert_responses(&db, &form_id, 1, 5_000_000).await);
    ids.extend(insert_responses(&db, &form_id, 1, 16).await);
    let pages = all_response_pages(&client, &base, &form_id).await;
    assert_eq!(
        pages.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![2, 2, 1]
    );
    assert_eq!(pages.concat(), ids);

    let bad = client
        .get(format!(
            "{base}/api/v1/forms/{form_id}/responses?cursor=not-a-uuid"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
}

async fn form_json(client: &Client, base: &str, form_id: &str) -> serde_json::Value {
    let response = client
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json().await.unwrap()
}

#[tokio::test]
async fn the_answer_key_saves_with_the_schema_under_one_version() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;
    let version = current_version(&client, &base, &form_id).await;

    let saved = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "schema_ciphertext": "schema-2",
            "answer_key_ciphertext": "key-1",
            "expected_version": version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), 200);

    // A stale write carrying a different key changes nothing, so the key can
    // never be saved against questions it was not written for.
    let stale = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({ "answer_key_ciphertext": "key-2", "expected_version": version }))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 409);

    let form = form_json(&client, &base, &form_id).await;
    assert_eq!(form["data"]["answer_key_ciphertext"], "key-1");
    assert_eq!(form["data"]["schema_ciphertext"], "schema-2");
    assert_eq!(form["data"]["version"], version + 1);

    // Absent leaves it alone.
    let untouched = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({ "title_ciphertext": "title-2", "expected_version": version + 1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(untouched.status(), 200);
    let form = form_json(&client, &base, &form_id).await;
    assert_eq!(form["data"]["answer_key_ciphertext"], "key-1");

    // An explicit null clears it.
    let cleared = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({ "answer_key_ciphertext": null, "expected_version": version + 2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), 200);
    let form = form_json(&client, &base, &form_id).await;
    assert!(form["data"]["answer_key_ciphertext"].is_null());
}

#[tokio::test]
async fn a_form_can_be_created_with_an_answer_key() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let created: serde_json::Value = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "title",
            "schema_ciphertext": "schema",
            "form_public_key": "public-key",
            "wrapped_form_data_key": "data-key",
            "wrapped_form_private_key": "private-key",
            "answer_key_ciphertext": "key-0",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let form_id = created["data"]["id"].as_str().unwrap().to_string();

    let form = form_json(&client, &base, &form_id).await;
    assert_eq!(form["data"]["answer_key_ciphertext"], "key-0");
}

#[tokio::test]
async fn the_public_form_never_carries_the_answer_key() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;
    let version = current_version(&client, &base, &form_id).await;
    let saved = client
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "answer_key_ciphertext": "quiz-secret-ciphertext",
            "expected_version": version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), 200);

    let body = Client::new()
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!body.contains("quiz-secret-ciphertext"));
    assert!(!body.contains("answer_key"));
}

#[tokio::test]
async fn a_form_can_be_created_with_its_settings_already_chosen() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let created: serde_json::Value = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "title",
            "schema_ciphertext": "schema",
            "form_public_key": "public-key",
            "wrapped_form_data_key": "data-key",
            "wrapped_form_private_key": "private-key",
            "allow_response_editing": true,
            "accepting_responses": false,
            "closes_at": "2030-01-02T03:04:05Z",
            "max_responses": 25,
            "notify_on_response": false,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let form_id = created["data"]["id"].as_str().unwrap().to_string();

    let form = form_json(&client, &base, &form_id).await;
    assert_eq!(form["data"]["allow_response_editing"], true);
    assert_eq!(form["data"]["accepting_responses"], false);
    assert_eq!(form["data"]["closes_at"], "2030-01-02T03:04:05Z");
    assert_eq!(form["data"]["max_responses"], 25);
    assert_eq!(form["data"]["notify_on_response"], false);
}

#[tokio::test]
async fn a_form_created_without_settings_keeps_the_defaults() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let form_id = create_test_form(&client, &base).await;

    let form = form_json(&client, &base, &form_id).await;
    assert_eq!(form["data"]["allow_response_editing"], false);
    assert_eq!(form["data"]["accepting_responses"], true);
    assert!(form["data"]["closes_at"].is_null());
    assert!(form["data"]["max_responses"].is_null());
    assert_eq!(form["data"]["notify_on_response"], true);
}

#[tokio::test]
async fn a_form_cannot_be_created_with_a_response_limit_below_one() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    register_and_login(&client, &base).await;
    let response = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "title",
            "schema_ciphertext": "schema",
            "form_public_key": "public-key",
            "wrapped_form_data_key": "data-key",
            "wrapped_form_private_key": "private-key",
            "max_responses": 0,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}
