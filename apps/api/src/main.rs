mod admin;
mod attachments;
mod auth;
mod billing;
mod client_ip;
mod config;
mod email_verify;
mod error;
mod form_access;
mod forms;
mod health;
mod healthcheck;
mod mail;
mod passkey;
mod password;
mod rate_limit;
mod recovery;
mod security_headers;
mod session;
mod sharing;
mod state;
#[cfg(test)]
mod test_db;
mod totp;

use anyhow::Context;
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderName, HeaderValue, Method, header},
    middleware,
    routing::get,
};
use config::{Config, DEFAULT_INSTANCE_MAX_ATTACHMENT_BYTES, DEFAULT_INSTANCE_MAX_FORMS};
use state::AppState;
use tower_http::cors::{AllowOrigin, CorsLayer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `api healthcheck` is the compose file's liveness probe. It returns
    // before anything below runs, so a probe never loads configuration or
    // opens a database connection, and exits nonzero when the server does
    // not answer.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck::run();
    }

    /*
     * Default to info rather than whatever an unset RUST_LOG implies, which is
     * silence: the deployed API emitted nothing at all, not even the line below
     * saying which address it bound, so a container that had failed to reach
     * Postgres and one serving traffic looked identical from outside.
     *
     * RUST_LOG still wins where it is set, so raising or lowering this per
     * deployment needs no code change.
     */
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    // Two rustls crypto backends are linked into this binary: `ring`, which
    // `async-stripe` asks for, and `aws-lc-rs`, pulled in separately by
    // `rust-s3`'s TLS stack. Rustls 0.23 will not guess between them, so the
    // first `rustls::ClientConfig` built with no default provider installed
    // panics. `stripe::Client::new` builds one at startup whenever Stripe is
    // configured, so the provider has to be installed before that, not left
    // to chance.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("a rustls crypto provider was already installed"))?;
    // `.env` is loaded here, once, and `Config::from_env` reads only the
    // process environment. A variable already set in the environment wins
    // over the file, which is what lets a deployment override a setting
    // without editing it.
    dotenvy::dotenv().ok();
    // Shared rather than copied field by field into `AppState`: the handlers
    // read their settings straight off it, so there is one owner of a value
    // instead of a startup copy that can drift from it.
    let config = std::sync::Arc::new(Config::from_env()?);

    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    let mut db_connection = db.acquire().await?;
    seed_instance_settings(&mut db_connection, &config).await?;

    let redis_client = redis::Client::open(config.redis_url.clone())?;
    // Without a max delay, `ConnectionManager`'s own backoff reaches 60
    // seconds after a Redis restart, and the readiness probe times out at 2
    // seconds, well before it ever observes an error from the shared
    // reconnect future. A probe that can report an outage but never observe
    // one that ends it never triggers the reconnect it is waiting on, so it
    // keeps reporting a false outage long after Redis is back. Capping the
    // delay at 500ms and giving the manager its own short response timeout
    // makes it return an error quickly enough for the probe (and every other
    // caller) to observe it and participate in recovery.
    let redis_config = redis::aio::ConnectionManagerConfig::new()
        .set_max_delay(500)
        .set_number_of_retries(10)
        .set_connection_timeout(std::time::Duration::from_secs(2))
        .set_response_timeout(std::time::Duration::from_secs(2));
    let redis = redis::aio::ConnectionManager::new_with_config(redis_client, redis_config).await?;

    let storage = attachments::storage::Storage::new(
        config.s3_endpoint.clone(),
        config.s3_region.clone(),
        config.s3_access_key.clone(),
        config.s3_secret_key.clone(),
        config.s3_bucket.clone(),
        config.s3_operation_timeout_seconds,
    )?;
    let mailer = mail::Mailer::from_config(&config)?;
    sharing::cleanup::spawn(db.clone());
    attachments::cleanup::spawn(
        db.clone(),
        storage.clone(),
        config.attachment_upload_stale_seconds,
        config.attachment_cleanup_interval_seconds,
    );
    forms::notifications::spawn(
        db.clone(),
        mailer.clone(),
        config.web_base_url.clone(),
        config.response_notify_cooldown_seconds,
        config.response_notify_sweep_interval_seconds,
    );
    let webauthn = passkey::build(&config.webauthn_rp_id, &config.webauthn_origin)
        .context("WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must describe the same site")?;
    let stripe_settings: [(&str, &Option<String>); 5] = [
        ("STRIPE_SECRET_KEY", &config.stripe_secret_key),
        ("STRIPE_WEBHOOK_SECRET", &config.stripe_webhook_secret),
        ("STRIPE_PORTAL_RETURN_URL", &config.stripe_portal_return_url),
        ("STRIPE_PRICE_MONTHLY", &config.stripe_price_monthly),
        ("STRIPE_PRICE_YEARLY", &config.stripe_price_yearly),
    ];
    let missing_stripe_settings: Vec<&str> = stripe_settings
        .iter()
        .filter(|(_, value)| value.is_none())
        .map(|(name, _)| *name)
        .collect();
    let stripe = match (
        missing_stripe_settings.len(),
        &config.stripe_secret_key,
        &config.stripe_webhook_secret,
        &config.stripe_portal_return_url,
        &config.stripe_price_monthly,
        &config.stripe_price_yearly,
    ) {
        (
            0,
            Some(secret_key),
            Some(webhook_secret),
            Some(portal_return_url),
            Some(price_monthly),
            Some(price_yearly),
        ) => {
            tracing::info!("billing enabled: Stripe is configured");
            Some(billing::stripe::StripeContext::new(
                secret_key,
                webhook_secret.clone(),
                portal_return_url.clone(),
                price_monthly.clone(),
                price_yearly.clone(),
            ))
        }
        (5, ..) => {
            tracing::info!("billing disabled: Stripe is not configured");
            None
        }
        _ => {
            // All five absent is a coherent self-hosted state. Some but not
            // all present is a misconfiguration: only the missing variable
            // NAMES are logged, never any of the values that are present.
            tracing::warn!(
                missing = %missing_stripe_settings.join(", "),
                "billing disabled: Stripe is partially configured, missing {}",
                missing_stripe_settings.join(", ")
            );
            None
        }
    };
    let billing_enabled = stripe.is_some();
    let trusted_proxy_addresses = client_ip::TrustedProxyAddresses::default();
    client_ip::spawn_proxy_resolver(
        config.trusted_proxy_hosts.clone(),
        trusted_proxy_addresses.clone(),
    )
    .await;
    let state = AppState {
        db,
        redis,
        storage,
        mailer,
        webauthn,
        stripe,
        config: config.clone(),
        readiness: health::readiness::ReadinessCache::new(),
        trusted_proxy_addresses,
    };

    // The browser origins allowed to call this API come from configuration
    // rather than a literal, so they cannot silently disagree with the base URL
    // used to build links in mail. WEB_BASE_URL is always allowed and is the
    // whole list for a normal deployment; CORS_ALLOWED_ORIGINS adds to it, which
    // is what lets a developer keep localhost working while also reaching the
    // dev server from a phone on the machine's LAN address.
    //
    // Still an explicit allowlist, never a reflected origin: echoing back
    // whatever Origin arrives, with credentials enabled, would let any site a
    // logged-in user visits call this API as them.
    let allowed_origins = config
        .cors_allowed_origins
        .iter()
        .map(|origin| {
            origin.parse::<HeaderValue>().with_context(|| {
                format!(
                    "{origin} is not a valid origin; check WEB_BASE_URL and CORS_ALLOWED_ORIGINS"
                )
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-response-token"),
        ])
        .allow_credentials(true);

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        // A readiness probe under the API prefix, because behind Traefik only
        // /api reaches this service. An uptime check points here.
        .route("/api/v1/health", get(health::readiness::handler))
        .route(
            "/api/v1/auth/register",
            axum::routing::post(auth::routes::register),
        )
        .route(
            "/api/v1/auth/verify-email",
            axum::routing::post(auth::routes::verify_email),
        )
        .route(
            "/api/v1/auth/resend",
            axum::routing::post(auth::routes::resend_verification),
        )
        .route(
            "/api/v1/auth/login",
            axum::routing::post(auth::routes::login),
        )
        .route(
            "/api/v1/auth/reauthenticate",
            axum::routing::post(auth::routes::reauthenticate),
        )
        .route("/api/v1/auth/me", axum::routing::get(auth::routes::me))
        .route(
            "/api/v1/auth/logout",
            axum::routing::post(auth::routes::logout),
        )
        .route(
            "/api/v1/auth/logout-all",
            axum::routing::post(auth::routes::logout_all),
        )
        .route(
            "/api/v1/auth/recover/start",
            axum::routing::post(auth::recovery_routes::recover_start),
        )
        .route(
            "/api/v1/auth/recover/verify",
            axum::routing::post(auth::recovery_routes::recover_verify),
        )
        .route(
            "/api/v1/auth/recover/complete",
            axum::routing::post(auth::recovery_routes::recover_complete),
        )
        .route(
            "/api/v1/account/sharing-key",
            axum::routing::get(sharing::keys::get_sharing_key).put(sharing::keys::put_sharing_key),
        )
        .route(
            "/api/v1/account/recovery-code",
            axum::routing::post(auth::recovery_routes::regenerate_recovery_code),
        )
        .route(
            "/api/v1/sharing/provisioning",
            axum::routing::get(sharing::membership::provisioning),
        )
        .route(
            "/api/v1/forms/:id/collaboration",
            axum::routing::get(sharing::membership::collaboration),
        )
        .route(
            "/api/v1/forms/:id/members/me",
            axum::routing::delete(sharing::membership::leave_form)
                .patch(sharing::membership::set_notification_preference),
        )
        .route(
            "/api/v1/forms/:id/members/:member_id",
            axum::routing::patch(sharing::membership::update_member_role)
                .delete(sharing::membership::remove_member),
        )
        .route(
            "/api/v1/forms/:id/members/:member_id/key-grant",
            axum::routing::put(sharing::membership::put_member_grant),
        )
        .route(
            "/api/v1/forms/:id/transfer-ownership",
            axum::routing::post(forms::lifecycle::transfer_ownership),
        )
        .route(
            "/api/v1/forms/:id/invitations/recipient-key",
            axum::routing::post(sharing::invitations::recipient_key),
        )
        .route(
            "/api/v1/forms/:id/invitations",
            axum::routing::post(sharing::invitations::create_invitation),
        )
        .route(
            "/api/v1/forms/:id/invitations/:invitation_id/resend",
            axum::routing::post(sharing::invitations::resend_invitation),
        )
        .route(
            "/api/v1/forms/:id/invitations/:invitation_id",
            axum::routing::delete(sharing::invitations::revoke_invitation),
        )
        .route(
            "/api/v1/invitations/continue",
            axum::routing::post(sharing::invitations::continue_invitation),
        )
        .route(
            "/api/v1/invitations/current",
            axum::routing::get(sharing::invitations::current_invitation),
        )
        .route(
            "/api/v1/invitations/current/accept",
            axum::routing::post(sharing::invitations::accept_invitation),
        )
        .route(
            "/api/v1/invitations/current/decline",
            axum::routing::post(sharing::invitations::decline_invitation),
        )
        .route(
            "/api/v1/auth/2fa/setup",
            axum::routing::post(auth::routes::totp_setup),
        )
        .route(
            "/api/v1/auth/2fa/enable",
            axum::routing::post(auth::routes::totp_enable),
        )
        .route(
            "/api/v1/auth/2fa/disable",
            axum::routing::post(auth::routes::totp_disable),
        )
        .route(
            "/api/v1/auth/2fa/verify",
            axum::routing::post(auth::routes::totp_verify),
        )
        .route(
            "/api/v1/auth/passkeys/register/start",
            axum::routing::post(auth::passkey_routes::register_start),
        )
        .route(
            "/api/v1/auth/passkeys/register/finish",
            axum::routing::post(auth::passkey_routes::register_finish),
        )
        .route(
            "/api/v1/auth/passkeys/login/start",
            axum::routing::post(auth::passkey_routes::login_start),
        )
        .route(
            "/api/v1/auth/passkeys/login/finish",
            axum::routing::post(auth::passkey_routes::login_finish),
        )
        .route(
            "/api/v1/auth/passkeys",
            axum::routing::get(auth::passkey_routes::list),
        )
        .route(
            "/api/v1/auth/passkeys/:id",
            axum::routing::delete(auth::passkey_routes::delete),
        )
        .route(
            "/api/v1/admin/accounts",
            axum::routing::get(admin::routes::list_accounts),
        )
        .route(
            "/api/v1/admin/settings",
            axum::routing::get(admin::routes::get_settings).patch(admin::routes::patch_settings),
        )
        .route(
            "/api/v1/admin/audit",
            axum::routing::get(admin::routes::list_audit),
        )
        .route(
            "/api/v1/admin/accounts/:id/suspend",
            axum::routing::post(admin::account_lifecycle::suspend_account),
        )
        .route(
            "/api/v1/admin/accounts/:id/reactivate",
            axum::routing::post(admin::account_lifecycle::reactivate_account),
        )
        .route(
            "/api/v1/admin/accounts/:id/eligible-transfers",
            axum::routing::get(admin::routes::list_eligible_ownership_transfers),
        )
        .route(
            "/api/v1/admin/accounts/:id",
            axum::routing::delete(admin::account_lifecycle::delete_account),
        )
        .route(
            "/api/v1/admin/forms/:form_id/transfer",
            axum::routing::post(admin::account_lifecycle::transfer_form),
        )
        .route(
            "/api/v1/admin/health",
            axum::routing::get(health::report::handler),
        )
        .route(
            "/api/v1/forms",
            axum::routing::post(forms::routes::create_form).get(forms::routes::list_forms),
        )
        .route(
            "/api/v1/forms/:id",
            axum::routing::get(forms::routes::get_form)
                .patch(forms::routes::update_form)
                .delete(forms::lifecycle::delete_form),
        )
        .route(
            "/api/v1/forms/:id/public",
            axum::routing::get(forms::routes::get_form_public),
        )
        .route(
            "/api/v1/forms/:id/grades",
            axum::routing::get(forms::grades::get_grades).put(forms::grades::put_grades),
        )
        .route(
            "/api/v1/forms/:id/responses",
            axum::routing::post(forms::routes::submit_response)
                .layer(DefaultBodyLimit::max(
                    forms::routes::MAX_RESPONSE_BODY_BYTES,
                ))
                .get(forms::routes::list_responses),
        )
        .route(
            "/api/v1/forms/:id/responses/edit",
            axum::routing::patch(forms::routes::update_response).layer(DefaultBodyLimit::max(
                forms::routes::MAX_RESPONSE_BODY_BYTES,
            )),
        )
        .route(
            "/api/v1/forms/:id/responses/:response_id",
            axum::routing::delete(forms::routes::delete_response),
        )
        .route(
            "/api/v1/forms/:id/attachments",
            axum::routing::post(attachments::routes::upload_attachment)
                .layer(DefaultBodyLimit::max(11 * 1024 * 1024)),
        )
        .route(
            "/api/v1/forms/:id/attachments/:attachment_id",
            axum::routing::get(attachments::routes::download_attachment),
        )
        // Public on purpose: a respondent sees the header before they have any
        // reason to hold a session, and the bytes are ciphertext either way.
        .route(
            "/api/v1/forms/:id/header-image",
            axum::routing::get(attachments::routes::download_header_image),
        );

    // Merged in only when Stripe is configured, so a self-hosted instance
    // with no billing settings has no billing routes at all rather than
    // ones that error on every call.
    let app = if billing_enabled {
        app.merge(billing::routes::router())
    } else {
        app
    };

    let app = app
        .with_state(state)
        .layer(cors)
        .layer(middleware::from_fn(security_headers::add_security_headers));

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn seed_instance_settings(
    db: &mut sqlx::PgConnection,
    config: &Config,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO instance_settings (
           id,
           registration_enabled,
           register_rate_limit_per_hour,
           login_rate_limit_per_minute,
           default_max_forms,
           default_max_attachment_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(true)
    .bind(true)
    .bind(
        i32::try_from(config.register_rate_limit)
            .context("REGISTER_RATE_LIMIT_PER_HOUR exceeds supported database range")?,
    )
    .bind(
        i32::try_from(config.login_rate_limit)
            .context("LOGIN_RATE_LIMIT_PER_MINUTE exceeds supported database range")?,
    )
    .bind(DEFAULT_INSTANCE_MAX_FORMS)
    .bind(DEFAULT_INSTANCE_MAX_ATTACHMENT_BYTES)
    .execute(&mut *db)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Config, seed_instance_settings};
    use crate::config::{DEFAULT_INSTANCE_MAX_ATTACHMENT_BYTES, DEFAULT_INSTANCE_MAX_FORMS};
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, Row};
    use uuid::Uuid;

    static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

    fn test_config() -> Config {
        Config {
            database_url: "postgres://localhost/test".into(),
            redis_url: "redis://localhost".into(),
            port: 8080,
            s3_endpoint: "http://localhost:3900".into(),
            s3_region: "garage".into(),
            s3_access_key: "access".into(),
            s3_secret_key: "secret".into(),
            s3_bucket: "bucket".into(),
            s3_operation_timeout_seconds: 30,
            attachment_upload_stale_seconds: 120,
            attachment_cleanup_interval_seconds: 60,
            register_rate_limit: 77,
            login_rate_limit: 33,
            initial_admin_email: None,
            smtp_host: "localhost".into(),
            smtp_port: 1025,
            smtp_user: String::new(),
            smtp_password: String::new(),
            smtp_tls: "none".into(),
            mail_from: "krypta <no-reply@localhost>".into(),
            verify_code_ttl_seconds: 900,
            verify_max_attempts: 5,
            resend_cooldown_seconds: 60,
            register_email_rate_limit: 5,
            verify_rate_limit: 10,
            recover_start_rate_limit: 5,
            recover_verify_rate_limit: 5,
            recover_max_attempts: 5,
            web_base_url: "http://localhost:3000".into(),
            cors_allowed_origins: vec!["http://localhost:3000".into()],
            invite_rate_limit_per_hour: 20,
            invite_rate_limit_per_day: 100,
            invite_recipient_rate_limit_per_hour: 3,
            invite_continuation_rate_limit_per_hour: 30,
            response_notify_cooldown_seconds: 3600,
            response_notify_sweep_interval_seconds: 30,
            webauthn_rp_id: "localhost".into(),
            webauthn_origin: "http://localhost:3000".into(),
            passkey_rate_limit: 10,
            stripe_secret_key: None,
            stripe_webhook_secret: None,
            stripe_portal_return_url: None,
            stripe_price_monthly: None,
            stripe_price_yearly: None,
            backup_s3_bucket: None,
            trusted_proxy_cidrs: Vec::new(),
            trusted_proxy_hosts: Vec::new(),
        }
    }

    async fn full_migrated_connection() -> (sqlx::PgConnection, String) {
        let mut connection = sqlx::PgConnection::connect_with(&crate::test_db::options().await)
            .await
            .unwrap();
        let schema_name = format!("task1_seed_{}", Uuid::now_v7().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema_name}"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(&format!("SET search_path TO {schema_name}, public"))
            .execute(&mut connection)
            .await
            .unwrap();
        MIGRATOR.run_direct(&mut connection).await.unwrap();
        (connection, schema_name)
    }

    async fn legacy_0011_connection() -> (sqlx::PgConnection, String) {
        let mut connection = sqlx::PgConnection::connect_with(&crate::test_db::options().await)
            .await
            .unwrap();
        let schema_name = format!("task1_seed_legacy_{}", Uuid::now_v7().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema_name}"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(&format!("SET search_path TO {schema_name}, public"))
            .execute(&mut connection)
            .await
            .unwrap();
        apply_migrations_through_0011(&mut connection).await;
        (connection, schema_name)
    }

    async fn drop_schema(connection: &mut sqlx::PgConnection, schema_name: &str) {
        sqlx::query("RESET search_path")
            .execute(&mut *connection)
            .await
            .unwrap();
        sqlx::query(&format!("DROP SCHEMA {schema_name} CASCADE"))
            .execute(&mut *connection)
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
            include_str!("../migrations/0013_harden_instance_account_lifecycle.sql"),
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

    #[tokio::test]
    async fn seed_instance_settings_inserts_configured_limits_on_fresh_full_migration_path() {
        let (mut connection, schema_name) = full_migrated_connection().await;

        let pre_seed_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM instance_settings")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(pre_seed_rows, 0);

        let config = test_config();
        seed_instance_settings(&mut connection, &config)
            .await
            .unwrap();

        let row = sqlx::query(
            "SELECT
               registration_enabled,
               register_rate_limit_per_hour,
               login_rate_limit_per_minute,
               default_max_forms,
               default_max_attachment_bytes
             FROM instance_settings
             WHERE id = TRUE",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert!(row.get::<bool, _>(0));
        assert_eq!(row.get::<i32, _>(1), 77);
        assert_eq!(row.get::<i32, _>(2), 33);
        assert_eq!(row.get::<i32, _>(3), DEFAULT_INSTANCE_MAX_FORMS);
        assert_eq!(row.get::<i64, _>(4), DEFAULT_INSTANCE_MAX_ATTACHMENT_BYTES);

        drop_schema(&mut connection, &schema_name).await;
    }

    #[tokio::test]
    async fn seed_instance_settings_inserts_configured_limits_after_legacy_0011_upgrade() {
        let (mut connection, schema_name) = legacy_0011_connection().await;

        let legacy_seed = sqlx::query(
            "SELECT register_rate_limit_per_hour, login_rate_limit_per_minute
             FROM instance_settings WHERE id = TRUE",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(legacy_seed.get::<i32, _>(0), 5);
        assert_eq!(legacy_seed.get::<i32, _>(1), 5);

        apply_corrective_migration(&mut connection).await;

        let post_upgrade_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM instance_settings")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(post_upgrade_rows, 0);

        seed_instance_settings(&mut connection, &test_config())
            .await
            .unwrap();

        let row = sqlx::query(
            "SELECT
               registration_enabled,
               register_rate_limit_per_hour,
               login_rate_limit_per_minute,
               default_max_forms,
               default_max_attachment_bytes
             FROM instance_settings
             WHERE id = TRUE",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert!(row.get::<bool, _>(0));
        assert_eq!(row.get::<i32, _>(1), 77);
        assert_eq!(row.get::<i32, _>(2), 33);
        assert_eq!(row.get::<i32, _>(3), DEFAULT_INSTANCE_MAX_FORMS);
        assert_eq!(row.get::<i64, _>(4), DEFAULT_INSTANCE_MAX_ATTACHMENT_BYTES);

        drop_schema(&mut connection, &schema_name).await;
    }

    #[tokio::test]
    async fn seed_instance_settings_preserves_existing_operator_values() {
        let (mut connection, schema_name) = full_migrated_connection().await;

        sqlx::query(
            "INSERT INTO instance_settings (
               id,
               registration_enabled,
               register_rate_limit_per_hour,
               login_rate_limit_per_minute,
               default_max_forms,
               default_max_attachment_bytes
             ) VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(true)
        .bind(false)
        .bind(9_i32)
        .bind(11_i32)
        .bind(42_i32)
        .bind(4_096_i64)
        .execute(&mut connection)
        .await
        .unwrap();

        seed_instance_settings(&mut connection, &test_config())
            .await
            .unwrap();

        let row = sqlx::query(
            "SELECT
               registration_enabled,
               register_rate_limit_per_hour,
               login_rate_limit_per_minute,
               default_max_forms,
               default_max_attachment_bytes
             FROM instance_settings
             WHERE id = TRUE",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert!(!row.get::<bool, _>(0));
        assert_eq!(row.get::<i32, _>(1), 9);
        assert_eq!(row.get::<i32, _>(2), 11);
        assert_eq!(row.get::<i32, _>(3), 42);
        assert_eq!(row.get::<i64, _>(4), 4_096);

        drop_schema(&mut connection, &schema_name).await;
    }
}
