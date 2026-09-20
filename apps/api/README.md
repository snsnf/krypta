# krypta API

The Rust and Axum service behind krypta. It authenticates people, authorizes
access, enforces limits, sends mail and stores data. It never decrypts
anything, because it holds no key that could.

Start here: the repository root `README.md` explains what krypta is and how to
run the whole thing locally. This file covers the API on its own.

## Running it

```bash
cp .env.example .env    # first time only
cargo run               # http://localhost:8080, runs migrations on start
```

`.env.example` already points at the services in
`infra/docker/docker-compose.dev.yml`. The one thing you have to fill in is the
Garage key pair, in `S3_ACCESS_KEY` and `S3_SECRET_KEY`; the root README's
setup section prints them for you.

If port 8080 is already taken:

```bash
PORT=8089 cargo run
```

## What is where

```
src/auth          Registration, login, sessions, TOTP, passkeys, recovery.
src/forms         Form CRUD, public submission, limits, notifications.
src/sharing       Invitations, membership, grants, account sharing keys.
src/attachments   Encrypted file storage and its cleanup sweep.
src/admin         Instance settings, accounts, audit log.
src/billing       Stripe. Inert, and unrouted, without Stripe configuration.
src/health        Liveness, readiness and the admin health report.
src/config.rs     Every setting, with its production default.
migrations/       Numbered SQL, applied in order on start.
tests/            Integration suites. They talk to a running API.
```

## Database access

Every query is parameterized SQL through SQLx, and nearly all of them use the
compile-time checked macros (`query!`, `query_as!`, `query_scalar!`). The few
runtime `sqlx::query(...)` calls bind their values the same way. There is no
ORM and no string-built SQL, ever.

That checking needs either a live database or the checked-in metadata in
`.sqlx/`. After changing any query or adding a migration, regenerate it:

```bash
cargo sqlx prepare -- --all-targets
```

The `--all-targets` part matters. Without it, queries that appear only in test
files are left out and the offline build used by the Docker image fails.

## Tests

Unit tests run on their own. Integration suites need the dev stack up and the
API running, because they talk to it over HTTP.

```bash
cargo test                                        # unit tests
cargo test --test auth_test                       # one integration suite
cargo test --test totp_test -- --test-threads=1   # slow: waits out a TOTP step
cargo test --test email_verify_test               # reads codes back from Mailpit
cargo test --test sharing_test -- --test-threads=1
cargo test --test billing_test                    # needs Stripe configured
```

Two things worth knowing before you conclude something is broken.

**Rate limits are real in development.** About three full runs back to back
exhaust them, and the failure looks like something else entirely: registration
returns 429, so no session cookie is set, and the test fails at a later step.
The root README has the command that clears them.

**Some suites assert over the whole table.** They count admins, or forms with
no owner, across the entire database. If you have created real accounts in your
dev database, for instance by making yourself an instance administrator, those
assertions will fail locally while passing in CI, which starts from an empty
database.

## Before you commit

```bash
cargo fmt
cargo clippy -- -D warnings
```

Formatting is a gate in CI, and it is the check most often forgotten after
pasting code in.
