use sqlx::Acquire;
use sqlx::migrate::Migrator;
use sqlx::{Connection, Executor};
use uuid::Uuid;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

async fn migrated_connection() -> (sqlx::PgConnection, String) {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL").unwrap();
    let mut connection = sqlx::PgConnection::connect(&database_url).await.unwrap();
    let schema_name = format!("task1_migration_{}", Uuid::now_v7().simple());
    connection
        .execute(format!("CREATE SCHEMA {schema_name}").as_str())
        .await
        .unwrap();
    connection
        .execute(format!("SET search_path TO {schema_name}, public").as_str())
        .await
        .unwrap();
    MIGRATOR.run_direct(&mut connection).await.unwrap();
    MIGRATOR.run_direct(&mut connection).await.unwrap();
    (connection, schema_name)
}

async fn legacy_0011_connection() -> (sqlx::PgConnection, String) {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL").unwrap();
    let mut connection = sqlx::PgConnection::connect(&database_url).await.unwrap();
    let schema_name = format!("task1_legacy_{}", Uuid::now_v7().simple());
    connection
        .execute(format!("CREATE SCHEMA {schema_name}").as_str())
        .await
        .unwrap();
    connection
        .execute(format!("SET search_path TO {schema_name}, public").as_str())
        .await
        .unwrap();
    apply_migrations_through_0011(&mut connection).await;
    (connection, schema_name)
}

async fn drop_schema(connection: &mut sqlx::PgConnection, schema_name: &str) {
    connection.execute("RESET search_path").await.unwrap();
    connection
        .execute(format!("DROP SCHEMA {schema_name} CASCADE").as_str())
        .await
        .unwrap();
}

async fn apply_migrations_through_0011(connection: &mut sqlx::PgConnection) {
    let migrations = [
        include_str!("../migrations/0001_create_users.sql"),
        include_str!("../migrations/0002_create_forms.sql"),
        include_str!("../migrations/0003_create_responses.sql"),
        include_str!("../migrations/0004_create_attachments.sql"),
        include_str!("../migrations/0005_add_response_editing.sql"),
        include_str!("../migrations/0006_add_totp.sql"),
        include_str!("../migrations/0007_add_email_verified_at.sql"),
        include_str!("../migrations/0008_add_form_sharing.sql"),
        include_str!("../migrations/0009_add_attachment_upload_lifecycle.sql"),
        include_str!("../migrations/0010_retire_legacy_form_ownership.sql"),
        include_str!("../migrations/0011_add_instance_administration.sql"),
    ];

    for migration in migrations {
        sqlx::raw_sql(migration)
            .execute(&mut *connection)
            .await
            .unwrap();
    }
}

async fn apply_corrective_migration(connection: &mut sqlx::PgConnection) {
    sqlx::raw_sql(include_str!(
        "../migrations/0012_correct_instance_administration_bootstrap.sql"
    ))
    .execute(&mut *connection)
    .await
    .unwrap();
}

async fn apply_audit_retention_migration(connection: &mut sqlx::PgConnection) {
    sqlx::raw_sql(include_str!(
        "../migrations/0013_harden_instance_account_lifecycle.sql"
    ))
    .execute(&mut *connection)
    .await
    .unwrap();
}

fn assert_database_error_code(error: sqlx::Error, expected: &str) {
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some(expected)
    );
}

#[tokio::test]
async fn instance_administration_schema_is_present() {
    let (mut connection, schema_name) = migrated_connection().await;

    let instance_admin: (String, bool, Option<String>) = sqlx::query_as(
        "SELECT
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
           attribute.attnotnull,
           pg_get_expr(defaults.adbin, defaults.adrelid)
         FROM pg_attribute attribute
         LEFT JOIN pg_attrdef defaults
           ON defaults.adrelid = attribute.attrelid
          AND defaults.adnum = attribute.attnum
         WHERE attribute.attrelid = 'users'::regclass
           AND attribute.attname = 'instance_admin'
           AND NOT attribute.attisdropped",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(instance_admin.0, "boolean");
    assert!(instance_admin.1);
    assert_eq!(instance_admin.2.as_deref(), Some("false"));

    let suspended_at: (String, bool, Option<String>) = sqlx::query_as(
        "SELECT
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
           attribute.attnotnull,
           pg_get_expr(defaults.adbin, defaults.adrelid)
         FROM pg_attribute attribute
         LEFT JOIN pg_attrdef defaults
           ON defaults.adrelid = attribute.attrelid
          AND defaults.adnum = attribute.attnum
         WHERE attribute.attrelid = 'users'::regclass
           AND attribute.attname = 'suspended_at'
           AND NOT attribute.attisdropped",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(suspended_at.0, "timestamp with time zone");
    assert!(!suspended_at.1);
    assert_eq!(suspended_at.2, None);

    let settings_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM instance_settings")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(settings_rows, 0);

    let bootstrap_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM instance_bootstrap")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(bootstrap_rows, 1);

    drop_schema(&mut connection, &schema_name).await;
}

#[tokio::test]
async fn instance_administration_legacy_0011_upgrade_path_is_corrected() {
    let (mut connection, schema_name) = legacy_0011_connection().await;

    let pre_upgrade_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM instance_settings")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(pre_upgrade_rows, 1);

    apply_corrective_migration(&mut connection).await;

    let post_upgrade_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM instance_settings")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(post_upgrade_rows, 0);

    let actor_id = Uuid::now_v7();
    let target_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, master_key_salt)
         VALUES ($1, $2, 'migration-test-hash', 'migration-test-salt'),
                ($3, $4, 'migration-test-hash', 'migration-test-salt')",
    )
    .bind(actor_id)
    .bind(format!("legacy-upgrade-actor-{actor_id}@example.com"))
    .bind(target_id)
    .bind(format!("legacy-upgrade-target-{target_id}@example.com"))
    .execute(&mut connection)
    .await
    .unwrap();

    let mut audit_tx = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(target_id))
    .bind("settings_updated")
    .bind("succeeded")
    .execute(&mut *audit_tx)
    .await
    .unwrap();

    let update_error =
        sqlx::query("UPDATE admin_audit_events SET result = 'failed' WHERE actor_user_id = $1")
            .bind(actor_id)
            .execute(&mut *audit_tx)
            .await
            .unwrap_err();
    assert_database_error_code(update_error, "23514");
    audit_tx.rollback().await.unwrap();

    drop_schema(&mut connection, &schema_name).await;
}

#[tokio::test]
async fn instance_administration_constraints_reject_invalid_rows() {
    let (mut connection, schema_name) = migrated_connection().await;

    let user_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash)
         VALUES ($1, $2, 'migration-test-hash')",
    )
    .bind(user_id)
    .bind(format!("instance-admin-migration-{user_id}@example.com"))
    .execute(&mut connection)
    .await
    .unwrap();

    let mut duplicate_settings = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO instance_settings (
           id, registration_enabled, register_rate_limit_per_hour,
           login_rate_limit_per_minute, default_max_forms,
           default_max_attachment_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(true)
    .bind(true)
    .bind(5_i32)
    .bind(5_i32)
    .bind(100_i32)
    .bind(1_073_741_824_i64)
    .execute(&mut *duplicate_settings)
    .await
    .unwrap();
    let duplicate_settings_error = sqlx::query(
        "INSERT INTO instance_settings (
           id, registration_enabled, register_rate_limit_per_hour,
           login_rate_limit_per_minute, default_max_forms,
           default_max_attachment_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(true)
    .bind(true)
    .bind(5_i32)
    .bind(5_i32)
    .bind(100_i32)
    .bind(1_073_741_824_i64)
    .execute(&mut *duplicate_settings)
    .await
    .unwrap_err();
    assert_database_error_code(duplicate_settings_error, "23505");
    duplicate_settings.rollback().await.unwrap();

    let mut duplicate_bootstrap = sqlx::Connection::begin(&mut connection).await.unwrap();
    let duplicate_bootstrap_error = sqlx::query("INSERT INTO instance_bootstrap (id) VALUES ($1)")
        .bind(true)
        .execute(&mut *duplicate_bootstrap)
        .await
        .unwrap_err();
    assert_database_error_code(duplicate_bootstrap_error, "23505");
    duplicate_bootstrap.rollback().await.unwrap();

    let mut invalid_settings = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO instance_settings (
           id, registration_enabled, register_rate_limit_per_hour,
           login_rate_limit_per_minute, default_max_forms,
           default_max_attachment_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(true)
    .bind(true)
    .bind(5_i32)
    .bind(5_i32)
    .bind(100_i32)
    .bind(1_073_741_824_i64)
    .execute(&mut *invalid_settings)
    .await
    .unwrap();
    let invalid_settings_error = sqlx::query(
        "UPDATE instance_settings SET register_rate_limit_per_hour = 0 WHERE id = TRUE",
    )
    .execute(&mut *invalid_settings)
    .await
    .unwrap_err();
    assert_database_error_code(invalid_settings_error, "23514");
    invalid_settings.rollback().await.unwrap();

    let mut quotas = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(Some(25_i32))
    .bind(Some(1_024_i64))
    .execute(&mut *quotas)
    .await
    .unwrap();
    let duplicate_quota_error = sqlx::query(
        "INSERT INTO account_quotas (user_id, max_forms, max_attachment_bytes)
         VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(Some(26_i32))
    .bind(Some(2_048_i64))
    .execute(&mut *quotas)
    .await
    .unwrap_err();
    assert_database_error_code(duplicate_quota_error, "23505");
    quotas.rollback().await.unwrap();

    let mut usage = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO account_usage (user_id, forms_used, attachment_bytes_used)
         VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(1_i32)
    .bind(512_i64)
    .execute(&mut *usage)
    .await
    .unwrap();
    let duplicate_usage_error = sqlx::query(
        "INSERT INTO account_usage (user_id, forms_used, attachment_bytes_used)
         VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(2_i32)
    .bind(1_024_i64)
    .execute(&mut *usage)
    .await
    .unwrap_err();
    assert_database_error_code(duplicate_usage_error, "23505");
    usage.rollback().await.unwrap();

    let actor_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash)
         VALUES ($1, $2, 'migration-test-hash')",
    )
    .bind(actor_id)
    .bind(format!("instance-admin-audit-{actor_id}@example.com"))
    .execute(&mut connection)
    .await
    .unwrap();

    let mut valid_audit = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(user_id))
    .bind("settings_updated")
    .bind("succeeded")
    .execute(&mut *valid_audit)
    .await
    .unwrap();
    valid_audit.rollback().await.unwrap();

    let mut update_audit = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(user_id))
    .bind("settings_updated")
    .bind("succeeded")
    .execute(&mut *update_audit)
    .await
    .unwrap();
    let update_audit_error =
        sqlx::query("UPDATE admin_audit_events SET result = 'failed' WHERE actor_user_id = $1")
            .bind(actor_id)
            .execute(&mut *update_audit)
            .await
            .unwrap_err();
    assert_database_error_code(update_audit_error, "23514");
    update_audit.rollback().await.unwrap();

    let mut delete_audit = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(user_id))
    .bind("settings_updated")
    .bind("succeeded")
    .execute(&mut *delete_audit)
    .await
    .unwrap();
    let delete_audit_error = sqlx::query("DELETE FROM admin_audit_events WHERE actor_user_id = $1")
        .bind(actor_id)
        .execute(&mut *delete_audit)
        .await
        .unwrap_err();
    assert_database_error_code(delete_audit_error, "23514");
    delete_audit.rollback().await.unwrap();

    let mut truncate_audit = sqlx::Connection::begin(&mut connection).await.unwrap();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(user_id))
    .bind("settings_updated")
    .bind("succeeded")
    .execute(&mut *truncate_audit)
    .await
    .unwrap();
    let truncate_audit_error = sqlx::query("TRUNCATE admin_audit_events")
        .execute(&mut *truncate_audit)
        .await
        .unwrap_err();
    assert_database_error_code(truncate_audit_error, "23514");
    truncate_audit.rollback().await.unwrap();

    let mut invalid_action = sqlx::Connection::begin(&mut connection).await.unwrap();
    let invalid_action_error = sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(user_id))
    .bind("leaked_plaintext")
    .bind("succeeded")
    .execute(&mut *invalid_action)
    .await
    .unwrap_err();
    assert_database_error_code(invalid_action_error, "23514");
    invalid_action.rollback().await.unwrap();

    let mut invalid_result = sqlx::Connection::begin(&mut connection).await.unwrap();
    let invalid_result_error = sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(user_id))
    .bind("settings_updated")
    .bind("verbose_failure")
    .execute(&mut *invalid_result)
    .await
    .unwrap_err();
    assert_database_error_code(invalid_result_error, "23514");
    invalid_result.rollback().await.unwrap();

    drop_schema(&mut connection, &schema_name).await;
}

#[tokio::test]
async fn ownership_retirement_refuses_an_orphan_form_before_dropping_columns() {
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let mut connection = db.acquire().await.unwrap();

    sqlx::raw_sql(
        "CREATE TEMP TABLE forms (
           id UUID PRIMARY KEY,
           owner_id UUID NOT NULL,
           wrapped_form_private_key TEXT NOT NULL,
           wrapped_form_data_key TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE INDEX forms_owner_id_idx ON forms(owner_id);
         CREATE TEMP TABLE users (id UUID PRIMARY KEY);
         CREATE TEMP TABLE form_members (
           id UUID PRIMARY KEY,
           form_id UUID NOT NULL,
           user_id UUID NOT NULL,
           role TEXT NOT NULL,
           state TEXT NOT NULL,
           key_scheme TEXT,
           encrypted_form_data_key TEXT,
           encrypted_form_private_key TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           UNIQUE (form_id, user_id)
         );
         INSERT INTO forms (
           id, owner_id, wrapped_form_private_key, wrapped_form_data_key
         ) VALUES (
           '00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000002',
           'legacy-private', 'legacy-data'
         );",
    )
    .execute(&mut *connection)
    .await
    .unwrap();

    let mut migration = connection.begin().await.unwrap();
    let error = sqlx::raw_sql(include_str!(
        "../migrations/0010_retire_legacy_form_ownership.sql"
    ))
    .execute(&mut *migration)
    .await
    .unwrap_err();

    let database_error = error.as_database_error().unwrap();
    assert_eq!(database_error.code().as_deref(), Some("23514"));
    assert!(
        database_error
            .message()
            .contains("every form must have exactly one Owner membership")
    );
    migration.rollback().await.unwrap();

    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*)
         FROM pg_attribute
         WHERE attrelid = 'forms'::regclass
           AND attname IN (
             'owner_id', 'wrapped_form_private_key', 'wrapped_form_data_key'
           )
           AND NOT attisdropped",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(remaining, 3);

    sqlx::raw_sql("DROP TABLE form_members; DROP TABLE forms; DROP TABLE users;")
        .execute(&mut *connection)
        .await
        .unwrap();
}

#[tokio::test]
async fn admin_audit_ids_survive_user_deletion() {
    let (mut connection, schema_name) = legacy_0011_connection().await;
    apply_corrective_migration(&mut connection).await;
    apply_audit_retention_migration(&mut connection).await;

    let actor_id = Uuid::now_v7();
    let target_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, master_key_salt)
         VALUES
            ($1, 'audit-actor@example.com', 'hash', 'salt'),
            ($2, 'audit-target@example.com', 'hash', 'salt')",
    )
    .bind(actor_id)
    .bind(target_id)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, 'account_deleted', 'succeeded')",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(Some(target_id))
    .execute(&mut connection)
    .await
    .unwrap();

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(target_id)
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(actor_id)
        .execute(&mut connection)
        .await
        .unwrap();

    let retained = sqlx::query_as::<_, (Uuid, Option<Uuid>)>(
        "SELECT actor_user_id, target_user_id
         FROM admin_audit_events
         WHERE action = 'account_deleted' AND result = 'succeeded'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(retained.0, actor_id);
    assert_eq!(retained.1, Some(target_id));

    drop_schema(&mut connection, &schema_name).await;
}

#[tokio::test]
async fn ownership_retirement_backfills_a_recoverable_legacy_owner() {
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let mut connection = db.acquire().await.unwrap();

    sqlx::raw_sql(
        "CREATE TEMP TABLE users (id UUID PRIMARY KEY);
         CREATE TEMP TABLE forms (
           id UUID PRIMARY KEY,
           owner_id UUID NOT NULL REFERENCES users(id),
           wrapped_form_private_key TEXT NOT NULL,
           wrapped_form_data_key TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE INDEX forms_owner_id_idx ON forms(owner_id);
         CREATE TEMP TABLE form_members (
           id UUID PRIMARY KEY,
           form_id UUID NOT NULL,
           user_id UUID NOT NULL,
           role TEXT NOT NULL,
           state TEXT NOT NULL,
           key_scheme TEXT,
           encrypted_form_data_key TEXT,
           encrypted_form_private_key TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           UNIQUE (form_id, user_id),
           CONSTRAINT form_members_user_id_fkey
             FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
         );
         INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000012');
         INSERT INTO forms (
           id, owner_id, wrapped_form_private_key, wrapped_form_data_key
         ) VALUES (
           '00000000-0000-0000-0000-000000000011',
           '00000000-0000-0000-0000-000000000012',
           'legacy-private', 'legacy-data'
         );",
    )
    .execute(&mut *connection)
    .await
    .unwrap();

    sqlx::raw_sql(include_str!(
        "../migrations/0010_retire_legacy_form_ownership.sql"
    ))
    .execute(&mut *connection)
    .await
    .unwrap();

    let member: (String, String, String, String) = sqlx::query_as(
        "SELECT role, state, key_scheme, encrypted_form_data_key
         FROM form_members WHERE form_id = '00000000-0000-0000-0000-000000000011'",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(
        member,
        (
            "owner".into(),
            "active".into(),
            "master_wrap_v1".into(),
            "legacy-data".into()
        )
    );

    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_attribute WHERE attrelid = 'forms'::regclass
         AND attname IN ('owner_id', 'wrapped_form_private_key', 'wrapped_form_data_key')
         AND NOT attisdropped",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn canonical_membership_prevents_user_deletion_from_orphaning_a_form() {
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let user_id = Uuid::now_v7();
    let form_id = Uuid::now_v7();
    let mut fixture = db.begin().await.unwrap();

    sqlx::query(
        "INSERT INTO users (id, email, password_hash)
         VALUES ($1, $2, 'migration-test-hash')",
    )
    .bind(user_id)
    .bind(format!("migration-owner-{user_id}@example.com"))
    .execute(&mut *fixture)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO forms (id, title_ciphertext, schema_ciphertext, form_public_key)
         VALUES ($1, 'title', 'schema', 'public-key')",
    )
    .bind(form_id)
    .execute(&mut *fixture)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO form_members (
           id, form_id, user_id, role, state, key_scheme,
           encrypted_form_data_key, encrypted_form_private_key
         ) VALUES (
           $1, $2, $3, 'owner', 'active', 'master_wrap_v1',
           'data-key', 'private-key'
         )",
    )
    .bind(Uuid::now_v7())
    .bind(form_id)
    .bind(user_id)
    .execute(&mut *fixture)
    .await
    .unwrap();

    let mut deletion = fixture.begin().await.unwrap();
    let error = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&mut *deletion)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    deletion.rollback().await.unwrap();

    let owner_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM form_members
         WHERE form_id = $1 AND user_id = $2 AND role = 'owner'",
    )
    .bind(form_id)
    .bind(user_id)
    .fetch_one(&mut *fixture)
    .await
    .unwrap();
    assert_eq!(owner_count, 1);

    fixture.rollback().await.unwrap();
}
