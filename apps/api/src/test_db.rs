//! The database the unit tests run against.
//!
//! They used to open `DATABASE_URL` directly, which on a dev machine is the
//! database the running API is serving. That made every test a race with a
//! live process: the attachment reaper sweeps `cleanup_pending` rows every
//! minute, and a test asserting on exactly that state lost whenever a tick
//! landed inside its window. Nothing about the test was wrong, and nothing
//! in the test could fix it.
//!
//! So the tests get a database of their own, `krypta_test`, on the same
//! server `DATABASE_URL` names. It is derived rather than configured: one
//! rule, no second variable to keep in step, and an existing `.env` needs no
//! edit. It is created if missing and migrated to the current schema, once
//! per test process; the migrator takes an advisory lock, so parallel test
//! binaries are safe too. It is then seeded exactly as boot seeds a fresh
//! database, because `instance_settings` is written by the server on start
//! rather than by a migration, and the limit resolvers read that row.
//!
//! The integration suites in `tests/` are unaffected and still use
//! `DATABASE_URL`: they go through the running API, so they must see the
//! database that API is using.

use sqlx::migrate::MigrateDatabase;
use sqlx::postgres::PgConnectOptions;
use sqlx::{ConnectOptions, PgPool};
use tokio::sync::OnceCell;

const TEST_DATABASE: &str = "krypta_test";

static READY: OnceCell<PgConnectOptions> = OnceCell::const_new();

/// Connection options for the test database, after it exists and is
/// migrated. Reading them in a `OnceCell` means the create-and-migrate step
/// runs once no matter how many tests ask.
pub(crate) async fn options() -> PgConnectOptions {
    READY
        .get_or_init(|| async {
            dotenvy::dotenv().ok();
            let dev_url = std::env::var("DATABASE_URL")
                .expect("DATABASE_URL names the Postgres server the unit tests derive theirs from");
            let options: PgConnectOptions = dev_url
                .parse::<PgConnectOptions>()
                .expect("DATABASE_URL is a Postgres URL")
                .database(TEST_DATABASE);
            let url = options.to_url_lossy().to_string();
            if !sqlx::Postgres::database_exists(&url).await.unwrap() {
                sqlx::Postgres::create_database(&url).await.unwrap();
            }
            let pool = PgPool::connect_with(options.clone()).await.unwrap();
            sqlx::migrate!("./migrations").run(&pool).await.unwrap();
            let mut connection = pool.acquire().await.unwrap();
            crate::seed_instance_settings(&mut connection, &crate::config::Config::for_tests())
                .await
                .unwrap();
            drop(connection);
            pool.close().await;
            options
        })
        .await
        .clone()
}

/// A pool on the test database. The one thing a database-backed unit test
/// should call to get one.
pub(crate) async fn pool() -> PgPool {
    PgPool::connect_with(options().await).await.unwrap()
}
