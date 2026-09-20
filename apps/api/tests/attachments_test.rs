mod common;

use reqwest::Client;
use s3::{Region, bucket::Bucket, creds::Credentials};
use serde_json::json;
use std::sync::OnceLock;
use tokio::sync::{Mutex, MutexGuard, OnceCell};

static PRIMARY_ACCOUNT: OnceCell<(String, String)> = OnceCell::const_new();
static SECONDARY_ACCOUNT: OnceCell<(String, String)> = OnceCell::const_new();

async fn suite_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

async fn register_new_account(base: &str) -> (String, String) {
    let email = format!("test-{}@example.com", uuid::Uuid::now_v7());
    let password = "correct horse battery staple".to_string();
    let client = Client::new();
    let account = common::register_test_account(base, &client, &email, &password).await;
    (email, account.verifier)
}

/// The tuple is (email, verifier): the password itself never leaves the browser.
async fn login_as(client: &Client, base: &str, account: &(String, String)) {
    client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&json!({ "email": account.0, "verifier": account.1 }))
        .send()
        .await
        .unwrap();
}

async fn login_primary(client: &Client, base: &str) {
    let account = PRIMARY_ACCOUNT
        .get_or_init(|| register_new_account(base))
        .await;
    login_as(client, base, account).await;
}

async fn login_secondary(client: &Client, base: &str) {
    let account = SECONDARY_ACCOUNT
        .get_or_init(|| register_new_account(base))
        .await;
    login_as(client, base, account).await;
}

async fn create_form(client: &Client, base: &str) -> String {
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
    create_res.json::<serde_json::Value>().await.unwrap()["data"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn register_and_login_fresh(base: &str) -> (Client, String) {
    let client = Client::builder().cookie_store(true).build().unwrap();
    let account = register_new_account(base).await;
    login_as(&client, base, &account).await;
    (client, account.0)
}

async fn user_id_for_email(db: &sqlx::PgPool, email: &str) -> uuid::Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn attachment_usage_for_user(db: &sqlx::PgPool, user_id: uuid::Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT attachment_bytes_used
         FROM account_usage
         WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn purge_form(db: &sqlx::PgPool, form_id: uuid::Uuid) {
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
async fn anonymous_can_upload_attachment() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&client, &base).await;
    let form_id = create_form(&client, &base).await;

    let anon_client = reqwest::Client::new();
    let upload_res = anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![1u8, 2, 3, 4, 5])
        .send()
        .await
        .unwrap();
    assert_eq!(upload_res.status(), 200);
    let body: serde_json::Value = upload_res.json().await.unwrap();
    assert!(body["data"]["attachment_id"].as_str().is_some());
}

#[tokio::test]
async fn one_source_cannot_upload_more_than_five_attachments_per_form_per_minute() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    let anonymous = reqwest::Client::new();

    for _ in 0..5 {
        let response = anonymous
            .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
            .header("Content-Type", "application/octet-stream")
            .body(vec![1u8])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }

    let response = anonymous
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![1u8])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "rate_limited");
}

#[tokio::test]
async fn upload_over_size_limit_is_rejected() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&client, &base).await;
    let form_id = create_form(&client, &base).await;

    // 10.5 MB: over the 10MB business limit but under the 11MB DefaultBodyLimit backstop,
    // so this reaches the handler and gets our own envelope-compliant 413.
    let oversized = vec![0u8; 10 * 1024 * 1024 + 512 * 1024];
    let anon_client = reqwest::Client::new();
    let upload_res = anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(oversized)
        .send()
        .await
        .unwrap();
    assert_eq!(upload_res.status(), 413);
    let body: serde_json::Value = upload_res.json().await.unwrap();
    assert_eq!(body["error"]["code"].as_str().unwrap(), "payload_too_large");
}

#[tokio::test]
async fn owner_can_download_attachment_byte_identical() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&client, &base).await;
    let form_id = create_form(&client, &base).await;

    let file_bytes = vec![42u8; 1024];
    let anon_client = reqwest::Client::new();
    let upload_res = anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(file_bytes.clone())
        .send()
        .await
        .unwrap();
    let upload_body: serde_json::Value = upload_res.json().await.unwrap();
    let attachment_id = upload_body["data"]["attachment_id"].as_str().unwrap();

    let download_res = client
        .get(format!(
            "{base}/api/v1/forms/{form_id}/attachments/{attachment_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(download_res.status(), 200);
    let downloaded_bytes = download_res.bytes().await.unwrap();
    assert_eq!(downloaded_bytes.as_ref(), file_bytes.as_slice());
}

#[tokio::test]
async fn the_header_image_can_only_be_an_editors_own_upload() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;

    async fn upload(client: &Client, base: &str, form_id: &str, bytes: Vec<u8>) -> String {
        let res = client
            .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
            .header("Content-Type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        res.json::<serde_json::Value>().await.unwrap()["data"]["attachment_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    // A respondent's sealed attachment: anonymous, exactly as a real one is.
    let respondent_upload = upload(&Client::new(), &base, &form_id, vec![7u8; 256]).await;
    let version = current_version(&owner, &base, &form_id).await;
    let point_at_response = owner
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "header_attachment_id": respondent_upload,
            "expected_version": version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(point_at_response.status(), 200);

    let form = owner
        .get(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(
        form["data"]["header_image"], false,
        "a respondent's upload must never become the public header image"
    );
    let public_fetch = Client::new()
        .get(format!("{base}/api/v1/forms/{form_id}/header-image"))
        .send()
        .await
        .unwrap();
    assert_eq!(public_fetch.status(), 404);

    // The editor's own upload, carrying their session, is accepted.
    let header_bytes = vec![9u8; 256];
    let editor_upload = upload(&owner, &base, &form_id, header_bytes.clone()).await;
    let version = current_version(&owner, &base, &form_id).await;
    let point_at_header = owner
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "header_attachment_id": editor_upload,
            "expected_version": version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(point_at_header.status(), 200);
    let public_fetch = Client::new()
        .get(format!("{base}/api/v1/forms/{form_id}/header-image"))
        .send()
        .await
        .unwrap();
    assert_eq!(public_fetch.status(), 200);
    assert_eq!(
        public_fetch.bytes().await.unwrap().as_ref(),
        header_bytes.as_slice()
    );
}

#[tokio::test]
async fn non_owner_cannot_download_attachment() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner_client = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner_client, &base).await;
    let form_id = create_form(&owner_client, &base).await;

    let anon_client = reqwest::Client::new();
    let upload_res = anon_client
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![1u8, 2, 3])
        .send()
        .await
        .unwrap();
    let upload_body: serde_json::Value = upload_res.json().await.unwrap();
    let attachment_id = upload_body["data"]["attachment_id"].as_str().unwrap();

    let other_client = Client::builder().cookie_store(true).build().unwrap();
    login_secondary(&other_client, &base).await;

    let download_res = other_client
        .get(format!(
            "{base}/api/v1/forms/{form_id}/attachments/{attachment_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(download_res.status(), 404);
}

#[tokio::test]
async fn download_of_nonexistent_attachment_returns_not_found() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let client = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&client, &base).await;
    let form_id = create_form(&client, &base).await;

    let random_attachment_id = uuid::Uuid::now_v7();
    let download_res = client
        .get(format!(
            "{base}/api/v1/forms/{form_id}/attachments/{random_attachment_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(download_res.status(), 404);
}

#[tokio::test]
async fn closed_form_rejects_attachment_upload() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    let expected_version = current_version(&owner, &base, &form_id).await;

    let close = owner
        .patch(format!("{base}/api/v1/forms/{form_id}"))
        .json(&json!({
            "accepting_responses": false,
            "expected_version": expected_version,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(close.status(), 200);

    let upload = Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![1_u8, 2, 3])
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 409);
    let body: serde_json::Value = upload.json().await.unwrap();
    assert_eq!(body["error"]["code"], "form_closed");
    assert_eq!(body["error"]["message"], "Form is closed");
}

async fn test_db() -> sqlx::PgPool {
    dotenvy::dotenv().ok();
    sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap()
}

fn test_bucket() -> Box<Bucket> {
    dotenvy::dotenv().ok();
    let region = Region::Custom {
        region: "garage".to_string(),
        endpoint: std::env::var("S3_ENDPOINT").unwrap(),
    };
    let credentials = Credentials::new(
        Some(&std::env::var("S3_ACCESS_KEY").unwrap()),
        Some(&std::env::var("S3_SECRET_KEY").unwrap()),
        None,
        None,
        None,
    )
    .unwrap();
    Bucket::new(&std::env::var("S3_BUCKET").unwrap(), region, credentials)
        .unwrap()
        .with_path_style()
}

#[tokio::test]
async fn deleting_form_removes_encrypted_attachment_objects_and_metadata() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    let bytes = vec![91_u8, 92, 93, 94];
    let upload = Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 200);
    let attachment_id = upload.json::<serde_json::Value>().await.unwrap()["data"]["attachment_id"]
        .as_str()
        .unwrap()
        .to_string();
    let object_key = format!("attachments/{form_id}/{attachment_id}");
    assert!(test_bucket().object_exists(&object_key).await.unwrap());

    let delete = owner
        .delete(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(delete.status(), 200);
    assert!(!test_bucket().object_exists(&object_key).await.unwrap());
    let db = test_db().await;
    let form_uuid = form_id.parse::<uuid::Uuid>().unwrap();
    assert_eq!(
        sqlx::query_scalar!("SELECT count(*) FROM forms WHERE id = $1", form_uuid)
            .fetch_one(&db)
            .await
            .unwrap()
            .unwrap_or(0),
        0
    );
    assert_eq!(
        sqlx::query_scalar!(
            "SELECT count(*) FROM attachments WHERE id = $1",
            attachment_id.parse::<uuid::Uuid>().unwrap()
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0),
        0
    );
}

#[tokio::test]
async fn deleting_form_treats_a_missing_attachment_object_as_already_deleted() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    let form_uuid = form_id.parse::<uuid::Uuid>().unwrap();
    let attachment_id = uuid::Uuid::now_v7();
    let db = test_db().await;
    sqlx::query!(
        "INSERT INTO attachments (id, form_id, byte_size) VALUES ($1, $2, 7)",
        attachment_id,
        form_uuid,
    )
    .execute(&db)
    .await
    .unwrap();
    assert!(
        !test_bucket()
            .object_exists(format!("attachments/{form_id}/{attachment_id}"))
            .await
            .unwrap()
    );

    let delete = owner
        .delete(format!("{base}/api/v1/forms/{form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(delete.status(), 200);
    assert_eq!(
        sqlx::query_scalar!("SELECT count(*) FROM forms WHERE id = $1", form_uuid)
            .fetch_one(&db)
            .await
            .unwrap()
            .unwrap_or(0),
        0
    );
}

async fn wait_for_attachment_state(
    db: &sqlx::PgPool,
    form_id: uuid::Uuid,
    state: &str,
) -> uuid::Uuid {
    for _ in 0..80 {
        if let Some(attachment_id) = sqlx::query_scalar!(
            "SELECT id FROM attachments WHERE form_id = $1 AND upload_state = $2",
            form_id,
            state,
        )
        .fetch_optional(db)
        .await
        .unwrap()
        {
            return attachment_id;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("attachment did not enter {state}");
}

async fn wait_for_blocked_requests(db: &sqlx::PgPool, blocker_backend_pid: i32, expected: i64) {
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
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("expected {expected} requests to contend behind the paused upload");
}

#[tokio::test]
async fn paused_upload_cannot_outlive_successful_form_deletion() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    let form_uuid = form_id.parse::<uuid::Uuid>().unwrap();
    let db = test_db().await;

    let mut pause_connection = db.acquire().await.unwrap();
    let pause_backend_pid = sqlx::query_scalar!(r#"SELECT pg_backend_pid() AS "pid!""#)
        .fetch_one(&mut *pause_connection)
        .await
        .unwrap();
    sqlx::query!(
        "SELECT pg_advisory_lock(hashtextextended($1::text, 7009))",
        form_id,
    )
    .fetch_one(&mut *pause_connection)
    .await
    .unwrap();

    let upload_url = format!("{base}/api/v1/forms/{form_id}/attachments");
    let upload = tokio::spawn(async move {
        Client::new()
            .post(upload_url)
            .header("Content-Type", "application/octet-stream")
            .header("x-krypta-test-pause-upload", "after-reservation")
            .body(vec![101_u8, 102, 103, 104])
            .send()
            .await
            .unwrap()
    });
    let attachment_id = wait_for_attachment_state(&db, form_uuid, "uploading").await;
    let object_key = format!("attachments/{form_id}/{attachment_id}");
    wait_for_blocked_requests(&db, pause_backend_pid, 1).await;

    let delete_url = format!("{base}/api/v1/forms/{form_id}");
    let deleting_owner = owner.clone();
    let deletion =
        tokio::spawn(async move { deleting_owner.delete(delete_url).send().await.unwrap() });
    wait_for_blocked_requests(&db, pause_backend_pid, 2).await;

    // Test configuration uses a two-second stale threshold. Holding the hook
    // beyond it proves neither DELETE nor the reconciler can remove the locked
    // lifecycle row while the bounded PUT is permitted to complete.
    tokio::time::sleep(std::time::Duration::from_millis(2_300)).await;
    assert!(
        !upload.is_finished(),
        "paused upload unexpectedly completed"
    );
    assert!(
        !deletion.is_finished(),
        "form deletion bypassed the upload locks"
    );
    assert!(
        !sqlx::query_scalar!(
            r#"SELECT deletion_started_at IS NOT NULL AS "started!"
               FROM forms WHERE id = $1"#,
            form_uuid,
        )
        .fetch_one(&db)
        .await
        .unwrap()
    );
    assert_eq!(
        sqlx::query_scalar!(
            "SELECT count(*) FROM attachments
             WHERE id = $1 AND upload_state = 'uploading'",
            attachment_id,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0),
        1
    );

    sqlx::query!(
        "SELECT pg_advisory_unlock(hashtextextended($1::text, 7009))",
        form_id,
    )
    .fetch_one(&mut *pause_connection)
    .await
    .unwrap();
    let upload = upload.await.unwrap();
    assert_eq!(upload.status(), 200);
    let deletion = deletion.await.unwrap();
    assert_eq!(deletion.status(), 200);
    assert_eq!(
        sqlx::query_scalar!("SELECT count(*) FROM forms WHERE id = $1", form_uuid)
            .fetch_one(&db)
            .await
            .unwrap()
            .unwrap_or(0),
        0
    );
    assert_eq!(
        sqlx::query_scalar!(
            "SELECT count(*) FROM attachments WHERE id = $1",
            attachment_id
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0),
        0
    );
    assert!(!test_bucket().object_exists(object_key).await.unwrap());
}

#[tokio::test]
async fn stale_uploading_reservation_is_cleaned_without_losing_object_reference() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    let form_uuid = form_id.parse::<uuid::Uuid>().unwrap();
    let attachment_id = uuid::Uuid::now_v7();
    let object_key = format!("attachments/{form_id}/{attachment_id}");
    let db = test_db().await;
    test_bucket()
        .put_object(&object_key, &[111_u8, 112, 113])
        .await
        .unwrap();
    let mut transaction = db.begin().await.unwrap();
    sqlx::query!(
        "UPDATE forms
         SET attachment_count = attachment_count + 1, attachment_bytes = attachment_bytes + 3
         WHERE id = $1",
        form_uuid,
    )
    .execute(&mut *transaction)
    .await
    .unwrap();
    sqlx::query!(
        "INSERT INTO attachments (
            id, form_id, byte_size, upload_state, upload_started_at,
            upload_completed_at, lifecycle_updated_at
         ) VALUES (
            $1, $2, 3, 'uploading', now() - interval '5 seconds',
            NULL, now() - interval '5 seconds'
         )",
        attachment_id,
        form_uuid,
    )
    .execute(&mut *transaction)
    .await
    .unwrap();
    transaction.commit().await.unwrap();

    for _ in 0..160 {
        let count = sqlx::query_scalar!(
            "SELECT count(*) FROM attachments WHERE id = $1",
            attachment_id,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0);
        if count == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        sqlx::query_scalar!(
            "SELECT count(*) FROM attachments WHERE id = $1",
            attachment_id
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0),
        0
    );
    let form = sqlx::query!(
        "SELECT attachment_count, attachment_bytes FROM forms WHERE id = $1",
        form_uuid,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(form.attachment_count, 0);
    assert_eq!(form.attachment_bytes, 0);
    assert!(!test_bucket().object_exists(object_key).await.unwrap());
}

#[tokio::test]
async fn deleting_a_response_reaches_the_reconciler_and_removes_the_attachment() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let owner = Client::builder().cookie_store(true).build().unwrap();
    login_primary(&owner, &base).await;
    let form_id = create_form(&owner, &base).await;
    let form_uuid = form_id.parse::<uuid::Uuid>().unwrap();

    let bytes = vec![201_u8, 202, 203, 204, 205];
    let upload = Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 200);
    let attachment_id = upload.json::<serde_json::Value>().await.unwrap()["data"]["attachment_id"]
        .as_str()
        .unwrap()
        .to_string();
    let attachment_uuid = attachment_id.parse::<uuid::Uuid>().unwrap();
    let object_key = format!("attachments/{form_id}/{attachment_id}");
    assert!(test_bucket().object_exists(&object_key).await.unwrap());

    let db = test_db().await;
    let before = sqlx::query!(
        "SELECT attachment_count, attachment_bytes FROM forms WHERE id = $1",
        form_uuid,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(before.attachment_count, 1);
    assert_eq!(before.attachment_bytes, 5);

    let submitted: serde_json::Value = Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let response_id = submitted["data"]["id"].as_str().unwrap().to_string();

    let deleted = owner
        .delete(format!(
            "{base}/api/v1/forms/{form_id}/responses/{response_id}"
        ))
        .json(&json!({ "attachment_ids": [attachment_id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);

    // The response delete only marks the attachment `cleanup_pending`; the
    // reconciler does the rest, so poll until it has run.
    for _ in 0..160 {
        let count = sqlx::query_scalar!(
            "SELECT count(*) FROM attachments WHERE id = $1",
            attachment_uuid,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0);
        if count == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        sqlx::query_scalar!(
            "SELECT count(*) FROM attachments WHERE id = $1",
            attachment_uuid,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0),
        0,
        "the attachment row should be gone once the reconciler has run"
    );
    let after = sqlx::query!(
        "SELECT attachment_count, attachment_bytes FROM forms WHERE id = $1",
        form_uuid,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(after.attachment_count, 0);
    assert_eq!(after.attachment_bytes, 0);
    assert!(!test_bucket().object_exists(object_key).await.unwrap());
}

#[tokio::test]
async fn quota_and_suspension_attachment_usage_is_reserved_and_released() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let db = test_db().await;

    let (quota_owner, quota_owner_email) = register_and_login_fresh(&base).await;
    let quota_owner_id = user_id_for_email(&db, &quota_owner_email).await;
    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, 100, 4)
         ON CONFLICT (user_id) DO UPDATE
         SET max_forms = EXCLUDED.max_forms,
             max_attachment_bytes = EXCLUDED.max_attachment_bytes",
    )
    .bind(quota_owner_id)
    .execute(&db)
    .await
    .unwrap();

    let quota_form_id = create_form(&quota_owner, &base).await;
    let first_upload = Client::new()
        .post(format!("{base}/api/v1/forms/{quota_form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![1_u8, 2, 3])
        .send()
        .await
        .unwrap();
    assert_eq!(first_upload.status(), 200);
    assert_eq!(attachment_usage_for_user(&db, quota_owner_id).await, 3);

    let quota_rejected = Client::new()
        .post(format!("{base}/api/v1/forms/{quota_form_id}/attachments"))
        .header("Content-Type", "application/octet-stream")
        .body(vec![4_u8, 5])
        .send()
        .await
        .unwrap();
    assert_eq!(quota_rejected.status(), 429);
    let quota_rejected_body: serde_json::Value = quota_rejected.json().await.unwrap();
    assert_eq!(quota_rejected_body["error"]["code"], "rate_limited");
    assert_eq!(attachment_usage_for_user(&db, quota_owner_id).await, 3);

    let deleted = quota_owner
        .delete(format!("{base}/api/v1/forms/{quota_form_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);
    assert_eq!(attachment_usage_for_user(&db, quota_owner_id).await, 0);

    let (suspended_owner, suspended_owner_email) = register_and_login_fresh(&base).await;
    let suspended_owner_id = user_id_for_email(&db, &suspended_owner_email).await;
    let suspended_form_id = create_form(&suspended_owner, &base).await;
    let suspended_form_uuid = suspended_form_id.parse::<uuid::Uuid>().unwrap();
    sqlx::query("UPDATE users SET suspended_at = now() WHERE id = $1")
        .bind(suspended_owner_id)
        .execute(&db)
        .await
        .unwrap();

    let blocked_upload = Client::new()
        .post(format!(
            "{base}/api/v1/forms/{suspended_form_id}/attachments"
        ))
        .header("Content-Type", "application/octet-stream")
        .body(vec![9_u8])
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_upload.status(), 404);
    let blocked_upload_body: serde_json::Value = blocked_upload.json().await.unwrap();
    assert_eq!(blocked_upload_body["error"]["code"], "not_found");

    purge_form(&db, suspended_form_uuid).await;
}

#[tokio::test]
async fn a_submitted_response_claims_the_uploads_it_references() {
    let _guard = suite_lock().await;
    let base =
        std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let db = test_db().await;
    let (owner, _) = register_and_login_fresh(&base).await;
    let form_id = create_form(&owner, &base).await;

    let anonymous = Client::new();
    let mut ids = Vec::new();
    for _ in 0..2 {
        let uploaded: serde_json::Value = anonymous
            .post(format!("{base}/api/v1/forms/{form_id}/attachments"))
            .header("Content-Type", "application/octet-stream")
            .body(vec![1_u8, 2, 3])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        ids.push(
            uuid::Uuid::parse_str(uploaded["data"]["attachment_id"].as_str().unwrap()).unwrap(),
        );
    }

    // Only the first is named by the response, so only the first is claimed;
    // the second is exactly the abandoned upload the reaper exists to find.
    let submitted = anonymous
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "sealed", "attachment_ids": [ids[0]] }))
        .send()
        .await
        .unwrap();
    assert_eq!(submitted.status(), 200);

    let claimed = |id: uuid::Uuid| {
        let db = db.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT claimed_at IS NOT NULL FROM attachments WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert!(claimed(ids[0]).await);
    assert!(!claimed(ids[1]).await);

    purge_form(&db, uuid::Uuid::parse_str(&form_id).unwrap()).await;
}
