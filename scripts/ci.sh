#!/usr/bin/env bash
#
# The single definition of "does this pass". CI invokes this script rather than
# re-listing the steps, so the two cannot drift apart.
#
#   scripts/ci.sh prepare       start the dev stack, bootstrap Garage, write apps/api/.env
#   scripts/ci.sh static        fmt, lint, types, unit tests, dependency audits
#   scripts/ci.sh integration   every API integration suite and Playwright e2e
#   scripts/ci.sh images        build both Docker images and boot each one
#   scripts/ci.sh version vX.Y.Z  every manifest and lockfile names that release
#   scripts/ci.sh               static and integration
#
# `static` needs `prepare` to have run: its unit tests open real Postgres,
# Redis and S3 connections, and the S3 credentials live in apps/api/.env.
# `integration` needs `prepare` to have run, plus the API and web dev servers;
# `images` needs Docker and the dev stack's Postgres and
# Redis; it is not part of the default run because a Rust image build takes
# minutes, so it is its own job in the workflow and its own command locally.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/apps/api"
WEB="$ROOT/apps/web"
COMPOSE="$ROOT/infra/docker/docker-compose.dev.yml"

# RustSec advisories with no available fix, reviewed and accepted. Anything not
# listed here fails the build, so a new advisory is not silently absorbed.
#
#   RUSTSEC-2023-0071  rsa timing sidechannel. Reached only through sqlx-mysql,
#                      which sqlx's `macros` feature compiles in even though
#                      only the postgres driver is enabled, so the code never
#                      executes. No fixed version exists.
#   RUSTSEC-2026-0194  quick-xml DoS, via rust-s3 0.37.2 which pins ^0.38 and is
#   RUSTSEC-2026-0195  the latest release. Parses responses from our own Garage
#                      endpoint rather than user input.
CARGO_AUDIT_IGNORE=(
  RUSTSEC-2023-0071
  RUSTSEC-2026-0194
  RUSTSEC-2026-0195
)

# npm advisories with no available fix, reviewed and accepted, on the same
# terms as the list above.
#
#   GHSA-vfj7-8cjw-p6xm  braces stack exhaustion on deeply nested patterns.
#                        Reached only through fast-glob in the shadcn CLI and
#                        eslint-config-next, dev tools that expand patterns we
#                        write, never user input. 3.0.3 is the latest release.
WEB_AUDIT_IGNORE=(
  GHSA-vfj7-8cjw-p6xm
)

FAILED=()
STEP=0
# Each step is numbered and timed, so a long run shows where it is and a slow
# step shows what it cost. Output streams as the step produces it; piping this
# script through a pager or `tail` buffers all of that until the end.
run() {
  local label="$1"
  shift
  STEP=$((STEP + 1))
  local started=$SECONDS
  printf '\n\033[1m▶ [%d] %s\033[0m\n' "$STEP" "$label"
  if "$@"; then
    printf '\033[32m✓ [%d] %s\033[0m (%ds)\n' "$STEP" "$label" "$((SECONDS - started))"
  else
    printf '\033[31m✗ [%d] %s\033[0m (%ds)\n' "$STEP" "$label" "$((SECONDS - started))"
    FAILED+=("$label")
  fi
}

web_audit() {
  local args=()
  for id in "${WEB_AUDIT_IGNORE[@]}"; do args+=(--ignore="$id"); done
  (cd "$WEB" && bun audit "${args[@]}")
}

cargo_audit() {
  local args=()
  for id in "${CARGO_AUDIT_IGNORE[@]}"; do args+=(--ignore "$id"); done
  (cd "$API" && cargo audit "${args[@]}")
}

# cargo does not load apps/api/.env (only the running binary does, through
# dotenvy), so every test that opens its own Postgres connection reads the URL
# from this process. Without it such a test panics on a clean shell and the
# suite reports a failure that is nothing to do with the code.
export_database_url() {
  if [ -z "${DATABASE_URL:-}" ] && [ -f "$API/.env" ]; then
    DATABASE_URL="$(dotenv_value DATABASE_URL)"
    export DATABASE_URL
  fi
}

# One unquoted value from apps/api/.env, for a test process cargo starts
# without reading that file.
dotenv_value() {
  grep -m1 "^$1=" "$API/.env" 2>/dev/null | cut -d= -f2-
}

# A refused connection has to be caught here: the Redis client's connection
# manager retries indefinitely, so a test that opens one against a stopped
# stack waits forever rather than failing. Uses bash's own /dev/tcp so the
# check needs no extra tool.
require_port() {
  local host="$1" port="$2" name="$3"
  if ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
    printf '\033[31m✗ %s is not reachable at %s:%s\033[0m\n' "$name" "$host" "$port"
    printf '  Start it first: ./scripts/ci.sh prepare\n'
    FAILED+=("$name not running")
    return 1
  fi
}

# Runs the Garage CLI inside the dev stack's container.
garage_cli() {
  docker compose -f "$COMPOSE" exec -T garage /garage "$@"
}

# garage.toml is gitignored because it holds secrets, so a fresh clone or
# runner has none and the garage container cannot start. Every placeholder in
# the example becomes its own random hex value. Hex rather than base64, which
# can contain '/' and would need escaping wherever it is substituted.
write_garage_config() {
  local target="$ROOT/infra/docker/garage.toml"
  [ -f "$target" ] && return 0
  local line out=""
  while IFS= read -r line; do
    case "$line" in
      *REPLACE_WITH_OUTPUT_OF_openssl_rand_*)
        line="${line%%REPLACE_WITH_OUTPUT_OF_openssl_rand_*}$(openssl rand -hex 32)\""
        ;;
    esac
    out+="$line"$'\n'
  done <"$ROOT/infra/docker/garage.toml.example"
  printf '%s' "$out" >"$target"
}

# The bucket and a key pair the API can use, written into apps/api/.env.
# Idempotent: a laid-out node, an existing bucket and a key Garage already
# knows are each left alone, so running this on a working laptop changes
# nothing. A key filled in .env that Garage does not know (its volume was
# wiped) is imported again under the same pair, so .env never changes.
bootstrap_garage() {
  # Captured first: under pipefail, grep -q closing the pipe early could fail
  # the CLI with SIGPIPE and silently skip the layout.
  local status
  status="$(garage_cli status)" || return 1
  if grep -q 'NO ROLE ASSIGNED' <<<"$status"; then
    local node_id
    node_id="$(garage_cli node id -q | cut -d@ -f1)"
    garage_cli layout assign -z dc1 -c 1G "$node_id" || return 1
    garage_cli layout apply --version 1 || return 1
  fi
  garage_cli bucket info krypta >/dev/null 2>&1 || garage_cli bucket create krypta || return 1

  local env_file="$API/.env"
  [ -f "$env_file" ] || cp "$API/.env.example" "$env_file"
  if grep -q '^S3_ACCESS_KEY=$' "$env_file"; then
    # Imported rather than created so the values are known here without
    # parsing the CLI's human-readable output.
    local key_id secret
    key_id="GK$(openssl rand -hex 12)"
    secret="$(openssl rand -hex 32)"
    garage_cli key import --yes -n "krypta-api-$key_id" "$key_id" "$secret" >/dev/null || return 1
    garage_cli bucket allow --read --write --owner krypta --key "$key_id" >/dev/null || return 1
    sed -i.bak \
      -e "s/^S3_ACCESS_KEY=\$/S3_ACCESS_KEY=$key_id/" \
      -e "s/^S3_SECRET_KEY=\$/S3_SECRET_KEY=$secret/" \
      "$env_file" && rm -f "$env_file.bak"
  else
    local key_id secret
    key_id="$(dotenv_value S3_ACCESS_KEY)"
    # key info prints the secret, so its output is discarded; only the exit
    # status is read, and it is nonzero for a key Garage does not have.
    if ! garage_cli key info "$key_id" >/dev/null 2>&1; then
      secret="$(dotenv_value S3_SECRET_KEY)"
      printf 'Garage has no key %s; importing the pair from apps/api/.env\n' "$key_id"
      # stdout carries the secret; stderr carries the reason an import failed.
      # Garage refuses an id it has ever held, even one since deleted, so this
      # recovers a wiped volume but not a deleted key.
      if ! garage_cli key import --yes -n "krypta-api-$key_id" "$key_id" "$secret" >/dev/null; then
        printf 'Garage would not import %s. If that key was deleted rather than its volume\n' "$key_id"
        printf 'wiped, empty S3_ACCESS_KEY and S3_SECRET_KEY in apps/api/.env and run prepare again.\n'
        return 1
      fi
    fi
    # Idempotent, and covers a key that exists but lost its bucket grant.
    garage_cli bucket allow --read --write --owner krypta --key "$key_id" >/dev/null || return 1
  fi
}

# Every place the product records its version, one "where version" pair per
# line. krypta is one product shipped as one release, so they all carry the
# same number: the API reports its Cargo version on the admin health page, and
# the private workspaces match it so a tag names one thing. Both lockfiles are
# read too, because bun does not rewrite a workspace's version when only the
# version changes and would keep the old one indefinitely. Workspaces are
# found by glob rather than listed, so a new package is covered without an
# edit here.
recorded_versions() {
  printf 'apps/api/Cargo.toml %s\n' \
    "$(grep -m1 '^version = "' "$API/Cargo.toml" | cut -d'"' -f2)"
  printf 'apps/api/Cargo.lock %s\n' \
    "$(awk '/^name = "api"$/ { getline; print; exit }' "$API/Cargo.lock" | cut -d'"' -f2)"
  local manifest name
  for manifest in "$ROOT"/apps/*/package.json "$ROOT"/packages/*/package.json; do
    name="$(grep -m1 '^  "name": "' "$manifest" | cut -d'"' -f4)"
    printf '%s %s\n' "${manifest#"$ROOT"/}" \
      "$(grep -m1 '^  "version": "' "$manifest" | cut -d'"' -f4)"
    printf 'bun.lock(%s) %s\n' "$name" \
      "$(awk -v key="\"name\": \"$name\"," 'index($0, key) { getline; print; exit }' \
        "$ROOT/bun.lock" | cut -d'"' -f4)"
  done
}

# With a tag, every recorded version must be that tag's. Without one, they
# must merely agree with each other, which is what the static gate asks on
# every push so a half-finished bump fails before anyone tags it. The release
# workflow runs the tagged form against the pushed tag, so a tag cut by hand
# without scripts/release.sh still cannot publish images whose admin page
# reports a different version from the one they are tagged with.
check_versions() {
  local tag="${1:-}" want
  if [ -n "$tag" ]; then
    if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
      printf '\033[31m✗ %s is not a release tag such as v0.2.0\033[0m\n' "$tag"
      return 1
    fi
    want="${tag#v}"
  else
    want="$(grep -m1 '^version = "' "$API/Cargo.toml" | cut -d'"' -f2)"
  fi
  local where have status=0
  while read -r where have; do
    if [ "$have" != "$want" ]; then
      printf '\033[31m✗ %s records %s, expected %s\033[0m\n' "$where" "${have:-nothing}" "$want"
      status=1
    fi
  done < <(recorded_versions)
  return $status
}

prepare_stack() {
  run "stack: garage config" write_garage_config
  run "stack: services up" docker compose -f "$COMPOSE" up -d --wait
  run "stack: garage bootstrap" bootstrap_garage
}

static_checks() {
  # SQLx checks every query at compile time against the committed `.sqlx`
  # metadata when this is set, and against a live database when it is not.
  # It must be set here and not only in the GitHub workflow: the compile is
  # meant to consult the committed metadata and never a live database, and
  # without it a stopped dev stack fails clippy with hundreds of "error
  # communicating with database" lines instead of the one named failure
  # require_port gives.
  export SQLX_OFFLINE=true
  run "versions: every manifest agrees" check_versions
  run "rust: fmt"        bash -c "cd '$API' && cargo fmt -- --check"
  # Warnings are failures here. The alternative is a build that is permanently
  # yellow, which trains everyone to stop reading it.
  run "rust: clippy"     bash -c "cd '$API' && cargo clippy --all-targets -- -D warnings"
  # forms::notifications's tests share the database and a global sweep query
  # (LIMIT 200 over form_members), so parallel test threads stamp each other's
  # fixtures' last_notified_at and race each other's due-member windows.
  # The session, passkey, recovery, verification and quota tests open real
  # Redis and Postgres connections, and attachments::cleanup's tests put and
  # delete real objects in the bucket, so this is the one static step with a
  # service dependency. Skipped with a named failure when one is down, rather
  # than hanging on the first connection or reporting a refused S3 request as
  # a cleanup bug.
  if require_port localhost 5433 postgres && require_port localhost 6379 redis &&
    require_port localhost 3900 garage; then
    export_database_url
    run "rust: unit tests" bash -c "cd '$API' && cargo test --bin api -- --test-threads=1"
  fi
  run "rust: audit"      cargo_audit

  # The committed catalogue must match what the family list generates, or
  # the picker offers a font the build does not ship.
  run "web: fonts"       bash -c "cd '$WEB' && bun run fonts:build >/dev/null && git diff --exit-code -- lib/font-catalog.json"
  run "web: typecheck"   bash -c "cd '$WEB' && bun run typecheck"
  run "web: lint"        bash -c "cd '$WEB' && bun run lint"
  run "web: unit tests"  bash -c "cd '$WEB' && bun run test:unit"
  run "web: audit"       web_audit
  run "crypto: tests"    bash -c "cd '$ROOT/packages/crypto' && bun run test"
  run "web: build"       bash -c "cd '$WEB' && bun run build"
}

# Registration is capped per IP/hour and per address/hour, and the suites need
# more than the production defaults allow, so the counters are cleared first.
# The `ratelimit:*` glob is what makes this exhaustive: it already sweeps the
# login, verify and `ratelimit:recover_start`/`ratelimit:recover_verify`
# counters, so a new limit needs no edit here, only a raised value in
# apps/api/.env if a suite would otherwise trip it.
# The mailbox is emptied too: a leftover message for a reused address would be
# read back as the current code. Otherwise the failure surfaces as a navigation
# timeout several steps later, which reads as broken product code.
clear_rate_limits() {
  docker compose -f "$COMPOSE" exec -T redis \
    redis-cli --scan --pattern 'ratelimit:*' 2>/dev/null |
    xargs -r -I{} docker compose -f "$COMPOSE" exec -T redis redis-cli DEL {} >/dev/null 2>&1
  curl -sf -X DELETE "http://localhost:8025/api/v1/messages" >/dev/null 2>&1
  return 0
}

require_service() {
  local url="$1" name="$2"
  if ! curl -sf -o /dev/null "$url"; then
    printf '\033[31m✗ %s is not reachable at %s\033[0m\n' "$name" "$url"
    printf '  Start it first: ./scripts/ci.sh prepare, then the API and web dev servers.\n'
    FAILED+=("$name not running")
    return 1
  fi
}

# The suites need the values apps/api/.env.example carries (short attachment
# and notification windows, the test hook, raised limits). A .env copied
# before those moved there is the likeliest local cause of a failure that
# looks like a product bug, so it is named before anything runs.
require_suite_env() {
  if ! grep -q '^KRYPTA_ATTACHMENT_TEST_HOOKS=1' "$API/.env" 2>/dev/null; then
    printf '\033[31m✗ apps/api/.env is missing the suite settings\033[0m\n'
    printf '  Compare it with apps/api/.env.example, then restart the API.\n'
    FAILED+=("apps/api/.env out of date")
    return 1
  fi
  # billing_test gets its own server on 8081; the shared 8080 server this gate
  # runs the e2e suite against must have Stripe off, or the free plan's
  # ten-open-forms limit caps the Playwright account and fails full-flow.
  if grep -q '^STRIPE_SECRET_KEY=.' "$API/.env" 2>/dev/null; then
    printf '\033[31m✗ apps/api/.env has Stripe configured\033[0m\n'
    printf '  Comment out the STRIPE lines in apps/api/.env for this gate, then restart the API.\n'
    FAILED+=("apps/api/.env has billing enabled")
    return 1
  fi
}

# admin_test claims the bootstrap admin and resets the claim when it is done,
# so on a database with a real admin it would silently unclaim that account.
require_no_instance_admin() {
  local admins
  admins="$(docker compose -f "$COMPOSE" exec -T postgres \
    psql -U krypta -d krypta -tAc 'SELECT count(*) FROM users WHERE instance_admin')"
  if [ "$admins" != "0" ]; then
    printf '\033[31m✗ admin_test needs a database with no instance admin; this one has %s\033[0m\n' "$admins"
    printf '  The suite needs a database with no instance admin, and no test run leaves one behind,\n'
    printf '  so this is an account someone promoted. Demote it, or run the suite on another database.\n'
    FAILED+=("admin integration (database already has an admin)")
    return 1
  fi
}

# billing_test needs an API with Stripe configured, and the e2e suite needs
# one without (the free plan's ten-form limit would break it), so this suite
# gets its own server on 8081 for its duration. Dummy values suffice: nothing
# calls Stripe, and the secret is only ever used as HMAC key bytes, so its
# format is not checked. The process environment wins over apps/api/.env.
# The cleanup and notification sweep intervals are set to an hour so this
# second server does not also reap attachments and mail response notifications
# against the same database the 8080 server already sweeps.
BILLING_WEBHOOK_SECRET="whsec_ci_integration_only"
billing_suite() {
  (cd "$API" && cargo build --bin api) || return 1
  (
    cd "$API" &&
      PORT=8081 \
      STRIPE_SECRET_KEY=sk_test_ci \
      STRIPE_WEBHOOK_SECRET="$BILLING_WEBHOOK_SECRET" \
      STRIPE_PORTAL_RETURN_URL=http://localhost:3000/dashboard/settings \
      STRIPE_PRICE_MONTHLY=price_ci_monthly \
      STRIPE_PRICE_YEARLY=price_ci_yearly \
      ATTACHMENT_CLEANUP_INTERVAL_SECONDS=3600 \
      RESPONSE_NOTIFY_SWEEP_INTERVAL_SECONDS=3600 \
      exec ./target/debug/api
  ) >/tmp/krypta-billing-api.log 2>&1 &
  local pid=$!
  local i ready=1
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null http://localhost:8081/health; then
      ready=0
      break
    fi
    sleep 1
  done
  local status=1
  if [ $ready -eq 0 ]; then
    (cd "$API" && TEST_API_BASE=http://localhost:8081 STRIPE_WEBHOOK_SECRET="$BILLING_WEBHOOK_SECRET" \
      cargo test --test billing_test -- --test-threads=1)
    status=$?
  else
    printf 'billing API did not answer on 8081 within 60s\n'
  fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  return $status
}

integration_checks() {
  require_service "http://localhost:8080/health" "api" || return
  require_service "http://localhost:3000/" "web" || return
  require_service "http://localhost:8025/api/v1/messages" "mailpit" || return
  require_suite_env || return

  # The test targets compile against the committed .sqlx metadata, the same as
  # the static gate, so a fresh runner's database is never consulted by rustc.
  export SQLX_OFFLINE=true
  # Several suites connect to Postgres directly rather than through the API.
  export_database_url

  run "rust: health integration" bash -c "cd '$API' && cargo test --test health_test"
  run "rust: migrations integration" bash -c "cd '$API' && cargo test --test migrations_test -- --test-threads=1"
  clear_rate_limits
  # admin_test runs first: it asserts the admin count exactly, and
  # sharing_test briefly promotes a throwaway user (demoted again when that
  # test ends, even on failure). It also rewrites the registration and login
  # limits the shared API
  # reads from instance_settings, from its own environment, and cargo does not
  # load apps/api/.env, so the raised values are passed through explicitly or
  # every later suite runs against the lower defaults the test falls back to.
  if require_no_instance_admin; then
    run "rust: admin integration" bash -c "cd '$API' && \
      REGISTER_RATE_LIMIT_PER_HOUR='$(dotenv_value REGISTER_RATE_LIMIT_PER_HOUR)' \
      LOGIN_RATE_LIMIT_PER_MINUTE='$(dotenv_value LOGIN_RATE_LIMIT_PER_MINUTE)' \
      cargo test --test admin_test -- --test-threads=1"
  fi
  clear_rate_limits
  run "rust: auth integration" bash -c "cd '$API' && cargo test --test auth_test -- --test-threads=1"
  clear_rate_limits
  run "rust: email verification integration" bash -c "cd '$API' && cargo test --test email_verify_test -- --test-threads=1"
  clear_rate_limits
  # Single-threaded and slow on purpose: the TOTP tests wait out a 30-second
  # timestep so a code is not rejected as a replay.
  run "rust: totp integration" bash -c "cd '$API' && cargo test --test totp_test -- --test-threads=1"
  clear_rate_limits
  run "rust: passkey integration" bash -c "cd '$API' && cargo test --test passkey_test -- --test-threads=1"
  clear_rate_limits
  run "rust: forms integration" bash -c "cd '$API' && cargo test --test forms_test -- --test-threads=1"
  clear_rate_limits
  run "rust: grades integration" bash -c "cd '$API' && cargo test --test grades_test -- --test-threads=1"
  clear_rate_limits
  run "rust: attachments integration" bash -c "cd '$API' && cargo test --test attachments_test -- --test-threads=1"
  clear_rate_limits
  run "rust: recovery integration" bash -c "cd '$API' && cargo test --test recovery_test -- --test-threads=1"
  clear_rate_limits
  run "rust: recovery code regeneration integration" bash -c "cd '$API' && cargo test --test recovery_code_regen_test -- --test-threads=1"
  clear_rate_limits
  run "rust: sharing integration" bash -c "cd '$API' && cargo test --test sharing_test -- --test-threads=1"
  clear_rate_limits
  run "rust: notifications integration" bash -c "cd '$API' && cargo test --test notifications_test -- --test-threads=1"
  clear_rate_limits
  run "rust: billing integration" billing_suite
  clear_rate_limits
  run "web: e2e" bash -c "cd '$WEB' && bunx playwright test --reporter=line --workers=1"
}

# The images a self-hoster runs. Building is necessary and not sufficient:
# a logging silence once survived a clean build and needed a boot to catch,
# so each image is started and polled, and this helper is shared by both
# boots: start the container, poll the given URL until it answers, and print
# the container's tail and remove it if it never does.
boot_container() {
  local name="$1" url="$2"
  shift 2
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" "$@" >/dev/null || return 1
  local i
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
  done
  printf '%s did not answer at %s within 60s. Last log lines:\n' "$name" "$url"
  docker logs --tail 40 "$name" 2>&1 | sed 's/^/  /'
  docker rm -f "$name" >/dev/null
  return 1
}

# Runs a command inside a booted container, then removes it either way.
probe_and_remove() {
  local name="$1"
  shift
  docker exec "$name" "$@"
  local status=$?
  docker rm -f "$name" >/dev/null
  return $status
}

# The API runs on the dev stack's network against its Postgres and Redis, the
# same database the dev server uses, with its migrations already applied and
# idempotent. Any S3 values will do: boot constructs the client and contacts
# nothing.
api_image_boots() {
  boot_container krypta-ci-api http://127.0.0.1:8090/health \
    --network krypta-dev_default -p 127.0.0.1:8090:8080 \
    -e DATABASE_URL=postgres://krypta:krypta_dev_password@postgres:5432/krypta \
    -e REDIS_URL=redis://redis:6379 \
    -e S3_ENDPOINT=http://garage:3900 -e S3_ACCESS_KEY=ci -e S3_SECRET_KEY=ci -e S3_BUCKET=krypta \
    -e SMTP_HOST=mailpit -e SMTP_PORT=1025 -e SMTP_TLS=none \
    -e MAIL_FROM='krypta <no-reply@localhost>' \
    -e WEBAUTHN_RP_ID=localhost -e WEBAUTHN_ORIGIN=http://localhost:3000 \
    krypta-api:ci || return 1
  # The same command docker-compose.prod.yml uses as its healthcheck.
  probe_and_remove krypta-ci-api ./api healthcheck
}

web_image_boots() {
  boot_container krypta-ci-web http://127.0.0.1:3090/ \
    -p 127.0.0.1:3090:3000 krypta-web:ci || return 1
  # The same command docker-compose.prod.yml uses as its healthcheck.
  probe_and_remove krypta-ci-web bun -e \
    "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

image_checks() {
  if ! docker info >/dev/null 2>&1; then
    printf '\033[31m✗ docker is not running\033[0m\n'
    FAILED+=("docker not running")
    return
  fi
  require_port localhost 5433 postgres && require_port localhost 6379 redis || return

  run "image: api build" docker build -q -t krypta-api:ci "$API"
  run "image: web build" docker build -q -t krypta-web:ci -f "$WEB/Dockerfile" "$ROOT"

  run "image: api boots" api_image_boots
  run "image: web boots" web_image_boots
}

case "${1:-all}" in
  prepare) prepare_stack ;;
  static) static_checks ;;
  integration) integration_checks ;;
  images) image_checks ;;
  version) run "versions: every manifest records ${2:-the same version}" check_versions "${2:-}" ;;
  all) static_checks; integration_checks ;;
  *) echo "usage: $0 [prepare|static|integration|images|version [vX.Y.Z]|all]" >&2; exit 2 ;;
esac

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mAll checks passed.\033[0m\n'
  exit 0
fi
printf '\033[31m%d check(s) failed:\033[0m\n' "${#FAILED[@]}"
printf '  - %s\n' "${FAILED[@]}"
exit 1
