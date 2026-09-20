use anyhow::{Context, Result};

pub const DEFAULT_INSTANCE_MAX_FORMS: i32 = 100;
pub const DEFAULT_INSTANCE_MAX_ATTACHMENT_BYTES: i64 = 1_073_741_824;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub port: u16,
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_bucket: String,
    pub s3_operation_timeout_seconds: u64,
    pub attachment_upload_stale_seconds: i64,
    pub attachment_cleanup_interval_seconds: u64,
    /// Registrations allowed per IP per hour. Configurable so the e2e suite can
    /// raise it locally; production keeps the default.
    pub register_rate_limit: u32,
    /// Login attempts allowed per IP and email per minute. Same reasoning: the
    /// integration suites log in far more often than a person would.
    pub login_rate_limit: u32,
    pub initial_admin_email: Option<String>,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    /// `starttls`, `implicit`, or `none`. `none` is plaintext SMTP and is
    /// only appropriate for mailpit on localhost.
    pub smtp_tls: String,
    pub mail_from: String,
    /// How long a pending signup stays redeemable.
    pub verify_code_ttl_seconds: u64,
    /// Wrong codes allowed before the pending signup is destroyed. Six digits
    /// fall fast to guessing, so this cap is the real protection.
    pub verify_max_attempts: u32,
    pub resend_cooldown_seconds: i64,
    /// Registrations allowed per address per hour, so one address cannot be
    /// mail-bombed by repeated signup attempts from rotating IPs.
    pub register_email_rate_limit: u32,
    /// Verification attempts allowed per IP per minute.
    pub verify_rate_limit: u32,
    /// Recovery attempts started per IP per hour. Starting a recovery mails a
    /// code to an address the caller named, so this is a mail-abuse limit as
    /// much as a credential one.
    pub recover_start_rate_limit: u32,
    /// Recovery verifications allowed per IP per minute.
    pub recover_verify_rate_limit: u32,
    /// Wrong emailed codes allowed before the pending recovery is destroyed.
    pub recover_max_attempts: u32,
    pub web_base_url: String,
    /// Browser origins permitted to call this API. Defaults to the one
    /// `web_base_url` names, which is the only origin a normal deployment
    /// serves from. It is a list because a developer testing on a phone needs
    /// the machine's LAN address allowed alongside localhost, and pinning it
    /// to a single value forces them to give one of the two up.
    pub cors_allowed_origins: Vec<String>,
    pub invite_rate_limit_per_hour: u32,
    pub invite_rate_limit_per_day: u32,
    pub invite_recipient_rate_limit_per_hour: u32,
    pub invite_continuation_rate_limit_per_hour: u32,
    /// Quiet window after a response notification is sent to one member.
    /// Bounds a public form's mail volume by construction rather than by a
    /// cap that can be silently exhausted.
    pub response_notify_cooldown_seconds: i64,
    /// How often the notification sweep runs. "Immediate" means within one
    /// interval.
    pub response_notify_sweep_interval_seconds: u64,
    /// The WebAuthn relying party ID. Baked into every credential permanently:
    /// changing it turns every enrolled passkey into dead weight.
    pub webauthn_rp_id: String,
    /// The origin the browser will report. Its effective domain must equal
    /// `webauthn_rp_id` or `WebauthnBuilder::new` refuses to build.
    pub webauthn_origin: String,
    /// Passkey ceremony attempts allowed per IP per minute.
    pub passkey_rate_limit: u32,
    /// Billing is inert unless all of these are set. Absent configuration means
    /// the feature does not exist, which is the correct state for a self-hosted
    /// instance rather than a misconfiguration. Contrast WEBAUTHN_RP_ID, which
    /// is required precisely because its absence produced a silently broken
    /// feature.
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub stripe_portal_return_url: Option<String>,
    pub stripe_price_monthly: Option<String>,
    pub stripe_price_yearly: Option<String>,
    /// Read only so the health report can say whether backups leave this
    /// server. `backup.sh` sources `.env.prod` itself and does not use this.
    pub backup_s3_bucket: Option<String>,
    pub trusted_proxy_cidrs: Vec<ipnet::IpNet>,
    /// Proxies trusted by name, resolved through DNS. See client_ip.rs.
    pub trusted_proxy_hosts: Vec<String>,
}

/// Reads an optional setting, treating an empty or whitespace-only value as
/// absent.
///
/// A present-but-empty variable is how a shipped `.env.example` names a
/// setting without enabling it, and how a test or a deployment turns one off
/// without editing the file: `dotenvy` does not override a variable that is
/// already set, so removing it from the environment would only let the file
/// put it back. `""` has to mean unset or there is no way to say "off".
fn optional_setting(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// A tuning setting with a production default. Reads through
/// `optional_setting`, so a blank value falls back to the default instead of
/// failing to parse: the production compose file forwards every one of these
/// from `.env.prod` as `${NAME:-}`, and an operator who leaves a line empty
/// there means "use the default", not "use the empty string".
fn setting_or(name: &str, default: &str) -> String {
    optional_setting(name).unwrap_or_else(|| default.to_string())
}

impl Config {
    /// Whether outbound mail can actually be sent.
    ///
    /// Derived rather than stored: it is a question about the SMTP settings,
    /// and a second field holding the answer is a second thing that can
    /// disagree with them.
    pub fn mail_configured(&self) -> bool {
        !self.smtp_host.trim().is_empty() && !self.mail_from.trim().is_empty()
    }

    /// Whether this instance bills. Stripe is all-or-nothing: some settings
    /// but not all is a misconfiguration rather than a choice, and is
    /// reported as such instead of silently reading as off.
    pub fn billing_status(&self) -> &'static str {
        let present = [
            self.stripe_secret_key.is_some(),
            self.stripe_webhook_secret.is_some(),
            self.stripe_portal_return_url.is_some(),
            self.stripe_price_monthly.is_some(),
            self.stripe_price_yearly.is_some(),
        ];
        if present.iter().all(|set| *set) {
            "configured"
        } else if present.iter().any(|set| *set) {
            "partial"
        } else {
            "inert"
        }
    }

    /// Whether outbound mail can be sent at all.
    pub fn mail_status(&self) -> &'static str {
        if self.mail_configured() {
            "configured"
        } else {
            "missing"
        }
    }

    /// Whether the WebAuthn relying party id was chosen or fell back to the
    /// host in `web_base_url`. Not a fault: the default is correct for a
    /// single-app instance. It is reported because the id is baked into every
    /// credential and can be narrowed later but never widened.
    pub fn passkey_status(&self) -> &'static str {
        let host = self
            .web_base_url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or("");
        if self.webauthn_rp_id == host {
            "defaulted"
        } else {
            "configured"
        }
    }

    /// Whether encrypted backups leave this server. `local_only` means
    /// `backup.sh` runs and keeps copies here, which is not a backup of the
    /// server, and the script says so on every run.
    pub fn backup_status(&self) -> &'static str {
        if self.backup_s3_bucket.is_some() {
            "configured"
        } else {
            "local_only"
        }
    }

    /// Deterministic settings for the in-crate tests.
    ///
    /// Written out rather than read from the environment on purpose: the point
    /// of a fixture is that a test asserting on a cooldown or an attempt cap
    /// gets the same answer on every machine, and `from_env` would hand it
    /// whatever the developer's `.env` happens to say. The rate limits are
    /// deliberately high, because these suites authenticate far more often
    /// than a person would.
    ///
    /// The values that reach a real service (the database and Redis URLs) are
    /// the exception and do come from the environment, since a fixture cannot
    /// invent a running instance.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        dotenvy::dotenv().ok();
        Self {
            database_url: std::env::var("DATABASE_URL").unwrap_or_default(),
            redis_url: std::env::var("REDIS_URL").unwrap_or_default(),
            port: 8080,
            s3_endpoint: "http://localhost:3900".to_string(),
            s3_region: "garage".to_string(),
            s3_access_key: "test-access-key".to_string(),
            s3_secret_key: "test-secret-key".to_string(),
            s3_bucket: "krypta".to_string(),
            s3_operation_timeout_seconds: 30,
            attachment_upload_stale_seconds: 120,
            attachment_cleanup_interval_seconds: 60,
            register_rate_limit: 100,
            login_rate_limit: 100,
            initial_admin_email: None,
            smtp_host: "localhost".to_string(),
            smtp_port: 1025,
            smtp_user: String::new(),
            smtp_password: String::new(),
            smtp_tls: "none".to_string(),
            mail_from: "krypta@example.test".to_string(),
            verify_code_ttl_seconds: 900,
            verify_max_attempts: 5,
            resend_cooldown_seconds: 60,
            register_email_rate_limit: 100,
            verify_rate_limit: 100,
            recover_start_rate_limit: 100,
            recover_verify_rate_limit: 100,
            recover_max_attempts: 5,
            web_base_url: "https://app.example".to_string(),
            cors_allowed_origins: Vec::new(),
            invite_rate_limit_per_hour: 100,
            invite_rate_limit_per_day: 100,
            invite_recipient_rate_limit_per_hour: 100,
            invite_continuation_rate_limit_per_hour: 30,
            response_notify_cooldown_seconds: 3600,
            response_notify_sweep_interval_seconds: 60,
            webauthn_rp_id: "localhost".to_string(),
            webauthn_origin: "http://localhost:3000".to_string(),
            passkey_rate_limit: 100,
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

    /// Reads the process environment and nothing else. Loading `.env` is the
    /// binary's job, done in `main` before this is called: a parser that
    /// reads a file on the side cannot be tested against an environment the
    /// test controls, because the file puts back whatever the test removed.
    pub fn from_env() -> Result<Self> {
        // Bound before the struct literal because two fields derive from it.
        let web_base_url = setting_or("WEB_BASE_URL", "http://localhost:3000")
            .trim_end_matches('/')
            .to_string();
        let config = Config {
            database_url: std::env::var("DATABASE_URL").context("DATABASE_URL not set")?,
            redis_url: std::env::var("REDIS_URL").context("REDIS_URL not set")?,
            port: setting_or("PORT", "8080")
                .parse()
                .context("PORT must be a number")?,
            s3_endpoint: std::env::var("S3_ENDPOINT").context("S3_ENDPOINT not set")?,
            s3_region: setting_or("S3_REGION", "garage"),
            s3_access_key: std::env::var("S3_ACCESS_KEY").context("S3_ACCESS_KEY not set")?,
            s3_secret_key: std::env::var("S3_SECRET_KEY").context("S3_SECRET_KEY not set")?,
            s3_bucket: std::env::var("S3_BUCKET").context("S3_BUCKET not set")?,
            s3_operation_timeout_seconds: setting_or("S3_OPERATION_TIMEOUT_SECONDS", "30")
                .parse()
                .context("S3_OPERATION_TIMEOUT_SECONDS must be a number")?,
            attachment_upload_stale_seconds: setting_or("ATTACHMENT_UPLOAD_STALE_SECONDS", "120")
                .parse()
                .context("ATTACHMENT_UPLOAD_STALE_SECONDS must be a number")?,
            attachment_cleanup_interval_seconds: std::env::var(
                "ATTACHMENT_CLEANUP_INTERVAL_SECONDS",
            )
            .unwrap_or_else(|_| "60".to_string())
            .parse()
            .context("ATTACHMENT_CLEANUP_INTERVAL_SECONDS must be a number")?,
            register_rate_limit: setting_or("REGISTER_RATE_LIMIT_PER_HOUR", "5")
                .parse()
                .context("REGISTER_RATE_LIMIT_PER_HOUR must be a number")?,
            login_rate_limit: setting_or("LOGIN_RATE_LIMIT_PER_MINUTE", "5")
                .parse()
                .context("LOGIN_RATE_LIMIT_PER_MINUTE must be a number")?,
            initial_admin_email: load_optional_normalized_email("KRYPTA_INITIAL_ADMIN_EMAIL")?,
            smtp_host: std::env::var("SMTP_HOST").context("SMTP_HOST not set")?,
            smtp_port: setting_or("SMTP_PORT", "1025")
                .parse()
                .context("SMTP_PORT must be a number")?,
            smtp_user: std::env::var("SMTP_USER").unwrap_or_default(),
            smtp_password: std::env::var("SMTP_PASSWORD").unwrap_or_default(),
            smtp_tls: setting_or("SMTP_TLS", "starttls"),
            mail_from: std::env::var("MAIL_FROM").context("MAIL_FROM not set")?,
            verify_code_ttl_seconds: setting_or("VERIFY_CODE_TTL_SECONDS", "900")
                .parse()
                .context("VERIFY_CODE_TTL_SECONDS must be a number")?,
            verify_max_attempts: setting_or("VERIFY_MAX_ATTEMPTS", "5")
                .parse()
                .context("VERIFY_MAX_ATTEMPTS must be a number")?,
            resend_cooldown_seconds: setting_or("RESEND_COOLDOWN_SECONDS", "60")
                .parse()
                .context("RESEND_COOLDOWN_SECONDS must be a number")?,
            register_email_rate_limit: setting_or("REGISTER_EMAIL_RATE_LIMIT_PER_HOUR", "5")
                .parse()
                .context("REGISTER_EMAIL_RATE_LIMIT_PER_HOUR must be a number")?,
            verify_rate_limit: setting_or("VERIFY_RATE_LIMIT_PER_MINUTE", "10")
                .parse()
                .context("VERIFY_RATE_LIMIT_PER_MINUTE must be a number")?,
            recover_start_rate_limit: setting_or("RECOVER_START_RATE_LIMIT_PER_HOUR", "5")
                .parse()
                .context("RECOVER_START_RATE_LIMIT_PER_HOUR must be a number")?,
            recover_verify_rate_limit: setting_or("RECOVER_VERIFY_RATE_LIMIT_PER_MINUTE", "5")
                .parse()
                .context("RECOVER_VERIFY_RATE_LIMIT_PER_MINUTE must be a number")?,
            recover_max_attempts: setting_or("RECOVER_MAX_ATTEMPTS", "5")
                .parse()
                .context("RECOVER_MAX_ATTEMPTS must be a number")?,
            web_base_url: web_base_url.clone(),
            cors_allowed_origins: {
                let extra = std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_default();
                let mut origins: Vec<String> = extra
                    .split(',')
                    .map(|o| o.trim().trim_end_matches('/').to_string())
                    .filter(|o| !o.is_empty())
                    .collect();
                // The site's own origin is always allowed: omitting it from the
                // extra list would otherwise lock out the deployment itself.
                if !origins.contains(&web_base_url) {
                    origins.insert(0, web_base_url);
                }
                origins
            },
            invite_rate_limit_per_hour: setting_or("INVITE_RATE_LIMIT_PER_HOUR", "20")
                .parse()
                .context("INVITE_RATE_LIMIT_PER_HOUR must be a number")?,
            invite_rate_limit_per_day: setting_or("INVITE_RATE_LIMIT_PER_DAY", "100")
                .parse()
                .context("INVITE_RATE_LIMIT_PER_DAY must be a number")?,
            invite_recipient_rate_limit_per_hour: std::env::var(
                "INVITE_RECIPIENT_RATE_LIMIT_PER_HOUR",
            )
            .unwrap_or_else(|_| "3".to_string())
            .parse()
            .context("INVITE_RECIPIENT_RATE_LIMIT_PER_HOUR must be a number")?,
            invite_continuation_rate_limit_per_hour: std::env::var(
                "INVITE_CONTINUATION_RATE_LIMIT_PER_HOUR",
            )
            .unwrap_or_else(|_| "30".to_string())
            .parse()
            .context("INVITE_CONTINUATION_RATE_LIMIT_PER_HOUR must be a number")?,
            response_notify_cooldown_seconds: setting_or(
                "RESPONSE_NOTIFY_COOLDOWN_SECONDS",
                "3600",
            )
            .parse()
            .context("RESPONSE_NOTIFY_COOLDOWN_SECONDS must be a number")?,
            response_notify_sweep_interval_seconds: std::env::var(
                "RESPONSE_NOTIFY_SWEEP_INTERVAL_SECONDS",
            )
            .unwrap_or_else(|_| "30".to_string())
            .parse()
            .context("RESPONSE_NOTIFY_SWEEP_INTERVAL_SECONDS must be a number")?,
            // Required rather than defaulted, deliberately. A localhost default
            // is wrong everywhere except a developer's machine, and it fails in
            // the worst possible way: the service starts cleanly, logs nothing
            // unusual, and every passkey ceremony is then rejected by the
            // browser's origin check, so enrolment and login simply do not work
            // with no server-side error naming the cause. Refusing to start is
            // the loud version of the same mistake.
            webauthn_rp_id: std::env::var("WEBAUTHN_RP_ID").context("WEBAUTHN_RP_ID not set")?,
            webauthn_origin: std::env::var("WEBAUTHN_ORIGIN").context("WEBAUTHN_ORIGIN not set")?,
            passkey_rate_limit: setting_or("PASSKEY_RATE_LIMIT_PER_MINUTE", "10")
                .parse()
                .context("PASSKEY_RATE_LIMIT_PER_MINUTE must be a number")?,
            stripe_secret_key: optional_setting("STRIPE_SECRET_KEY"),
            stripe_webhook_secret: optional_setting("STRIPE_WEBHOOK_SECRET"),
            stripe_portal_return_url: optional_setting("STRIPE_PORTAL_RETURN_URL"),
            stripe_price_monthly: optional_setting("STRIPE_PRICE_MONTHLY"),
            stripe_price_yearly: optional_setting("STRIPE_PRICE_YEARLY"),
            backup_s3_bucket: optional_setting("BACKUP_S3_BUCKET"),
            // Empty means no proxy is trusted and X-Forwarded-For is ignored,
            // which is right for a directly exposed API and for the suites.
            // See client_ip.rs for what trusting one changes.
            trusted_proxy_cidrs: crate::client_ip::parse_trusted_proxies(
                &std::env::var("TRUSTED_PROXY_CIDRS").unwrap_or_default(),
            )?,
            // The same trust, granted to named containers rather than a range:
            // for a proxy network other applications share. Empty by default.
            trusted_proxy_hosts: crate::client_ip::parse_trusted_proxy_hosts(
                &std::env::var("TRUSTED_PROXY_HOSTS").unwrap_or_default(),
            )?,
        };
        if config.s3_operation_timeout_seconds == 0 {
            anyhow::bail!("S3_OPERATION_TIMEOUT_SECONDS must be positive");
        }
        if config.attachment_upload_stale_seconds
            <= i64::try_from(config.s3_operation_timeout_seconds).unwrap_or(i64::MAX)
        {
            anyhow::bail!(
                "ATTACHMENT_UPLOAD_STALE_SECONDS must exceed S3_OPERATION_TIMEOUT_SECONDS"
            );
        }
        if config.attachment_cleanup_interval_seconds == 0 {
            anyhow::bail!("ATTACHMENT_CLEANUP_INTERVAL_SECONDS must be positive");
        }
        Ok(config)
    }
}

fn load_optional_normalized_email(name: &str) -> Result<Option<String>> {
    match std::env::var(name) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            Ok(Some(trimmed.to_ascii_lowercase()))
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(error).with_context(|| format!("{name} could not be read")),
    }
}

#[cfg(test)]
mod tests {
    use super::{Config, setting_or};
    use std::sync::{Mutex, OnceLock};

    /// Restores the environment even if the test body panics.
    ///
    /// Without this, a panicking assertion inside `test()` leaves DATABASE_URL
    /// pointing at this harness's placeholder for the rest of the process, and
    /// every later database-touching test in this binary connects to a stray
    /// unmigrated database instead of failing honestly on its own merits.
    struct EnvRestore(Vec<(&'static str, Option<String>)>);

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (name, value) in self.0.drain(..) {
                match value {
                    Some(value) => unsafe { std::env::set_var(name, value) },
                    None => unsafe { std::env::remove_var(name) },
                }
            }
        }
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        // This lock only guards process environment variables, not an
        // invariant a panic could leave corrupted, so recovering from
        // poisoning is correct: it stops one failing test's panic from
        // cascading into every later test that takes the lock.
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn with_test_env(initial_admin_email: Option<&str>, test: impl FnOnce() -> anyhow::Result<()>) {
        let _guard = env_lock();
        let vars = [
            ("DATABASE_URL", "postgres://localhost/test"),
            ("REDIS_URL", "redis://localhost"),
            ("PORT", "8080"),
            ("S3_ENDPOINT", "http://localhost:3900"),
            ("S3_ACCESS_KEY", "access"),
            ("S3_SECRET_KEY", "secret"),
            ("S3_BUCKET", "bucket"),
            ("S3_OPERATION_TIMEOUT_SECONDS", "30"),
            ("ATTACHMENT_UPLOAD_STALE_SECONDS", "120"),
            ("ATTACHMENT_CLEANUP_INTERVAL_SECONDS", "60"),
            ("REGISTER_RATE_LIMIT_PER_HOUR", "5"),
            ("LOGIN_RATE_LIMIT_PER_MINUTE", "5"),
            ("SMTP_HOST", "localhost"),
            ("SMTP_PORT", "1025"),
            ("SMTP_USER", ""),
            ("SMTP_PASSWORD", ""),
            ("SMTP_TLS", "none"),
            ("MAIL_FROM", "krypta <no-reply@localhost>"),
            ("VERIFY_CODE_TTL_SECONDS", "900"),
            ("VERIFY_MAX_ATTEMPTS", "5"),
            ("RESEND_COOLDOWN_SECONDS", "60"),
            ("REGISTER_EMAIL_RATE_LIMIT_PER_HOUR", "5"),
            ("VERIFY_RATE_LIMIT_PER_MINUTE", "10"),
            ("RECOVER_START_RATE_LIMIT_PER_HOUR", "5"),
            ("RECOVER_VERIFY_RATE_LIMIT_PER_MINUTE", "5"),
            ("RECOVER_MAX_ATTEMPTS", "5"),
            ("WEB_BASE_URL", "http://localhost:3000"),
            ("INVITE_RATE_LIMIT_PER_HOUR", "20"),
            ("INVITE_RATE_LIMIT_PER_DAY", "100"),
            ("INVITE_RECIPIENT_RATE_LIMIT_PER_HOUR", "3"),
            ("INVITE_CONTINUATION_RATE_LIMIT_PER_HOUR", "30"),
            ("WEBAUTHN_RP_ID", "localhost"),
            ("WEBAUTHN_ORIGIN", "http://localhost:3000"),
        ];

        let mut previous = Vec::with_capacity(vars.len() + 1);
        for (name, value) in vars {
            previous.push((name, std::env::var(name).ok()));
            unsafe { std::env::set_var(name, value) };
        }

        previous.push((
            "KRYPTA_INITIAL_ADMIN_EMAIL",
            std::env::var("KRYPTA_INITIAL_ADMIN_EMAIL").ok(),
        ));
        match initial_admin_email {
            Some(value) => unsafe { std::env::set_var("KRYPTA_INITIAL_ADMIN_EMAIL", value) },
            None => unsafe { std::env::remove_var("KRYPTA_INITIAL_ADMIN_EMAIL") },
        }

        let _restore = EnvRestore(previous);

        let result = test();

        result.unwrap();
    }

    #[test]
    fn initial_admin_email_is_none_when_unset() {
        with_test_env(None, || {
            let config = Config::from_env()?;
            assert_eq!(config.initial_admin_email, None);
            Ok(())
        });
    }

    #[test]
    fn a_blank_tuning_value_means_the_default() {
        let _guard = env_lock();
        // SAFETY: the same single-threaded env discipline every other test in
        // this module relies on, serialized by `env_lock`.
        unsafe { std::env::set_var("KRYPTA_TEST_BLANK_TUNING", "") };
        assert_eq!(setting_or("KRYPTA_TEST_BLANK_TUNING", "42"), "42");
        unsafe { std::env::set_var("KRYPTA_TEST_BLANK_TUNING", "7") };
        assert_eq!(setting_or("KRYPTA_TEST_BLANK_TUNING", "42"), "7");
        unsafe { std::env::remove_var("KRYPTA_TEST_BLANK_TUNING") };
        assert_eq!(setting_or("KRYPTA_TEST_BLANK_TUNING", "42"), "42");
    }

    #[test]
    fn initial_admin_email_is_none_when_empty() {
        with_test_env(Some("   "), || {
            let config = Config::from_env()?;
            assert_eq!(config.initial_admin_email, None);
            Ok(())
        });
    }

    #[test]
    fn initial_admin_email_is_trimmed_and_lowercased() {
        with_test_env(Some("  Admin@Example.COM "), || {
            let config = Config::from_env()?;
            assert_eq!(
                config.initial_admin_email.as_deref(),
                Some("admin@example.com")
            );
            Ok(())
        });
    }

    #[test]
    fn configuration_status_reports_what_is_configured() {
        let mut config = Config::for_tests();

        // Stripe is all-or-nothing: some but not all is a misconfiguration.
        assert_eq!(config.billing_status(), "inert");
        config.stripe_secret_key = Some("sk_test".to_string());
        config.stripe_webhook_secret = Some("whsec".to_string());
        config.stripe_portal_return_url = Some("https://example.test".to_string());
        config.stripe_price_monthly = Some("price_m".to_string());
        config.stripe_price_yearly = Some("price_y".to_string());
        assert_eq!(config.billing_status(), "configured");
        config.stripe_price_yearly = None;
        assert_eq!(config.billing_status(), "partial");
    }

    #[test]
    fn mail_status_follows_the_same_rule_as_mail_configured() {
        let mut config = Config::for_tests();
        assert_eq!(config.mail_status(), "configured");
        config.smtp_host = String::new();
        assert_eq!(config.mail_status(), "missing");
        assert!(!config.mail_configured());
    }

    #[test]
    fn passkey_status_says_whether_the_rp_id_was_chosen_or_defaulted() {
        let mut config = Config::for_tests();
        config.webauthn_rp_id = "app.example.test".to_string();
        config.web_base_url = "https://app.example.test".to_string();
        assert_eq!(config.passkey_status(), "defaulted");
        config.webauthn_rp_id = "example.test".to_string();
        assert_eq!(config.passkey_status(), "configured");
    }

    #[test]
    fn backup_status_distinguishes_off_site_from_local_only() {
        let mut config = Config::for_tests();
        assert_eq!(config.backup_status(), "local_only");
        config.backup_s3_bucket = Some("bucket".to_string());
        assert_eq!(config.backup_status(), "configured");
    }
}
