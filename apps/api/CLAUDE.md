# apps/api

Rust + Axum. Guidance here covers **working in this directory**. The design this
service must not violate (the zero-knowledge boundary, the account key
hierarchy, sealing, sessions, password reset, the non-negotiable rules) lives
in the root `CLAUDE.md` and applies here too.

## Run `cargo fmt` after every Rust edit, before committing

`scripts/ci.sh` gates on `cargo fmt --check`, so unformatted code fails CI even
when it compiles and passes clippy and every test. Just run it. It reformats
in place and never needs a decision:

```bash
cargo fmt
```

This is called out separately from the command list below because it has broken
the gate twice, both times the same way: an implementer transcribed a Rust
block from a plan document, plan text is not rustfmt-clean, and nothing in the
per-task checks caught it because clippy and the test suites were all green.
**Code pasted from a plan, a spec, or a review comment is exactly the code most
likely to need formatting**, and it is the code least likely to get it.

## Database migrations and SQLx offline metadata

The API uses SQLx migrations (`sqlx::migrate!("./migrations")`) tracked in
`_sqlx_migrations`; there is no ORM. The checked-in `apps/api/.sqlx/` JSON files
are generated metadata for every compile-time SQLx query and are required for
`SQLX_OFFLINE=true` Docker/CI builds.

After changing a `query!` or `query_as!`, regenerate metadata against the
current schema and verify the offline build:

```bash
cargo sqlx prepare -- --all-targets
SQLX_OFFLINE=true cargo check --bin api
```

The `-- --all-targets` is required in this repo: without it, queries that live
in test targets are left out of the metadata and the offline build fails
somewhere unrelated to what you changed.

Apply migrations with the CLI rather than by starting and interrupting the
server:

```bash
set -a && source .env && set +a
cargo sqlx migrate run --source ./migrations
```

Migration `0010_retire_legacy_form_ownership.sql` is intentionally guarded: it
backfills missing Owner memberships only when the legacy owner and wrapped keys
are still recoverable, aborts before destructive DDL if any form remains
without exactly one Owner, changes member-user deletion to `RESTRICT`, and only
then removes the legacy form ownership columns. Never bypass that guard or
manually delete membership rows to make a migration pass.

## Integration test idiom

Tests in `tests/` share `tests/common/mod.rs`. **There is no `TestClient`**:
several plans have been written against one that does not exist. Drive the API
with `reqwest` against a running server:

```rust
mod common;

use reqwest::Client;
use serde_json::json;
use sqlx::PgPool;

#[tokio::test]
async fn some_behavior() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("test-{}@example.com", uuid::Uuid::now_v7());
    // ...
}
```

A client built with `cookie_store(true)` carries the session automatically:
that is how "with this session" is expressed. To exercise a *specific* token
instead, build a second client and set the `__Host-session` cookie on it.

Helpers to reuse rather than reinvent: `common::base_url()`,
`common::latest_code_for(email)` (the mailpit reader; this is the real name),
`common::register_test_account(...)`, `common::pending_record(token)`, and
`common::reauthentication_receipt(base, client, common::TEST_PASSWORD)`, which
enrolling TOTP or a passkey now requires. Point a suite at an API on another
port with `TEST_API_BASE` (every suite's base URL reads it, defaulting to
`http://localhost:8080`). For
database assertions, follow the file-local `async fn test_db() -> PgPool`
pattern in `auth_test.rs`.

One quirk worth knowing: `sharing_test.rs`'s
`every_live_form_has_exactly_one_owner_membership` reads `DATABASE_URL`
directly instead of going through `test_db()`, so it skips `dotenvy` and fails
with `NotPresent` unless the variable is exported into the shell. That is a
local artifact, not a regression.

## `env -u` cannot disprove a setting here, and this will waste your afternoon

`main` calls `dotenvy::dotenv()` at startup, and `dotenvy` sets every variable
from `apps/api/.env` that the process environment does not already have. So
`env -u SOME_VAR cargo run` appears to work and then silently gets the value
back from the file: removing a variable is exactly the case the file fills
in. Two separate probes in one session concluded a feature was enabled when
it was not, on this exact mechanism. `Config::from_env` itself no longer reads
the file, so unit tests that set or remove a variable test what they set; the
trap is running the binary.

To genuinely run without a setting, run the binary from a directory that
contains no `.env`:

```bash
cd /tmp && set -a && source /path/to/apps/api/.env && set +a \
  && env -u STRIPE_SECRET_KEY /path/to/apps/api/target/debug/api
```

For the `STRIPE_*` settings specifically there is a second route, added because
this trap made an admin test impossible to write: an empty value counts as
unset, so `STRIPE_SECRET_KEY=` in `.env` disables billing.

## Billing needs Stripe configured, and the rest of the suite prefers it absent

`billing_test` requires an API with all five `STRIPE_*` settings; dummy
values are enough, since no test makes an outbound call and the webhook secret
is only ever used as HMAC key bytes. The test process needs the same
`STRIPE_WEBHOOK_SECRET` as that server, to sign its payloads. Without the
settings the routes are not mounted and every test 404s. `ci.sh` handles this
by starting a second API on 8081 with dummy Stripe values in its environment
and running the suite with `TEST_API_BASE=http://localhost:8081`.

The reverse is also true and less obvious. With billing enabled, plan limits
apply, and the free plan allows ten open forms. The Playwright suite shares one
account per worker and creates more than that, so `full-flow.spec.ts` fails
against a locally Stripe-configured API. `ci.sh integration` refuses to run
when `apps/api/.env` has `STRIPE_SECRET_KEY` set, for this reason.

## Which browser origins may call this API

`WEB_BASE_URL` is the allowed origin, not a literal in `main.rs`. It was a
literal, `http://localhost:3000`, while that setting already held the same fact
and was used to build links in mail: two sources for one value where only one
was configurable. A deployment on its own domain would have mailed correct
links and then blocked every request from the site those links lead to.

`CORS_ALLOWED_ORIGINS` adds more, comma separated, and is empty by default.
It exists for development, where a phone reaching the dev server needs the
machine's LAN address allowed alongside localhost. `WEB_BASE_URL` is always
allowed even when omitted from that list, so the deployment cannot lock itself
out.

Keep this an explicit allowlist. Credentials are enabled, so reflecting back
whatever `Origin` arrives would let any site a logged-in user visits call this
API as them.

## The images are built and booted on every commit

`scripts/ci.sh images` (`bun run ci:images`) builds both Dockerfiles, boots
each image, polls it, and runs the production compose file's API and web
healthchecks inside them; the workflow runs it as its own job. Traefik's own
ping check is not exercised by any gate. That exists because a build
alone is not enough: the deployed API once emitted zero log lines, including
the line on boot naming the address it bound, because `tracing_subscriber`
reads `RUST_LOG` and nothing set it. A container that had failed to reach
Postgres and one serving traffic looked identical from outside. The binary
defaults to `info` now, and the boot step is what would catch the next
silence of that kind.

`infra/docker/docker-compose.yml`, the one-command smoke stack, is still not
exercised by any gate. Run it yourself after anything that touches a
Dockerfile, a dependency with a native component, or a migration:

```bash
docker compose -f infra/docker/docker-compose.dev.yml down   # ports collide
set -a && . ./apps/api/.env && set +a                        # S3 keys
docker compose -f infra/docker/docker-compose.yml up -d --build --wait
```

Both stacks bind 5433, 6379, 3900, 8025, 8080 and 3000, so the dev one has to be
down, along with any native `cargo run` or `bun run dev`. The smoke stack
keeps its own volumes, so its Postgres starts empty and migrates on boot, and
its Garage needs the same one-time bucket bootstrap the dev stack did. Rate
limits there are production values, so the e2e suite exhausts registration
within a few tests. Run a single spec against it rather than the suite.

## Argon2 is optimised even in dev and test builds

`apps/api/Cargo.toml` carries a package override:

```toml
[profile.dev.package.argon2]
opt-level = 3
```

Do not remove it, and do not "simplify" it into a whole-profile setting.

Argon2id runs on both sides of every registration and login: the API hashes
the verifier (19 MiB, two passes, pinned in `src/password.rs`), and the suites
derive the verifier per fresh address the way the browser does, at 256 MiB and
three passes (`auth_verifier` in `tests/common/mod.rs`). At `opt-level = 0` that cost is
paid roughly ten times over. Measured on this suite, single-threaded:

| suite | opt-level 0 | opt-level 3 |
|---|---|---|
| `email_verify_test` | 76.3s | 8.2s |
| `recovery_test` | 40.3s | 13.2s |
| `auth_test` | 14.4s | 6.4s |

`email_verify_test` is the worst case because every test registers a fresh
UUID address, so `auth_verifier`'s memoisation cache never hits: eighteen
unoptimised 256 MiB derivations, which is what pins a core and churns memory.

**This changes no parameter and weakens nothing.** Same algorithm, same
memory and time cost, same output; only the compiler's optimisation level for
that one crate. Release builds were always optimised, so production is
unaffected. The rest of the crate stays unoptimised and debuggable.

## The unit tests and the environment

`bun run ci:static` should pass on any dev machine with the stack up. It used
to exit 1 wherever `apps/api/.env` set `KRYPTA_INITIAL_ADMIN_EMAIL`, because
`config::tests::initial_admin_email_is_none_when_unset` removed the variable
and `Config::from_env` then called `dotenvy::dotenv()` itself, re-reading the
file and putting the value straight back. The fix was ownership, not the
test: `main` loads `.env` once and `from_env` reads only the process
environment, so a test that sets the environment is testing exactly what it
set. Keep it that way; a `dotenv()` call inside `from_env` reintroduces the
failure on every machine with that key set.

The unit tests do not run against the API's database. `src/test_db.rs`
derives `krypta_test` from `DATABASE_URL` (same server, that database name),
creates it if missing, migrates it and seeds `instance_settings` the way boot
does, once per test process. Every database-backed unit test gets its pool
from there. Before this, they opened `DATABASE_URL` directly, which on a dev
machine is the database the running API serves, and one test raced the
server's attachment reaper: it asserted an attachment was still
`cleanup_pending` while the reaper swept exactly that state every minute. The
test was right and could not be fixed from inside the test. The integration
suites in `tests/` still use `DATABASE_URL`, deliberately: they go through
the running API and must see what it sees. Wiping the dev stack with
`down -v` removes the test database too, and the next run recreates it.

`with_test_env` restores the environment through a `Drop` guard, so a
panicking test still puts it back, and `env_lock()` recovers from poisoning
with `into_inner()` (it guards process environment variables, not invariant
state). Without both, one failing test used to leave a stray `DATABASE_URL`
behind and take every later database test in the binary down with it.

One consequence to keep in mind when adding tests: many modules in the
`--bin api` binary have database-touching tests now, and some of them
(`forms::notifications`, the attachment cleanup) sweep whole tables. `scripts/ci.sh` runs
the unit gate with `-- --test-threads=1` for that reason. If you add more
tests that touch the database from this binary, do not remove that flag.

## `attachments_test` needs the short windows in `.env.example`

It needs `KRYPTA_ATTACHMENT_TEST_HOOKS=1` (enables the
`x-krypta-test-pause-upload` header one test uses to observe an in-flight
upload) and short `S3_OPERATION_TIMEOUT_SECONDS`,
`ATTACHMENT_UPLOAD_STALE_SECONDS` and `ATTACHMENT_CLEANUP_INTERVAL_SECONDS`
values, because the production defaults are far longer than a test's
few-second poll window. `.env.example` carries all four, and CI uses that
file unchanged. A `.env` copied before they moved there produces two failures
that look like product bugs and are not; `scripts/ci.sh integration` checks
for the hook first and says so. The count is
timing-dependent: a third test, `deleting_a_response_reaches_the_reconciler_and_removes_the_attachment`,
joins them when the sweep does not run inside its polling window.

## Commands

```bash
cp .env.example .env    # first time only
cargo run               # localhost:8080, runs migrations automatically
# If 8080 is already taken by another API process:
PORT=8089 cargo run

cargo test --bin api -- --test-threads=1           # unit tests (plain `cargo test` also runs every integration suite)
cargo test --test auth_test -- --test-threads=1    # integration suites need the API running
cargo test --test totp_test -- --test-threads=1    # ~30s: waits out a TOTP step
cargo test --test email_verify_test -- --test-threads=1   # mailpit must be running
cargo test --test billing_test -- --test-threads=1        # needs Stripe configured, see above

cargo fmt && cargo clippy --all-targets -- -D warnings
```

Clear the rate limiters before any integration run: see the root `CLAUDE.md`
for why an exhausted cap produces a failure that looks like something else
entirely.

# Design notes for the API

The sections below are the design of individual API subsystems: what each one
guarantees and what a future edit would break by accident. They moved here
from the root `CLAUDE.md`, which keeps the rules and the cross-cutting design
(key hierarchy, sealing, padding) that everything below rests on. Read the root
first; references below to "Sealing to a public key", "The account key
hierarchy" or the numbered rules mean its sections.

## Response notifications and form limits

What follows is what a future edit would break by accident.

**Notifications**: `form_members.notify_on_response`, swept by
`apps/api/src/forms/notifications.rs`.

- The email carries a count and a `/dashboard/<formId>` link, never a title:
  `forms.title_ciphertext` is encrypted and the API holds no key. Do not add a
  plaintext title column to improve the subject line.
- One email per member per `RESPONSE_NOTIFY_COOLDOWN_SECONDS` (3600), rechecked
  under the claim lock. `submit_response` is anonymous and rate limited at
  100 per form per minute (and 20 per source per form beneath that), so
  per-response mail would make any public link an amplifier. A per-day cap instead turns a flood into a silent miss.
- The count runs against `COALESCE(last_notified_at, form_members.created_at)`,
  so a new collaborator is not mailed about history. Candidates are filtered by
  `EXISTS`, never by stamping the zero-count path. Stamping would run the
  cooldown from the last *sweep*, delaying a form's first notification by an
  hour.
- The watermark is stamped to `max(created_at)` of the rows counted, not
  `now()` (transaction-start time in PostgreSQL). This narrows the
  commit-ordering race; it does not close it.
- Migration `0017` seeds the watermark for rows `0016` enabled, or the first
  sweep after deploy mails every owner their entire history. Any future
  migration enabling notifications for a set of rows must seed it too; as must
  any endpoint: `set_notification_preference` and `transfer_ownership`'s
  promotion both stamp `now()` when switching the flag on. Demotion
  deliberately does not clear it.
- Delivery is at-least-once: a failed send rolls back and retries, so a crash
  between send and commit repeats an email. Bounded by
  `MAIL_SEND_TIMEOUT_SECS` (20s) because the row is locked across it.
  A failure no longer returns the member to the queue head: `0021` added
  `notify_failure_count` and `notify_retry_after`, the delay doubles per
  consecutive failure to a one-day cap, and the candidate query skips a member
  until its retry is due. That last part is what actually fixes the starvation,
  because a backing-off member stops consuming a slot in the `LIMIT 200`.
  Two things about it are easy to get backwards. **The increment must stay
  OUTSIDE `notify_member`'s transaction** and the reset INSIDE it: that
  transaction rolls back on a failed send, which is what preserves the retry,
  so an increment written there would roll back too and sit at zero forever.
  And **nothing here gives up on a member.** `notify_retry_after` only defers.
  Dropping a recipient after N failures would trade this bug for the dropped
  notification the whole feature exists to prevent.
- The preference is per-person and server-readable, so it is **not** in
  `FormSettings` (encrypted, shared, unreadable). Its toggle is ungated while
  `FormSettingsPanel`'s other cards sit behind `canEdit`. A Viewer's Settings
  tab holds exactly this one card.

**Limits**: `forms.closes_at` and `forms.max_responses`, nullable plaintext
(migration `0018`).

- Plaintext deliberately: a limit the server cannot read is one it cannot
  enforce. This exposes metadata of the same kind `accepting_responses` already
  is; no form or response content becomes readable.
- The cap is counted inside `submit_response`'s transaction, **after
  `FOR UPDATE OF forms, owner_user`** (why `owner_user` is there is under
  Billing). Counting before the lock lets two racing requests both pass and a
  cap of 100 admit 101. The count is what the form currently
  holds, so deleting responses can reopen it, which owners can now do from
  the Responses tab, not only by editing the database.
- **The count carries its provenance.** `ResponseCount` has one public
  constructor, `reported`, for counts that may be stale and never enforce a
  cap; the only other source is `count_responses_under_lock`, which takes the
  transaction so the count and the lock cannot drift apart. `submit_response`,
  `update_form` and both attachment sites use it. The cheap early-out,
  `form_is_provisionally_open`, takes no count at all, so it answers a strictly
  weaker question and cannot admit a response; anything it lets through still
  has to satisfy `form_is_open`.
- `form_is_open` is the single definition of "open" and every gate calls it:
  `submit_response`, `get_form_public`, both attachment-upload sites, and
  `update_form`, which compares the form before and after the edit and, when
  the edit turns a closed form open, refuses it with `check_reopen_allowed` if
  the owner is at the open-form limit. Deleting responses below a cap can still
  reopen a form without that check, deliberately: refusing a deletion would
  trap the owner's data.
  The attachment sites originally checked the raw column, which let a
  respondent upload files to a closed form. `get_form_public` returns the
  computed value as `accepting_responses` so a respondent never learns which
  limit stopped them; `get_form` returns the raw column because the owner's
  toggle must show the real setting. Do not "make them consistent".
- `update_form` uses `CASE WHEN $n THEN … ELSE column END`, not `COALESCE`,
  because a null parameter must mean "clear". Request fields are
  `Option<Option<T>>` via the `present` helpers.
- **Format `closes_at` as RFC3339 explicitly.** `time`'s default `Serialize`
  emits a numeric array and `serde-well-known` does not change that. This
  shipped broken once: the owner's close date read back as `Invalid Date` and
  the field rendered blank on a silently-closed form. `forms.created_at` still
  has this latent shape.
- The **confirmation message** is the counterexample: user-authored content, so
  it lives encrypted in `FormSettings`. Blank normalizes to `undefined`.
- **One response per person cannot be enforced server-side** while submission is
  anonymous. `allowMultipleResponses` stays a browser `localStorage` flag. Do
  not "fix" it with fingerprinting, a required email, or an IP record.

## Billing

What follows is what a future edit would break by accident.

Migration `0022` adds `plans` (seeded `free` and `pro`), `subscriptions`,
`response_usage`, and `processed_stripe_events`; `0023` adds
`response_usage.warned_at`. Free is 10 open forms, 200 MB of attachment
storage, and 250 responses per month. Pro is $12/month or $120/year, 5 GB of
storage, and 1,000 open forms and 100,000 responses per month as fair-use
ceilings rather than product limits: nobody in this market meters form count
on a paid plan, so the number exists only to bound abuse, not to be reached
honestly. `apps/api/src/billing/{quota,routes,stripe}.rs` is the
implementation; `async-stripe` and `async-stripe-webhook` are pinned at
`=1.0.0-rc.8` (no caret, same reasoning as the ML-KEM pin in root rule 2: a crate this
close to the payment surface must not float). The 0.4x line looks more stable
by version number but is abandoned: it pins `hyper 0.14` and `rustls 0.21`,
past end of life, and fails `cargo audit` on four advisories, three of them
certificate validation flaws in the stack that talks to Stripe. The release
candidate uses `hyper 1.5` and audits clean. Maintained beats stable when the
two disagree.

**Billing is inert without Stripe configuration, and that is a different kind
of absence than `WEBAUTHN_RP_ID`.** `Config` gains five optional settings,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_RETURN_URL`,
`STRIPE_PRICE_MONTHLY`, and `STRIPE_PRICE_YEARLY`. All five or none: some but
not all is logged as a misconfiguration and billing stays off.
Missing `WEBAUTHN_RP_ID` produces a feature that looks present but is silently
broken, which is why it is required. Missing Stripe configuration produces a
feature that is not there at all: the four `/api/v1/billing/*` routes are
never mounted, quota resolution skips the plan layer entirely, and no
Stripe client is ever constructed, so no outbound call is possible. That is a
coherent state for a self-hosted instance, not a misconfiguration, so it stays
optional.

**`AppState` carries the live connections and a shared `Config`, not a copy of
every setting.** Handlers read `state.config.X`; `AppState::for_tests` is the
one place a test builds a state, and `with_config` is how a test that needs a
different setting says so. The fields beside `config` are live handles or
runtime data (such as the resolved trusted-proxy addresses), never a copy of a
setting, which is what used to make adding a setting a four-place edit.

**`AppState::billing_enabled()` is the single definition of whether this
instance bills, and the limit resolvers take it as a required parameter.**
It is `self.stripe.is_some()` and nothing else. The parameter is required
rather than defaulted precisely because authorization-adjacent code is where a
missed conditional becomes a bug: a new call site cannot forget it, and the
single definition means no call site can compute it differently. Getting it
wrong is a quota bug in one of two directions, both silent: `true` on a
self-hosted instance imposes the hosted free tier's limits on it, and `false`
on the hosted instance hands every account the instance default regardless of
what it pays.

That gate shipped broken once: an ungated `plans` join always resolved,
because the seeded `free` row's limit columns are `NOT NULL`, so the
`instance_settings` layer beneath it was unreachable and every self-hosted
instance silently took the hosted free tier's limits. A `COALESCE`
fallthrough only reaches its next layer when the layer above it can be null.

**Limit resolution gained a third layer, in the middle.**
`max_forms_for_user`, `max_attachment_bytes_for_user`, and
`max_responses_for_user` in `apps/api/src/admin/settings.rs` resolve
`COALESCE(account_quotas.X, plans.X, instance_settings.default_X)`, with the
`plans` join gated on `billing_enabled`. The admin
override wins first so an account can be comped or restricted regardless of
what it pays; the plan resolves second so billing changes a limit without
touching the admin surface; the instance default is the floor, so an
unconfigured instance resolves exactly as it did before this feature existed.
A user with no `subscriptions` row resolves through `plans.id = 'free'` when
billing is on, and through the instance default when it is off.

The corollary, said plainly because it looks like a bug otherwise: when
billing IS enabled the plan layer always resolves, so the instance default is
unreachable for any account without an `account_quotas` override. That is the
ordering working as intended. The instance default is the floor for an
instance that does not bill.

**Migration `0024` gave the response allowance the two layers it was missing.**
Before it, `max_responses_for_user` read `plans` alone: no admin override and
no instance default, so this file's claim that all three resolvers share one
shape was false. It adds `account_quotas.max_responses` and
`instance_settings.default_max_responses_per_period`, both nullable, and
**null means no cap**. That is what restores pre-billing behaviour: responses
were never capped before this feature, so an instance with no Stripe and no
admin-set default must keep collecting without limit.
`max_responses_for_user` therefore returns `Option<i32>`, and
`response_allowance_exhausted` is the one place that decides what `None`
means, so no caller has to remember. The instance default is patchable through
`/api/v1/admin/settings`; the per-account override is readable there and set
directly in the database, exactly like `max_forms` and
`max_attachment_bytes`, neither of which has a write endpoint either.

**`POST /billing/checkout` refuses a second subscription.** Stripe permits a
customer to hold concurrent subscriptions, and `handle_checkout_completed`
upserts by `user_id`, so a caller who reached the endpoint directly while
already subscribed would be billed twice with the first subscription left
live and invisible to this app. A caller whose row is non-free and whose
status is neither `canceled` nor `incomplete_expired` gets a billing portal
URL back instead, in the same `{ url }` shape, so the browser redirects either
way. `past_due` counts as live here: it needs a working card, not a
duplicate. `billing::quota::subscription_is_live` is that one predicate.

**That check cannot see a checkout that has not been confirmed yet**, because
the row it reads is written only by the webhook. Every session opened before
the first `checkout.session.completed` used to pass it, so two clicks could
sell two subscriptions. `pending_checkouts` (migration `0030`) holds the one
session an account may have open: checkout locks that row, expires the
recorded session if it is still open, answers `checkout_in_progress` if it
has already been paid, and records the new one; the webhook deletes the row
when that same session completes. The lock is on this row and not on `users`
on purpose: `submit_response` locks the owner's `users` row, and a public
form must never wait on a call to Stripe (see the rule below). The Stripe calls on this path
cannot run in the suites, which make no outbound requests; the decision is a
pure function with a unit test, and the claim's release is covered through
the webhook.

**`max_forms` counts open forms with a live query, not a counter, and that
substitution was forced.** `account_usage.forms_used` still exists and
`reserve_form_slot`/`release_form_slot` still move it, but it counts total
forms and no longer enforces anything. A counter cannot express
"open": two of `form_is_open`'s three closure conditions, a `closes_at`
elapsing and a `max_responses` filling, happen with no code running at all,
so there is nothing to decrement when a form quietly closes itself. The
replacement, `quota::open_form_count`, is a SQL query over the owner's forms
that necessarily restates `form_is_open`'s logic, even though `form_is_open`
is named elsewhere in this file as the single definition of "open": it is
the one place that genuinely cannot call it, because `form_is_open` is Rust
taking a per-form response count and this has to be one query across every
form an owner has. The agreement test in `apps/api/src/billing/quota.rs`,
`the_sql_count_agrees_with_form_is_open_in_every_state`, builds a form in
each of the four states (accepting, manually closed, past `closes_at`, at
`max_responses`) and asserts the SQL count matches how many `form_is_open`
would call open. That test is what turns a future edit to either side into a
CI failure instead of a quietly wrong bill. Being over the limit blocks
creating or reopening a form; it never closes one, because deciding which
open forms to close would mean ranking data the server cannot read (titles,
questions, and responses are all ciphertext), and the response cap already
bounds a free account's volume without any such ranking.

**The webhook takes raw `axum::body::Bytes`, never a `Json` extractor.**
Stripe signs the exact bytes it sent; a `Json` extractor would parse and
re-serialize the body before `verify_webhook` ever saw it, so the signature
could never match against what was actually received. That produces a
handler that looks like it verifies the webhook and does not, which is worse
than no verification because it reads as done. `InvalidSignature` and
`Unparseable` are kept as two distinct outcomes for the same reason
`get_form_public` keeps its closed-form response uninformative: a bad
signature is rejected outright, but an unparseable or unrecognized event type
is acknowledged with a 2xx, because Stripe retries any non-2xx forever and an
event this crate version cannot parse would otherwise wedge the retry queue
permanently.

**The idempotency marker and the state change it guards share one
transaction.** `processed_stripe_events` is inserted, and the corresponding
`subscriptions` update runs, inside the same `Transaction`, so a handler
failure partway through rolls both back together. Committing the marker on
its own first, before the state change, would make delivery look
at-least-once while actually being at-most-once for the state that matters:
a transient database error after the marker commits would leave the event
permanently marked processed with its effect never applied, and Stripe would
never redeliver it because the marker already says done.

**Subscription events match on `stripe_subscription_id` as well as
`stripe_customer_id`, because one Stripe customer holds several subscriptions
over time.** Matching by customer alone had a concrete failure: cancel at
period end, resubscribe through Checkout (the row is upserted to the new
subscription, plan `pro`), and then the OLD subscription's
`customer.subscription.deleted` fires at the end of its paid period, matches
by customer, and sets `plan_id = 'free'` on someone who is currently paying.
Nothing corrects it, because `deleted` is terminal.
`handle_subscription_updated` had the mirror of it. Both predicates now read
`stripe_customer_id = $c AND (stripe_subscription_id IS NULL OR
stripe_subscription_id = $s)`; the null arm is the row
`handle_checkout_completed` writes when the Checkout Session carried no
subscription id yet.

**Stripe does not guarantee event order, and a zero-row match has two causes
that need opposite answers.** `unmatched_subscription_event` is the one place
that decides between them. If the row recorded for the customer is **live**
and holds a different subscription id, the event belongs to a subscription the
account has moved on from, so it is acknowledged and ignored: the stale id
never becomes current, so a retry would only fail again. Otherwise (no row at
all, or a row whose recorded subscription is finished) the event outran
`checkout.session.completed`, so it returns an error: the transaction and the
idempotency marker roll back together and Stripe's retry reprocesses it once
checkout has recorded the new id. The finished case matters because checkout
reuses a returning subscriber's customer: a plain existence check used to drop
their new subscription's events, including a terminal deletion.
`invoice.payment_failed` still matches on customer alone, deliberately: the
crate does not expose an invoice's subscription link plainly, and that handler
never touches `plan_id`, so the worst a stale invoice does is stamp `past_due`
on a current subscription, which the next `customer.subscription.updated`
corrects. `customer.subscription.deleted` is why the ordering case matters
most:
`deleted` is terminal, so a silent no-op on a missing row would mean nothing
ever corrects it, and the later-arriving `checkout.session.completed` would
then create the row fresh on an active paid plan, a phantom entitlement no
subsequent event ever revisits. An unmatched Stripe price in
`handle_subscription_updated` follows the same safe-direction rule: it leaves
`plan_id` unchanged rather than guessing, because once a second, cheaper tier
exists, defaulting an unrecognized price to `'pro'` would silently upgrade
that tier's subscribers. Entitlement bugs must undershoot, never overshoot.
**`plans.stripe_price_id_monthly` and `_yearly` are not populated by any
migration**; an operator sets them, and until they do, no subscription price
ever resolves back to a plan by that path. The design's line that adding a
tier is "just an INSERT" is not yet fully true because of this.

**Stripe is never called from a request path a respondent can reach.** The
local mirror (`subscriptions`, `response_usage`) is the sole source of truth
for every enforcement decision `submit_response` and `get_form_public` make.
Making a public submission depend on an outbound call to Stripe being
reachable would mean a Stripe outage decides whether anonymous forms accept
responses; nothing does.

**Ownership transfer enforces the same open-form ceiling form creation does.**
`transfer_form_usage` used to compare `account_usage.forms_used`, a count of
TOTAL forms, against `max_forms_for_user`, which since this feature returns an
OPEN-form ceiling. Two authorities for one limit, and the shared helper's
meaning had changed underneath the caller left behind. It counts
`quota::open_form_count` now. The transfer runs before the membership rows are
swapped, so the count excludes the form being handed over and `>=` is the
right comparison for admitting one more, exactly as on creation.

**The response allowance is enforced inside `submit_response`'s existing
transaction, after `FOR UPDATE OF forms, owner_user`, same as the per-form
cap migration `0018` already protects.** The account allowance is a per-user
total, not a per-form one, so the per-form row lock alone does not serialize
it: two submissions landing on two different forms owned by the same person
would lock two different `forms` rows and could both read the same total and
both pass. `owner_user` is in that lock list specifically because every form
a user owns joins to their one `users` row, which is what actually
serializes the account-wide count. Removing it from the lock list breaks only
the account check; the per-form cap keeps working, silently hiding the
regression. `get_form_public` folds the account allowance into the same
`accepting_responses` boolean it already computes for the per-form limits, so
a respondent who is blocked by the account cap sees the identical closed-form
page and never learns which limit stopped them or anything about the owner's
subscription.

**The usage period needs no reset job.** `response_usage`'s primary key is
`(user_id, period_start)`, where `period_start` is the first instant of the
current calendar month in UTC (`billing::quota::current_period_start`). A new month is a row that does not exist yet, and a missing
row reads as zero. Nothing has to run on a schedule to roll the period over,
so nothing can fail to run and leave last month's count still in force. The
period is independent of Stripe's own invoice period on purpose: an annual
subscriber still needs a monthly allowance, and a free account has no Stripe
subscription to derive a period from at all.

**Deleting a response does not refund the counter.** `response_usage` meters
what was received, not what is currently stored. Refunding on delete would
let a free account collect its 250, export them, delete them, and collect 250
more, indefinitely: the limit would be decorative rather than a real cap on
volume.

**Nothing is ever deleted on downgrade, whether from a failed payment or a
cancellation.** `handle_invoice_payment_failed` only moves `status` to
`past_due`; `plan_id` is left alone until Stripe reports the subscription
actually gone, and quota resolution keeps honouring it for `past_due`, so a
card that fails on Friday does not break someone's Saturday. Quota resolves
through the `entitled_plan_id` SQL function (migration `0029`), and the only
statuses it resolves to free are `incomplete` and `incomplete_expired`,
subscriptions nothing was ever collected for. `handle_checkout_completed`
records `incomplete` when Checkout finished before an asynchronous payment
settled, which used to hand over the paid plan for nothing. Do not widen that
list to `past_due` or `unpaid`. And even once a
subscription is confirmed gone, the design still never deletes stored
ciphertext: choosing what to remove would require ranking form titles,
responses, and filenames by importance, and all of it is ciphertext the
server cannot read. There is no rule to apply that isn't a guess against data
we cannot see, and guessing wrong is unrecoverable in a product with no
undelete. An account past its limits stops being able to add; it never stops
being able to read what it already has.

**An account that is still being billed cannot be deleted.** Admin deletion
cascades the `subscriptions` row away and has no way to cancel anything at
Stripe, so it used to leave a deleted account charging with nothing left to
cancel it from. `delete_account` now answers `active_subscription` (409)
while `billing::quota::subscription_is_live` holds, which is the same
predicate checkout uses to refuse a second subscription, so "still billing"
has one definition. `past_due` counts as live on purpose. The check applies
only where this instance bills: a row left from an earlier Stripe
configuration must not make an account undeletable forever. The account
holder cancels from the billing portal; no admin path cancels on their behalf.

## Where the sharing handlers live

`sharing/routes.rs` was 2096 lines holding five groups that shared a file
rather than an interface: they had no types, error modes or invariants in
common, only a helper and a base64 constant. It is now:

- `sharing/keys.rs`: the account sharing keypair. Not form sharing at all,
  routed under `/api/v1/account/sharing-key`, touching only `users`.
- `sharing/invitations.rs`: the invitation lifecycle and the recipient's side
  of accepting one. Two actors, kept together because they share the
  `form_invitations` state machine.
- `sharing/membership.rs`: who is on a form, in what role, with which keys.
- `sharing/access.rs`: deciding under a lock whether a caller owns a form. The
  one thing the other three need from each other, which is why they no longer
  need to share a file to share it.
- `sharing/continuation.rs`, `sharing/cleanup.rs`, `sharing/models.rs`: the
  invitation continuation cookie, the expiry sweep, and the shared types.
- `forms/lifecycle.rs`: ownership transfer and form deletion. Under `forms`
  deliberately: `main.rs` used to route `DELETE /forms/:id` into `sharing`
  while `GET` and `PATCH` went to `forms`, so a reader looking for form
  deletion started in the wrong file. Transfer is a proven seam rather than a
  hypothetical one, with two callers (the owner-facing route and the admin
  account-lifecycle path), which is why `prepare_` and `apply_` are split.

## Two kinds of form authorization, and why they are not one

`FormAccess` in `apps/api/src/form_access.rs` answers "may this caller touch
this form, and at what role". It always returns `NotFound` rather than
`Forbidden`, so no handler can accidentally leak that a form exists, and it
loads the caller's key material at the same time, so a handler that has
authorized has already fetched what it needs to reply.

It has two loaders, and the difference is load-bearing:

- `load` reads through the pool. Right for a handler that answers a question.
- `load_for_update` reads inside a transaction and holds the membership row
  `FOR UPDATE`. Required for a handler that decides a caller's rights and then
  writes on the strength of that decision, because `load`'s read would not see
  the transaction's locks and the membership could change in between.

**A third form exists and must not be "unified" with these.** Several UPDATE
statements carry their authorization as an `EXISTS (SELECT 1 FROM form_members
... role = 'owner' AND state = 'active')` clause welded into the writing
statement. That is stronger than either loader, not weaker: there is no window
between deciding and acting because they are one operation. Rewriting those
into a load-then-check would introduce exactly the race the clause exists to
prevent. `put_member_grant` has a second clause of the same kind binding the
grant to the precise sharing key the owner sealed to, so a recipient who
rotates their key mid-flight cannot be handed a grant sealed to a key they no
longer hold. The comments at those statements say so; keep them.

There is one definition of an active owner: `lock_and_require_owner_inner`
goes through `FormAccess::load_for_update`, and one function parses a stored
role. Do not reintroduce a local `role == "owner"` comparison.

## Two-factor authentication

Be clear about what it buys. It stops online account takeover: previously a
stolen password alone bought a session, and a session buys the ciphertext needed
to decrypt. It does **not** protect the data if the ciphertext leaks, since
someone holding a database dump plus the password decrypts offline with no
second factor involved. 2FA hardens the account, not the encryption.

TOTP only, and additive rather than a replacement for the password. That is the
whole reason it fits where SSO does not: the password still reaches the browser
and still derives the password unlock key, so the key hierarchy is untouched.

Login is two steps once a factor is enrolled. The password step returns
`{ totp_required, pending_token }` and **nothing else**: no session cookie and
no `wrapped_account_key`. `POST /auth/2fa/verify` exchanges the handle plus a
code for the session and the wrapper. Anything that consumes the login response
has to handle both shapes; `apps/web/app/login/page.tsx` keeps the
password-derived unlock key in state across the two steps, because the account
key cannot be unwrapped until the second one returns the wrapper.

Three properties to preserve when touching `apps/api/src/totp.rs`:

- **Replay.** `check_current` returns the timestep, and that step is claimed
  with `SET NX`, so an observed code is dead for the rest of its 30 seconds.
  A consequence worth knowing before calling it a bug: enrolling and then
  logging in inside the same 30-second window is refused, because enrolment
  already spent that step. Tests that mean to exercise a valid login must cross
  the boundary first, which is what `code_from_next_step` in
  `tests/common/mod.rs` exists for.
- **Brute force.** Six digits fall quickly, so the pending handle is consumed on
  any attempt: a wrong code forces the password step again rather than allowing
  repeated guesses, and verify is rate limited by IP on top. Every code check
  is also capped per account, ten a minute under `totp_attempts:<user_id>`,
  by `check_totp_attempt_rate_limit` in `apps/api/src/auth/routes.rs`. The
  per-IP limit alone was not enough: disabling 2FA from a stolen session and
  the TOTP step of vault recovery both accepted unmetered guesses from a caller
  rotating addresses, and a six-digit code with a skew of one falls to that in
  hours. The check runs before the code is verified, so it meters successes as
  well as failures, and it sits inside `verify_totp_or_recovery` so a new
  caller of that function cannot forget it. `totp_enable` is the one path that
  bypasses that function and calls the limiter itself.
- **Enrolment takes the password, not only a session.** `totp_enable` consumes
  a reauthentication receipt from `/auth/reauthenticate`
  (`require_reauthentication` in `apps/api/src/admin/account_lifecycle.rs`).
  From a stolen session alone, enrolling a factor would lock the real owner out
  at their next login. Setup stays session-only because it stores an inactive
  secret; the gate sits where the factor takes effect.
- **Recovery codes.** Eight, single use, Argon2 hashed so a database read yields
  nothing usable, marked `used_at` rather than deleted so a replay is
  distinguishable from an unknown code, and spent under a `used_at IS NULL`
  guard so racing requests cannot both claim one. They are accepted for
  disabling too, which is the case where the phone is gone.

The enrolment QR is rendered by the API as a data URI, so no QR library reaches
the browser and the secret is never laid out in the DOM to be scanned.

## Passkeys

What follows is what a future edit would break by accident.

A passkey is two independent things. Its key pair authenticates, replacing the
password and TOTP at login. Its PRF output derives a passkey unlock key
(`BLAKE2b-256(domain ‖ prf)`, one `crypto_generichash` call, no Argon2id: the
PRF output is already a uniform 256-bit secret, not a low-entropy human one, so
stretching it buys nothing) that wraps the account key, replacing the
password's Argon2id output. The server participates only in the first: it
never sees the PRF salt, the PRF output, or the passkey unlock key.

**No fallback for an authenticator without PRF.** Enrolment calls `create()`,
reads `getClientExtensionResults().prf`, and if `enabled !== true`, aborts and
tells the user plainly: the device cannot store an encryption key, nothing was
registered, and a stray unused entry may remain on the authenticator that only
they can remove. A passkey that authenticates but cannot unwrap the vault would
still land the user on `/unlock` to type the password, which saves nothing and
calls itself "passkey" dishonestly. This is revisitable, not accidental.

**Login is discoverable and usernameless, and that is a security decision, not
only a UX one.** An email-first flow needs an endpoint that accepts an address
and answers whether it has passkeys, which is the same account-enumeration
oracle migration `0015` removed when it dropped `users.master_key_salt`.
Discoverable login issues a challenge for nobody in particular, so no such
endpoint exists. The user is resolved from the WebAuthn user handle
(`users.id`, written onto the authenticator at registration and readable by
anyone holding the device: it is an opaque UUIDv7 that grants nothing, but it
is not secret), and the credential ID alongside it selects which stored
passkey to verify. `login/finish` returns one generic error for an unknown
credential and a bad signature alike; distinguishing them would restore the
oracle. A user whose passkey is gone gets no "not found" message, only the
password form.

**No TOTP after a passkey login.** A passkey assertion with
`userVerification: "required"` is possession of the device plus a biometric or
PIN, phishing-resistant in a way TOTP is not, and strictly stronger than
password plus TOTP. `login/finish` returns the session and the wrapper in one
response, a third shape alongside `totp_required` and the plain case. This is
also why the session flag that gates `/admin` was renamed from
`totp_verified` to `second_factor_verified` (with `#[serde(alias =
"totp_verified")]` so sessions already in Redis keep deserializing): a passkey
login satisfies the second-factor requirement, and leaving the field named
`totp_verified` would make it lie in the one place a misread grants
instance-admin access. The `/admin` guard (`apps/api/src/admin/guard.rs`)
still also requires TOTP to be enrolled on the account, so an admin needs TOTP
set up even if they sign in with a passkey.

**Adding a passkey takes the password, not only a session.**
`register_start` consumes a reauthentication receipt, for the same reason TOTP
enrolment does: a passkey is a standing way into the account and the vault.
The ceremony token it issues is bound to the user and consumed by
`register_finish`, so gating the start gates the whole ceremony.

**The RP ID is permanent.** `WEBAUTHN_RP_ID` is baked into every credential
enrolled against it; changing the domain dead-weights every passkey with no
migration and no recovery path short of re-enrolling. It sits in the same
category as the frozen domain strings in `account-key.ts`. Users are not
locked out when this happens, because the password wrapper still exists; only
the passkeys stop working.

**Recovery does not invalidate passkeys.** `/auth/recover/*` re-wraps the same
account key under a new password and new recovery code; it never touches
`passkey` wrappers, because they cover that same account key. A user who
recovers because their password leaked has not thereby revoked their devices.
Passkey removal is a separate, explicit action in settings.

**`passkey_credentials.credential` stores `webauthn_rs::prelude::Passkey`
serialized whole, not decomposed into columns.** This is forced, not chosen:
its fields are `pub(crate)` and the crate exposes no constructor from parts, so
a decomposed row could never be reassembled into what
`finish_discoverable_authentication` requires. The upside is that a crate
upgrade adding a field to `Passkey` needs no migration here. After every
successful login, `Passkey::update_credential` is called and the row rewritten
on change; skipping this freezes the signature counter and silently disables
the crate's cloned-authenticator detection.

**Five traps in `webauthn-rs` 0.5.5 itself, each of which cost real debugging.**
Read these before changing anything in `apps/api/src/passkey.rs`,
`apps/api/src/auth/passkey_routes.rs`, or `apps/web/lib/passkey.ts`.

- **`conditional-ui` is the feature that gates discoverable authentication**,
  not `resident-key-support`. `start_discoverable_authentication`,
  `finish_discoverable_authentication` and `impl From<&Passkey> for
  DiscoverableKey` all sit behind it, even though this project builds no
  autofill UI. `resident-key-support` gates attested resident-key
  registration, which is unused here. The name is misleading; the feature list
  in `Cargo.toml` is correct.
- **The crate hard-codes `mediation: "conditional"` onto every discoverable
  challenge.** The browser must therefore pass only `options.publicKey` to
  `navigator.credentials.get()`. Forwarding the whole options object, for
  instance by spreading it, silently turns the sign-in button into a no-op:
  conditional mediation renders no modal and does nothing without an
  `autocomplete="webauthn"` input. `apps/web/lib/passkey.ts` carries this
  warning at the call site; keep it there.
- **`AuthenticationExtensionsPRFOutputs.enabled` is reported only for
  `create()`, never for `get()`.** An assertion returns
  `{ prf: { results: { first } } }` with no `enabled` field at all. Gating an
  assertion's PRF read on it makes every passkey login fail with a misleading
  "this device cannot store an encryption key". This shipped as a bug during
  development and survived a green unit suite, because every test fed a
  creation-shaped object. `readPrfOutput` is deliberately assertion-safe and
  decides on `results.first` alone; `prfSupportFrom` keeps the `enabled` check
  because it only ever sees creation results. Do not re-unify them.
- **The client must set `residentKey: "required"` itself.** The server's
  `start_passkey_registration` calls `require_resident_key(false)`, which
  becomes `ResidentKeyRequirement::Discouraged`. Since discoverable login is
  the only login path, a non-discoverable credential would enrol successfully
  and then never appear at sign-in, with roaming security keys the clearest
  casualty. `enrollPasskey` sets it, merging into whatever the server sent.
- **`webauthn-rs` links native OpenSSL** through `webauthn-attestation-ca`, and
  it cannot be dropped by disabling the `attestation` feature: that feature
  gates code, not an optional dependency. The rest of this service uses rustls
  deliberately, so this is an exception forced by one dependency.
  `apps/api/Dockerfile` needs `pkg-config` and `libssl-dev` in the build stage
  and `libssl3` at runtime because of it. `scripts/ci.sh images` builds and
  boots the image, so a break there fails that job rather than a release.

## Mail language

Every mail constructor in `src/mail.rs` takes a `Language` (English or Arabic)
and renders both the text and the HTML in it, right to left with `dir` set for
Arabic. The language is plaintext on `users.language` (migration `0032`), set
at signup from the `language` the browser sent, carried through the pending
record so a resend matches, and changed by `PATCH /auth/language`. An unknown
code is English, never an error, except on that explicit PATCH. Pre-account
mails (signup, recovery) use the request's language; a recovery for an address
with an account uses the account's own. Mail to an invited address with no
account uses the inviter's language. The server-side template is the one place
Arabic text lives in Rust: a new mail needs both languages, and
`mail::tests` runs every invariant (no fetched resource, one link, the footer)
over both. The language is listed in `SECURITY.md`, `/privacy` and
`/security`, in both languages of each.

## Email verification

Signup is two steps. `POST /auth/register` creates nothing: it stores a
pending record in Redis (email, the Argon2 hash of the browser's auth verifier,
SHA-256 of a 6-digit code) under a 15-minute TTL, mails the code, and returns
`{ verification_required, pending_token }` with no cookie. `POST
/auth/verify-email` exchanges the handle plus the code, both account key
wrappers, and the recovery verifier for the `users` row and the session.
`apps/web/app/signup/page.tsx` holds the password-derived unlock key in state
across both steps, because the wrappers are only sent at the second one. It is
the same shape the login page uses for TOTP. The vault recovery code is generated
in that same second step and displayed once the account exists.

Five properties to preserve:

- **A `users` row means a verified address.** There is no `email_verified`
  column, deliberately: a boolean has to be checked in every query that
  excludes unverified accounts, and one forgotten `AND email_verified` lets
  them through. `email_verified_at` records when; the admin guard's
  `email_verified_at IS NOT NULL` is a belt-and-braces no-op, since the column
  is `NOT NULL`.
- **The duplicate case is indistinguishable.** Registering an address that
  already exists follows the same path, hashes the verifier anyway so the
  timing matches, and returns the same body, with a decoy record no code can
  redeem. Only the mail differs, and only the real owner sees it. Do not
  "improve" this into a helpful "you already have an account" error. Login
  holds the same line: an unknown address spends one Argon2 verification
  against a fixed dummy hash (`password::spend_verification_cost`, whose
  parameters a test pins to a real hash's), so the reply time does not reveal
  which addresses have accounts.
- **An address is keyed, stored and mailed in one canonical form.**
  `mail::canonical_address` accepts only a bare address that lettre prints back
  unchanged, lowercased; registration, recovery and invitations use it before
  any rate-limit key is built, because lettre delivers every decorated
  spelling to the same inbox and each spelling used to get its own counter.
  Registration refuses a padded address rather than trimming it, since the
  browser derived the account's salts from the string it holds; invitations
  trim first, since no key is derived from an invited address.
- **Resend does not extend the expiry.** The TTL is derived from the record's
  `expires_at` on every write, so a client cannot keep a password hash alive in
  Redis by resending. Attempts carry over across a resend too, or the attempt
  cap is bypassed by asking for a new code.
- **Pending transitions are atomic and verification is retryable.** Redis Lua
  transitions serialize wrong-code attempts and SMTP resend reservations while
  preserving the original TTL. A correct code becomes a receipt bound to the
  same token, code, and fixed UUIDv7, so a PostgreSQL, Redis, session, or response
  failure can be retried without allowing another pending signup to claim an
  existing user.
- **Nothing about this is recovery.** Email verifies an address. It cannot
  restore a vault; see "Password reset exists, and it requires the recovery code".

Integration and e2e suites read codes back from mailpit
(`http://localhost:8025`), which `docker-compose.dev.yml` now provides.
`scripts/ci.sh` requires it and clears the mailbox between suites, because a
leftover message for a reused address would be read as the current code.

## Sessions

Tokens are 32 random bytes; only their SHA-256 is stored, so a Redis dump yields
no usable session. Idle timeout is 30 days and refreshed on use, with a 90-day
absolute expiry checked against the stored timestamp so refreshing cannot extend
a session past it.

Email verification and login both revoke the session presented with the request
before issuing a new one, which is what closes session fixation. Registration
itself issues no session. Sessions are also indexed per user under
`user_sessions:<id>` so they can be revoked together; `POST /auth/logout-all`
uses that. The index holds hashed keys, never tokens, and a member whose session
has expired is harmless because deleting an absent key is a no-op.

Sessions carry a scope. A `Full` session is the ordinary one. A `Recovery`
session is minted by `/auth/recover/verify`, reaches `/auth/recover/complete`
and nothing else, and lives 15 minutes (`RECOVERY_SESSION_TTL_SECS`). Its TTL
is fixed at mint time and **deliberately not renewed on read**, unlike a `Full`
session's idle timeout: renewing would promote a 15-minute handle to the 30-day
idle timeout on its first use, including a use that was then rejected for being
out of scope. `get_session` in `apps/api/src/session.rs` guards the `expire`
call on the scope for exactly that reason.

## Password reset exists, and it requires the recovery code

`/auth/recover/start`, `/verify`, `/complete` in
`apps/api/src/auth/recovery_routes.rs`, driven by `apps/web/app/recover/`.
Read this section before describing recovery to anyone.

**What it requires.** Three things, and TOTP makes it four: an emailed six-digit
code, the **vault recovery code** printed at signup, and, when the account has
a factor enrolled, a TOTP code or a TOTP recovery code. The second factor is
not skipped here; recovery replaces the password, so skipping it would let a
leaked recovery code bypass the control the account enrolled to stop exactly
that.

**What it does.** `/verify` returns the `recovery_code` wrapper. The browser
opens it with the unlock key derived from the printed code, and `/complete`
writes two new wrappers over the **same account key** plus a fresh recovery
code, in one transaction. Nothing is re-encrypted: every form data key, every
form private key, every collaborator grant, and the account sharing private key
stay valid, because none of them was ever tied to the password.
`apps/web/e2e/recovery.spec.ts` proves this end to end by opening a
pre-recovery form afterwards.

**What it still cannot do.** Without the vault recovery code **the vault is
permanently unreadable**: the server holds wrapped blobs and Argon2 hashes of
one-way verifiers, none of which opens anything, and there is no
admin-assisted path. A user with an open vault can mint a fresh code (below),
so losing the code alone is survivable; losing the password and the code
together is not.

**The two kinds of recovery code are unrelated, and the product now has both.**

| | restores | useless for |
|---|---|---|
| **TOTP recovery code** (`totp_recovery_codes`, eight per enrolment) | account access when the authenticator is gone | decryption: it never touches the account key |
| **Vault recovery code** (`vault_recovery_codes`, exactly one live per account) | decryption, by unwrapping the account key | authentication on its own: it is not a second factor |

Never write "recovery code" unqualified in code comments, UI copy, or these
docs. Say which one. They are issued in different flows, stored in different
tables, and swapping them in a sentence turns a true statement into a false one.

**A lost vault recovery code is recoverable now, from an unlocked session.**
`POST /api/v1/account/recovery-code` (`regenerate_recovery_code` in
`apps/api/src/auth/recovery_routes.rs`), surfaced by
`components/settings/recovery-code-panel.tsx`.

It mints a replacement the same way `recover_complete` rotates the code, minus
the password wrapper and the session bump. The account key itself never
changes, so nothing below it moves and the caller's session stays valid.

Three properties to preserve:

- **A session alone is not enough.** It consumes a reauthentication receipt
  from `/auth/reauthenticate`, so a moment at an unlocked browser cannot mint a
  standing way back into the vault that would survive a later password change.
- **The old code is marked spent BEFORE the replacement is inserted.** The
  partial unique index is over `(user_id) WHERE used_at IS NULL`, so inserting
  first collides with the row being retired. The `used_at IS NULL` guard is
  also what makes two racing regenerations mutually exclusive.
- **It needs an already-open vault**, so it changes nothing for an account
  that has lost both the password and the code.

**Corollary for auth work:** a new unlock method must bring key material to
wrap the account key under, as a passkey's PRF output does (see the root key
hierarchy). OAuth/SSO does not fit, because an identity provider hands
back an assertion and no key material, leaving nothing to wrap the account key
under. And **do not
adopt a general-purpose auth framework** (Better Auth and similar) expecting its
headline features to apply: they are Node/TypeScript while the API is Rust, and
their OAuth, magic-link and passkey flows assume the password is only a
credential. Here it is key material.

## The rate limiter

Two properties of the limiter itself are easy to lose. The login key hashes
the lowercased, trimmed address (`login_rate_limit_key`), because
`users.email` is CITEXT: keyed on the raw string, every capitalisation of one
address was a fresh counter against the same account. And `check_rate_limit`
increments and sets the expiry in one Lua script, not two commands: a counter
that gained its increment but lost its expiry would refuse that key forever.

## Client addresses and trusted proxies

**Rate limits read the client address through `ClientIp` in
`apps/api/src/client_ip.rs`, never `ConnectInfo` directly.** Behind a proxy
the TCP peer is always the proxy, so keyed on that every user shares one
counter and five failed logins by anyone lock everyone out. `ClientIp` takes
`X-Forwarded-For` only when the peer is inside `TRUSTED_PROXY_CIDRS` or is a
proxy named in `TRUSTED_PROXY_HOSTS`, and
within it the rightmost address that is not itself a trusted proxy, so a
client cannot prepend a value and have it survive. Empty (the default, and
what the suites run with) trusts nothing and the header is inert. The
production file pins the internal subnet and names it there; Traefik's
entrypoint has no `forwardedHeaders.trustedIPs`, which is what makes it
overwrite the header with the real peer rather than append to it. Never set
the variable to `0.0.0.0/0`: every caller then invents an address per
request and the limits stop existing. Under Dokploy the proxy network is shared by every app on
the server, so its subnet must not be trusted; the Dokploy file trusts the
proxy by container name instead (`TRUSTED_PROXY_HOSTS`, resolved through
Docker's DNS every fifteen seconds). A name counts only while it resolves
to one address per family: when another container claims it the resolver
keeps the last unambiguous address, because anything else would let a
neighbour make itself trusted by naming itself after the proxy.

## Quizzes

A quiz is two ciphertexts the API stores and never reads: the answer key on
`forms.answer_key_ciphertext` and the manual grades in `form_grades`
(`forms/grades.rs`). Both are encrypted in the browser under a quiz key derived
from the form private key, which respondents never hold. Four things a future
edit would break by accident:

- **The answer key is written by `update_form`, in the same statement and
  under the same `expected_version` as `schema_ciphertext`.** It describes the
  questions, so a separate endpoint would let the two be saved apart and the
  key point at questions that no longer exist.
- **Grades have their own version.** Grading happens on the Responses tab,
  often while someone else edits the form. Bumping `forms.version` on every
  grade would hand that editor a conflict for a change they cannot see.
- **`get_form_public` never selects the answer key.** The key is encrypted
  under a key respondents lack, so this is a second layer rather than the
  protection, but there is no reason to hand anyone the ciphertext.
- **`put_grades` decides rights under lock**, form row then
  `FormAccess::load_for_update`, the same order `update_form` uses. A Viewer is
  refused with `404`, like everything else that must not reveal a form exists.
  A first write racing another returns `409` rather than retrying.
