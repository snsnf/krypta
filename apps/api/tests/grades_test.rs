mod common;

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

async fn test_db() -> sqlx::PgPool {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL").unwrap();
    sqlx::PgPool::connect(&database_url).await.unwrap()
}

/// Registers a fresh account on `client` and returns its user id.
async fn signed_in_user(client: &Client, base: &str) -> Uuid {
    let email = format!("test-{}@example.com", Uuid::now_v7());
    common::register_test_account(base, client, &email, common::TEST_PASSWORD).await;
    sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_one(&test_db().await)
        .await
        .unwrap()
}

fn signed_out_client() -> Client {
    Client::builder().cookie_store(true).build().unwrap()
}

async fn create_form(client: &Client, base: &str) -> String {
    let created: Value = client
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

/// Adds `user_id` to the form in `role`, bypassing invitations: this suite
/// needs the membership to exist, not the flow that creates it.
async fn add_member(form_id: &str, user_id: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO form_members (
            id, form_id, user_id, role, state, key_scheme,
            encrypted_form_data_key, encrypted_form_private_key
         ) VALUES ($1, $2, $3, $4, 'active', 'account_sealed_box_v1',
                   'sealed-data-key', 'sealed-private-key')",
    )
    .bind(Uuid::now_v7())
    .bind(Uuid::parse_str(form_id).unwrap())
    .bind(user_id)
    .bind(role)
    .execute(&test_db().await)
    .await
    .unwrap();
}

async fn get_grades(client: &Client, base: &str, form_id: &str) -> (StatusCode, Value) {
    let response = client
        .get(format!("{base}/api/v1/forms/{form_id}/grades"))
        .send()
        .await
        .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn put_grades(
    client: &Client,
    base: &str,
    form_id: &str,
    ciphertext: &str,
    expected_version: i64,
) -> (StatusCode, Value) {
    let response = client
        .put(format!("{base}/api/v1/forms/{form_id}/grades"))
        .json(&json!({ "ciphertext": ciphertext, "expected_version": expected_version }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn an_owner_writes_and_reads_grades_under_a_version() {
    let base = common::base_url();
    let owner = signed_out_client();
    signed_in_user(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;

    let (status, body) = get_grades(&owner, &base, &form_id).await;
    assert_eq!(status, 200);
    assert!(body["data"]["ciphertext"].is_null());
    assert_eq!(body["data"]["version"], 0);

    let (status, body) = put_grades(&owner, &base, &form_id, "grades-1", 0).await;
    assert_eq!(status, 200);
    assert_eq!(body["data"]["version"], 1);

    let (_, body) = get_grades(&owner, &base, &form_id).await;
    assert_eq!(body["data"]["ciphertext"], "grades-1");
    assert_eq!(body["data"]["version"], 1);

    let (status, body) = put_grades(&owner, &base, &form_id, "grades-2", 1).await;
    assert_eq!(status, 200);
    assert_eq!(body["data"]["version"], 2);
}

#[tokio::test]
async fn a_stale_or_racing_write_is_a_conflict_and_changes_nothing() {
    let base = common::base_url();
    let owner = signed_out_client();
    signed_in_user(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;

    assert_eq!(put_grades(&owner, &base, &form_id, "first", 0).await.0, 200);
    // A second "first write" is what two graders starting at once look like.
    assert_eq!(
        put_grades(&owner, &base, &form_id, "racing", 0).await.0,
        409
    );
    assert_eq!(put_grades(&owner, &base, &form_id, "stale", 7).await.0, 409);

    let (_, body) = get_grades(&owner, &base, &form_id).await;
    assert_eq!(body["data"]["ciphertext"], "first");
    assert_eq!(body["data"]["version"], 1);
}

#[tokio::test]
async fn an_editor_grades_and_a_viewer_only_reads() {
    let base = common::base_url();
    let owner = signed_out_client();
    signed_in_user(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;

    let editor = signed_out_client();
    let editor_id = signed_in_user(&editor, &base).await;
    add_member(&form_id, editor_id, "editor").await;
    let viewer = signed_out_client();
    let viewer_id = signed_in_user(&viewer, &base).await;
    add_member(&form_id, viewer_id, "viewer").await;

    assert_eq!(
        put_grades(&editor, &base, &form_id, "by-editor", 0).await.0,
        200
    );

    let (status, body) = get_grades(&viewer, &base, &form_id).await;
    assert_eq!(status, 200);
    assert_eq!(body["data"]["ciphertext"], "by-editor");

    assert_eq!(
        put_grades(&viewer, &base, &form_id, "by-viewer", 1).await.0,
        404
    );
    let (_, body) = get_grades(&owner, &base, &form_id).await;
    assert_eq!(body["data"]["ciphertext"], "by-editor");
}

#[tokio::test]
async fn a_stranger_gets_not_found_either_way() {
    let base = common::base_url();
    let owner = signed_out_client();
    signed_in_user(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;

    let stranger = signed_out_client();
    signed_in_user(&stranger, &base).await;
    assert_eq!(get_grades(&stranger, &base, &form_id).await.0, 404);
    assert_eq!(put_grades(&stranger, &base, &form_id, "x", 0).await.0, 404);

    let unknown = Uuid::new_v4().to_string();
    assert_eq!(get_grades(&owner, &base, &unknown).await.0, 404);
}

#[tokio::test]
async fn an_empty_ciphertext_is_refused() {
    let base = common::base_url();
    let owner = signed_out_client();
    signed_in_user(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    assert_eq!(put_grades(&owner, &base, &form_id, "", 0).await.0, 400);
}

#[tokio::test]
async fn grades_are_deleted_with_their_form() {
    let base = common::base_url();
    let owner = signed_out_client();
    signed_in_user(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    assert_eq!(
        put_grades(&owner, &base, &form_id, "grades", 0).await.0,
        200
    );

    let db = test_db().await;
    let id = Uuid::parse_str(&form_id).unwrap();
    sqlx::query("DELETE FROM forms WHERE id = $1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM form_grades WHERE form_id = $1")
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
