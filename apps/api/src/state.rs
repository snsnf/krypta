use std::sync::Arc;

use redis::aio::ConnectionManager;
use sqlx::PgPool;
use webauthn_rs::Webauthn;

use crate::attachments::storage::Storage;
use crate::config::Config;
use crate::mail::Mailer;

/// What every handler is handed: the live connections, and the configuration
/// behind them.
///
/// This used to be twenty-four fields, most of them scalars copied one by one
/// out of `Config` at startup. That made it a bag rather than a module: adding
/// a setting meant editing the struct, the startup construction and both test
/// fixtures, which each spelled every field out, and which is what made adding
/// any new test to this crate expensive. Two of those fields were not even
/// copies with a purpose: `trusted_proxies` was `config.trusted_proxy_cidrs`
/// under another name, and `mail_configured` was a question `Config` can
/// answer about itself.
///
/// So the handles live here and everything else is read through `config`.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: ConnectionManager,
    pub storage: Storage,
    pub mailer: Mailer,
    /// The WebAuthn relying party configuration, used by `passkey_routes` to
    /// run registration and login ceremonies.
    pub webauthn: Arc<Webauthn>,
    /// Present only when every Stripe setting is configured. `None` means
    /// billing does not exist for this instance: the `/api/v1/billing/*`
    /// routes are never mounted, and quota resolution skips the plan layer.
    pub stripe: Option<Arc<crate::billing::stripe::StripeContext>>,
    pub config: Arc<Config>,
    /// The cached answer for `/api/v1/health`, the public readiness probe.
    pub readiness: crate::health::readiness::ReadinessCache,
    /// The current addresses of `config.trusted_proxy_hosts`. Runtime data
    /// kept fresh by a resolver task, not a copy of a setting.
    pub trusted_proxy_addresses: crate::client_ip::TrustedProxyAddresses,
}

impl AppState {
    /// Whether this instance bills, which is exactly whether Stripe is
    /// configured.
    ///
    /// The single definition, so the several call sites that hand this to
    /// `admin::settings`'s limit resolvers cannot each decide it differently.
    /// Getting it wrong in either direction is a quota bug: `true` on a
    /// self-hosted instance imposes the hosted free tier's limits on it, and
    /// `false` on the hosted instance gives every account the instance
    /// default regardless of what it pays.
    pub fn billing_enabled(&self) -> bool {
        self.stripe.is_some()
    }
}

#[cfg(test)]
impl AppState {
    /// The one place a test builds an `AppState`.
    ///
    /// Two modules used to carry near-identical copies of this, each listing
    /// every field, so a new setting broke both and a test that wanted a
    /// slightly different one had a third copy to write. The mailer is a
    /// parameter because it is the only part tests genuinely vary: some need
    /// `Mailer::capture()` to assert on delivery and some need
    /// `Mailer::failing()` to drive the retry paths.
    pub(crate) async fn for_tests(mailer: Mailer) -> Self {
        dotenvy::dotenv().ok();
        let db = crate::test_db::pool().await;
        let redis_client = redis::Client::open(std::env::var("REDIS_URL").unwrap()).unwrap();
        let redis_config = redis::aio::ConnectionManagerConfig::new()
            .set_max_delay(500)
            .set_number_of_retries(10)
            .set_connection_timeout(std::time::Duration::from_secs(2))
            .set_response_timeout(std::time::Duration::from_secs(2));
        let redis = redis::aio::ConnectionManager::new_with_config(redis_client, redis_config)
            .await
            .unwrap();
        let storage = Storage::new(
            "http://localhost:3900".to_string(),
            "garage".to_string(),
            "test-access-key".to_string(),
            "test-secret-key".to_string(),
            "krypta".to_string(),
            30,
        )
        .unwrap();
        Self {
            db,
            redis,
            storage,
            mailer,
            webauthn: crate::passkey::build("localhost", "http://localhost:3000").unwrap(),
            stripe: None,
            config: Arc::new(Config::for_tests()),
            readiness: crate::health::readiness::ReadinessCache::new(),
            trusted_proxy_addresses: crate::client_ip::TrustedProxyAddresses::default(),
        }
    }

    /// The same state with one or two settings changed.
    ///
    /// The config is shared, so a test cannot reach in and assign to a field
    /// the way it could when every setting was its own `AppState` field. That
    /// is the point: a setting has one owner now. A test that genuinely needs
    /// a different value says so here, which also reads as the deliberate act
    /// it is rather than as an assignment lost among the setup.
    pub(crate) fn with_config(mut self, edit: impl FnOnce(&mut Config)) -> Self {
        let mut config = (*self.config).clone();
        edit(&mut config);
        self.config = Arc::new(config);
        self
    }
}
