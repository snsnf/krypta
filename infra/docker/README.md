# Deploying krypta

This directory holds everything needed to run krypta in production, and this
file is the operator's guide to it. It assumes one Linux server, Docker, a
domain you control, an S3-compatible object store, and an SMTP provider.

The stack behind the proxy is three containers you run (API, web app,
Postgres) plus Redis, all on a private Docker network. Traefik is the only
thing listening on the internet: it terminates TLS with Let's Encrypt for one
hostname and routes `/api` to the API and everything else to the web app.
Encrypted attachments go to an external object store. Nothing here can read
user content: every form, response and file is encrypted in the browser
before it is sent.

Files:

| File | Purpose |
|---|---|
| `docker-compose.prod.yml` | The production stack. |
| `.env.prod.example` | Template for `.env.prod`, the one file you edit. |
| `traefik/traefik.yml` | Traefik's static configuration. Rarely touched. |
| `backup.sh` | Nightly encrypted database backup, for cron. |
| `docker-compose.dev.yml`, `docker-compose.yml`, `garage.toml.example` | Development and local smoke stacks. Not for production. |

## Prerequisites

- **A server.** 2 vCPUs, 4 GB RAM and 40 GB disk on Ubuntu 24.04 or Debian 12
  is enough to start. Install Docker Engine with the compose plugin from
  Docker's own repository, plus `age` and the AWS CLI for backups. Allow only
  ports 22, 80 and 443 through the firewall, use SSH keys, and enable
  unattended security upgrades.
- **A domain**, with DNS you can edit.
- **An S3-compatible object store.** Backblaze B2 is the reference; Cloudflare
  R2, Hetzner Object Storage and AWS S3 also work.
- **An SMTP provider** for transactional mail (Postmark, Resend, Amazon SES,
  Mailgun). Signup, invitations, recovery and notifications all go by email,
  so without this nobody can create an account.

## Choosing the hostname

Pick this before the first user signs up, because two settings derived from
it are permanent.

`DOMAIN` is the hostname users visit, for example `getkrypta.com` or
`forms.getkrypta.com`. It can change later at the cost of a rebuild and a
redirect.

`WEBAUTHN_RP_ID` is the passkey relying-party ID. A passkey is scoped to it
forever: a credential enrolled against `getkrypta.com` works from
`getkrypta.com`, `forms.getkrypta.com` and `secrets.getkrypta.com`, while one
enrolled against `forms.getkrypta.com` works only there. The scope can be
narrowed by moving to a subdomain later, never widened. If more than one app
will ever share these accounts, set it to the registrable apex on day one.
Changing it later does not lock anyone out, because the password still opens
every vault, but it turns every enrolled passkey into dead weight.

Create the DNS records (an A record, and an AAAA record if the server has
IPv6) before starting the stack. Traefik requests its certificate on first
start and fails while the name does not resolve.

## Object storage

Create two private buckets, ideally in the region closest to the server:

- **Attachments bucket**, for example `krypta-attachments`. Application key
  restricted to this bucket with read, write, list and delete.
- **Backups bucket**, for example `krypta-backups`, preferably in a different
  region. Application key restricted to this bucket with write and list but
  not delete, so a compromised server cannot erase its own history.

On the attachments bucket set the lifecycle rule to keep only the last
version of each file, or to hide and then delete within a few days. B2 keeps
every version forever by default, and krypta's attachment cleanup deletes
objects when forms or responses are removed; against a keep-everything
lifecycle those deletes only hide the object and storage never shrinks.

The endpoint and region are shown on the bucket page and must agree, for
example `https://s3.eu-central-003.backblazeb2.com` with region
`eu-central-003`. A mismatch fails every request with a signature error.

## Email

Verify your domain with the SMTP provider and add the SPF, DKIM and DMARC
records they give you; without them verification codes land in spam. Use
port 587 with `SMTP_TLS=starttls`, or 465 with `SMTP_TLS=implicit`. Set
`MAIL_FROM` to an address on your domain. The sender name inside the quotes
is what users see.

## Configure and start

```bash
git clone <repository> /srv/krypta
cd /srv/krypta/infra/docker
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

Edit `.env.prod`. Every line marked REQUIRED needs a value; each is explained
in the file and in the reference below. Then:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

That builds both images from this source: about five minutes for the API on a
developer laptop, longer on a small server, and it wants roughly 2 GB of free
memory to link. Later builds are much faster, because the dependency tree
compiles in its own layer keyed on `Cargo.toml` and `Cargo.lock` alone, so
changing only Rust source rebuilds your crate and nothing else: 16 seconds
against 276 for a cold build.

### Or run published images instead

Set `KRYPTA_API_IMAGE` and `KRYPTA_WEB_IMAGE` in `.env.prod` to a published
tag, then:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

Nothing compiles, so a 1 GB server is enough. Images are built for amd64 and
arm64, and carry build provenance, so `gh attestation verify` can confirm one
came from the commit it claims.

Pin a version rather than `latest`, so an upgrade is a decision. Building from
source stays supported and always will: every question, answer and file is
encrypted in the browser, and anyone relying on that should be able to run
code they have read rather than a binary handed to them.

The web image carries no hostname. Its browser bundle calls the relative
`/api/v1`, which Traefik routes to the API on this same host, so the image
that gets built here would run unchanged on any domain. Only `SITE_URL` names
your domain, and it is read at request time, so changing it is a restart
rather than a rebuild.

## Or run it on Dokploy

Use `docker-compose.dokploy.yml` instead of `docker-compose.prod.yml` when the
server is managed by [Dokploy](https://dokploy.com). Dokploy already runs
Traefik on ports 80 and 443 with its own Let's Encrypt setup, so the two files
cannot both run on one host: the Dokploy file drops the bundled proxy and lets
Dokploy's route to the same two containers. Postgres and Redis stay on a
private network, unreachable from other apps on that server, and the images,
healthchecks, hardening and settings are the ones described everywhere else in
this guide.

1. Create a Compose service pointing at this repository, with the compose path
   `infra/docker/docker-compose.dokploy.yml`. There is no `.env.prod` in this
   path: every setting goes in the service's Environment tab, and the
   reference at the end of this file explains each one.
2. Read the proxy network's name on the server and set `DOKPLOY_NETWORK` to
   it:

```bash
docker network ls | grep -i dokploy
docker ps --format '{{.Names}}' | grep -i traefik
```

   The API trusts the proxy by its container name, `TRUSTED_PROXY_HOSTS`,
   which defaults to `dokploy-traefik`; set it only if the second command
   prints a different name. Leave `TRUSTED_PROXY_CIDRS` unset. Every
   application on a Dokploy server shares the proxy network, so trusting its
   subnet would let any of them send a made-up client address and walk past
   every rate limit keyed on it. A name is trusted only while it resolves to
   one container: if another container claims the same name, the API keeps
   the address it already had and logs the conflict. An installation that set
   `TRUSTED_PROXY_CIDRS` to the subnet before this keeps working, and should
   remove it.
3. Add the domain twice in the service's Domains tab, both with HTTPS and a
   certificate:

| Service | Path | Container port |
|---|---|---|
| `api` | `/api` | 8080 |
| `web` | `/` | 3000 |

One hostname with the API under `/api` is a requirement rather than a
preference: the session cookie is `__Host-` prefixed and `SameSite=Lax`, so an
API on its own subdomain never receives it and login cannot work.

Two things to confirm on a Dokploy install, because its proxy is configured
outside this repository:

- **Client addresses reach the API.** Fail a login five times from one network
  and check that a second device still works. If everyone is refused at once,
  `TRUSTED_PROXY_HOSTS` does not name Dokploy's proxy container (the API logs
  `trusted proxy host did not resolve` or a conflict over the name), or
  Dokploy's Traefik is passing through an `X-Forwarded-For` the client
  supplied.
- **Backups are yours to arrange.** `backup.sh` here runs on the host from
  cron, as described under Backups. Dokploy's own scheduled database backups
  are an alternative; either way an instance with no off-site copy is not
  backed up.

Building the API image wants roughly 2 GB of memory and several minutes, which
a small Dokploy server may not have. Setting `KRYPTA_API_IMAGE` and
`KRYPTA_WEB_IMAGE` to published tags makes the deploy a pull.

## Verify

Traefik only routes to the api and web containers once their healthchecks
pass, so right after `up -d` (whether building or pulling, and the same is
true after an upgrade) the site answers 404 for a short while. Wait for
`docker compose ps` to show both containers healthy, normally under a minute,
before concluding anything is wrong.

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs traefik | grep -i acme
curl https://<DOMAIN>/api/v1/health      # expect: ok
```

Then use it as the first user, before anyone else does. Sign up at the real
domain and complete email verification. Create a form, upload a header image,
open the public link in a private window and submit a response with a file
attached, and confirm the object appears in the attachments bucket. Enroll a
passkey and a TOTP factor in account settings, sign out, and sign back in
with each. This exercises every external dependency once.

## The first administrator

An instance has no administrator until one is bootstrapped. Set
`KRYPTA_INITIAL_ADMIN_EMAIL` to the exact address you will sign up with,
before the first start. That account becomes the admin once it has registered,
verified its email, enrolled TOTP, signed out, and completed a TOTP login.
After the claim is recorded, changing or blanking the variable does not
create another admin.

The admin dashboard at `/admin` manages accounts and instance limits. It
cannot read anything: there is no readable content on the server.

## Container hardening

The compose file ships hardened, and the settings below are load-bearing
rather than decorative. If you adapt it, keep them.

Every service drops all Linux capabilities and runs with
`no-new-privileges`. Traefik gets exactly one capability back,
`NET_BIND_SERVICE`, because it binds 80 and 443. The API and Traefik both run
on a read-only root filesystem; the API can do so because the binary writes
nothing to disk. Both application images run as an unprivileged user with no
shell.

Traefik is the only service that publishes a port. Postgres and Redis sit on
an internal network with no host ports at all, so they are reachable from the
other containers and from nowhere else. Do not add a published port to either
one "temporarily" to run a query: use `docker compose exec`.

The Docker socket is mounted into Traefik read-only. Traefik only needs to
watch containers, and with write access a compromised proxy could start a
privileged container on the host.

`TRUSTED_PROXY_CIDRS` must name the internal subnet, which is pinned in the
compose file for exactly this reason. Rate limits key off the client address,
and behind a proxy the connecting peer is always the proxy, so with this
unset every user shares one counter and five failed logins by anyone lock out
everyone. Never set it to `0.0.0.0/0`: every caller could then invent an
address per request and the limits would stop existing.

The stack sets `name: krypta`. Without it, a production run on a machine that
has ever run the development stack would boot on the development database,
because both declare the same volume keys.

## Backups

The database is the only thing that needs backing up. Attachments live in the
object store, which is durable and versioned on its own. Redis holds sessions
and rate-limit counters; losing it signs everyone out and nothing more.

`backup.sh` produces one encrypted `pg_dump` per run. Setup:

1. On your own machine, not the server, run `age-keygen -o krypta-backup-key.txt`.
   Store that file in your password manager. It is the only thing that can
   open a backup.
2. Put the public key (the `age1...` line) in `.env.prod` as
   `BACKUP_AGE_RECIPIENT`, and fill in the five `BACKUP_S3_*` values for the
   backups bucket.
3. Run `./backup.sh` once by hand and confirm the file appears in the bucket.
4. Schedule it:

   ```bash
   sudo crontab -e
   17 3 * * * cd /srv/krypta/infra/docker && ./backup.sh >> /var/log/krypta-backup.log 2>&1
   ```

Without `BACKUP_S3_BUCKET` the script keeps dumps on the server only and says
so on every run. That protects against a bad migration, not against losing
the machine.

**Restore**, onto a stopped stack with an empty database volume:

```bash
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp "s3://$BACKUP_S3_BUCKET/postgres-<stamp>.dump.age" .
age -d -i krypta-backup-key.txt postgres-<stamp>.dump.age > /tmp/krypta.dump
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
    pg_restore -U krypta -d krypta --clean --if-exists < /tmp/krypta.dump
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

Rehearse this once with your first backup. Attachment rows in the restored
database point at objects that are still in the bucket, so nothing else is
needed.

## Uptime

Point an external monitor at `https://<DOMAIN>/api/v1/health` with a one
minute interval and an alert to your phone. It must run somewhere other than
this server, or it cannot tell you the server is down. `/health` without the
`/api/v1` prefix is not reachable through the proxy.

## Upgrades

```bash
cd /srv/krypta && git pull
cd infra/docker && ./backup.sh
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically when the API starts. Take the backup
first for any release that includes one. Changing `DOMAIN` needs this same
rebuild, because the web app inlines the API address at build time.

## Billing

Billing is for a hosted instance that charges for a pro plan. It is off
unless all five `STRIPE_*` variables are set; with any of them blank, no
billing route exists, no call to Stripe is ever made, and account limits come
from the instance defaults the admin dashboard controls. A self-hosted
instance leaves them blank. To enable it, create the two prices in Stripe,
point a webhook at `https://<DOMAIN>/api/v1/billing/webhook`, and set the
`plans.stripe_price_id_monthly` and `plans.stripe_price_id_yearly` columns
for the `pro` row in the database to the same price IDs.

## Privacy policy and terms

`/privacy` and `/terms` are served only when this instance says who runs it.
Set `LEGAL_ENTITY` and `LEGAL_CONTACT_EMAIL` in `.env.prod` and both pages
appear, with links in the footer beside Security. Leave either blank and both
return 404 and nothing links to them.

This is a gate rather than an oversight. Those pages are promises made by a
named operator to their own users, so an instance that has not named one
publishes nothing rather than a policy naming somebody else. `/security`
describes the software instead of making promises, so it is always served.

Read both pages before you point anyone at them. The parts describing what is
stored and what cannot be read are drawn from what the code actually does, and
they are the bulk of the text. The parts that are yours to check are the
company details, the retention periods you actually keep to, whether you offer
paid plans at all, and anything your own lawyer wants said. The terms name no
governing law, which is a clause to add with advice rather than one to guess
at. They are a starting point written against this software, not legal
advice.

## Settings reference

Required settings:

| Setting | Meaning |
|---|---|
| `DOMAIN` | The public hostname. Also the TLS certificate name and the web app's API address. |
| `ACME_EMAIL` | Where Let's Encrypt sends certificate expiry and problem notices. |
| `POSTGRES_PASSWORD` | Database password, generated once. `openssl rand -hex 32`. Hex, not base64: it is placed inside the database URL, where a `/` or `+` breaks it. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | The attachments bucket. Endpoint and region must agree. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_TLS`, `MAIL_FROM` | The mail relay. `SMTP_TLS` is `starttls` (587) or `implicit` (465). |

Optional settings:

| Setting | Meaning |
|---|---|
| `WEBAUTHN_RP_ID` | Passkey relying-party ID. Defaults to `DOMAIN`. Permanent; see "Choosing the hostname". |
| `KRYPTA_INITIAL_ADMIN_EMAIL` | Bootstraps the first administrator; see above. |
| `STRIPE_*` | Billing, all five or none; see above. |
| `BACKUP_AGE_RECIPIENT`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_S3_*` | Used by `backup.sh` only; see "Backups". |

### Tuning

Every setting below has a default that suits a public instance, and a blank
value in `.env.prod` means "use the default". Rate limits count per client
address as seen through Traefik, so people behind one office or carrier
address share a bucket; that is the reason to raise one, and a spam problem
the reason to lower one.

| Setting | Default | What it limits |
|---|---|---|
| `REGISTER_RATE_LIMIT_PER_HOUR` | 5 | Signups started per address per hour. |
| `REGISTER_EMAIL_RATE_LIMIT_PER_HOUR` | 5 | Signups started per email address per hour. |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | 5 | Password attempts per address and email per minute. |
| `VERIFY_RATE_LIMIT_PER_MINUTE` | 10 | Email-code checks per address per minute. |
| `VERIFY_CODE_TTL_SECONDS` | 900 | How long a signup verification code stays valid. |
| `VERIFY_MAX_ATTEMPTS` | 5 | Wrong codes before a pending signup is discarded. |
| `RESEND_COOLDOWN_SECONDS` | 60 | Minimum gap between "resend code" requests. |
| `PASSKEY_RATE_LIMIT_PER_MINUTE` | 10 | Passkey login requests per address per minute. A login is two requests. |
| `RECOVER_START_RATE_LIMIT_PER_HOUR` | 5 | Vault recoveries started per address per hour. Each one sends an email. |
| `RECOVER_VERIFY_RATE_LIMIT_PER_MINUTE` | 5 | Recovery code checks per address per minute. |
| `RECOVER_MAX_ATTEMPTS` | 5 | Wrong emailed codes before a pending recovery is destroyed. |
| `INVITE_RATE_LIMIT_PER_HOUR` | 20 | Collaboration invitations sent per account per hour. |
| `INVITE_RATE_LIMIT_PER_DAY` | 100 | The same, per day. |
| `INVITE_RECIPIENT_RATE_LIMIT_PER_HOUR` | 3 | Invitations to one recipient address per hour. |
| `INVITE_CONTINUATION_RATE_LIMIT_PER_HOUR` | 30 | Invitation link redemptions per address per hour. |
| `RESPONSE_NOTIFY_COOLDOWN_SECONDS` | 3600 | Quiet period per collaborator after a "new responses" email. |
| `RESPONSE_NOTIFY_SWEEP_INTERVAL_SECONDS` | 30 | How often pending notifications are checked. |
| `S3_OPERATION_TIMEOUT_SECONDS` | 30 | Deadline for one object store operation. |
| `ATTACHMENT_UPLOAD_STALE_SECONDS` | 120 | When an unfinished upload is considered abandoned. Must exceed the timeout above. |
| `ATTACHMENT_CLEANUP_INTERVAL_SECONDS` | 60 | How often abandoned uploads and deleted objects are swept. |

Settings that exist in the API but are fixed by the compose file and not
exposed: `DATABASE_URL`, `REDIS_URL`, `PORT`, `WEB_BASE_URL`,
`WEBAUTHN_ORIGIN` (all derived from `DOMAIN` and the internal network),
`TRUSTED_PROXY_CIDRS` (pinned to the internal subnet so rate limits see the
real client address), and `CORS_ALLOWED_ORIGINS` (unneeded when the web app
and API share one origin).

## Troubleshooting

- **Traefik logs `Error response from daemon` and no routes appear.** The
  Docker Engine is newer than the Traefik image's client. The compose file
  pins a Traefik release that works with Docker Engine 29; do not roll it
  back to 3.3 or earlier.
- **No certificate.** Check that `DOMAIN` resolves to this server from the
  internet and that port 443 is open; Traefik uses the TLS-ALPN challenge and
  needs nothing else. Let's Encrypt refuses names that are not public.
- **Signup says the code was sent but nothing arrives.** Check the API log for
  the SMTP error, then the provider's activity log. Most often the sending
  domain is not verified with the provider.
- **Everyone is rate limited at once.** The API is seeing the proxy's address
  instead of the client's. `TRUSTED_PROXY_CIDRS` must match the network's
  subnet in the compose file; both are `172.28.0.0/24` as shipped. Under
  Dokploy it is `TRUSTED_PROXY_HOSTS` instead, as described there.
- **Attachment uploads fail with a signature error.** `S3_REGION` does not
  match the bucket's region, or the endpoint is from a different region.
