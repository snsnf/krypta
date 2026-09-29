# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Built and merged: email/password auth, encrypted forms and responses, public
anonymous submission, persistent vault unlock (device-bound key wrapping),
editable forms, 10 question types plus a client-side-only "required" toggle and
an optional respondent-written "Other" choice, uploaded and encrypted form
header images, encrypted file uploads (S3-backed), nonce-based CSP,
email verification, TOTP 2FA, per-form collaboration, instance administration (`/api/v1/admin/*`,
account lifecycle only: an admin gains no ability to read anything, because
there is nothing readable to gain), account key indirection with vault recovery
and regeneration of the vault recovery code from an unlocked session, passkeys
as a third unlock method, per-member response notifications,
server-enforced form response limits (close date and response cap) alongside an
encrypted custom confirmation message, quiz mode (scored in members' browsers
under a member-only key), conditional questions, the Classic and
Focus layouts, form duplication, starter templates, on-device drafts, in-browser response search, post-quantum
hybrid sealing, padded ciphertext, self-hosted fonts, and Stripe billing for the
hosted instance (inert on any instance with no Stripe configuration, offering
free and pro plans). This file and the directory guidance carry the design
each of these rests on; the code and `git log` carry the rest.

There is no separate long-term spec, deliberately: a stale spec is
disqualifying in a repository whose pitch is that the claims can be checked
against the code. The guarantee and its limits live in `SECURITY.md`,
container and proxy hardening in `infra/docker/README.md`, and the design
invariants here.

## Where guidance lives

This file holds the design the whole system rests on (the rules, the key
hierarchy, sealing, padding, the guarantees) and applies wherever you are
working. Directory guidance holds how to work in that directory and the design
of the subsystems that live there, and each fact lives in exactly one file
rather than being mirrored:

- `apps/api/CLAUDE.md`: SQLx and migrations, the integration-test idiom, the
  unit-test database and environment, Rust commands, then the design of the
  API's subsystems (listed under "Subsystem design lives with its code").
- `apps/web/CLAUDE.md`: frontend conventions, vitest's limits, writing e2e
  tests, the shadcn MCP gotcha, web commands, then the design of drafts,
  fonts and "Other" answers.
- `SECURITY.md`: the guarantee, the metadata the server sees, the rate-limit
  table, what the application itself enforces (sessions, headers, uploads,
  key handling), and how to report a vulnerability. Read by people deciding whether to trust an instance, so it
  may not reference a `CLAUDE.md` and may not outrun the code.
- `infra/docker/README.md`: the operator's deployment guide, and the only
  document `.env.prod.example` and the compose files may point a reader at.
  No configuration file, template, script output or user-facing text may
  reference a `CLAUDE.md`: those are design notes for people editing the
  code, and anyone else who meets the name has been sent to the wrong place.
  Explain the point inline instead, or point at the README. Code comments
  may still cite these files, since their readers are editing the code.

## Intended architecture

Three-tier, zero-knowledge design:

- **`apps/web`** (Next.js + React + TypeScript): all encryption/decryption happens client-side via libsodium. The server must never see plaintext. The account key is normally held in memory only, but can be persisted across restarts by wrapping it with a non-extractable, per-device WebCrypto key stored in IndexedDB (`apps/web/lib/device-key.ts`): this is a device-local convenience, not a change to the zero-knowledge boundary.
- **`apps/api`** (Rust, Axum): handles auth, storage, rate limiting, encrypted-file-attachment storage, ciphertext-only form membership/invitation authorization, Stripe billing (inert on instances without Stripe configuration), and per-member response notifications. It stores and moves ciphertext only and never decrypts anything.
- **`packages/crypto`** (TypeScript, libsodium-wrappers-sumo plus `@noble/post-quantum` for the hybrid ML-KEM-768 + X25519 KEM): shared key derivation, key wrap/unwrap, account sharing-key creation, and hybrid sealing helpers (see "Sealing to a public key") consumed by `apps/web`.
- **Data layer**: PostgreSQL (ciphertext + metadata), Redis (sessions,
  rate-limiting, and short-lived pending-signup/verification receipts), and
  an S3-compatible object store for encrypted file attachments. The API
  speaks plain S3 (endpoint, region, key pair, bucket; path-style requests).
  Locally that is Garage, chosen over MinIO/SeaweedFS for its footprint and
  wired in via `docker-compose.dev.yml` and the smoke stack, with bootstrap
  documented in `garage.toml.example`. Production points the same five
  `S3_*` variables at an external provider (Backblaze B2 or similar) and
  runs no object store of its own.

Current monorepo layout:
```
apps/{web,api}
packages/crypto
infra/docker/{README.md, docker-compose.dev.yml, docker-compose.yml, docker-compose.prod.yml, docker-compose.dokploy.yml, traefik/traefik.yml, backup.sh, garage.toml.example, .env.prod.example}
```
(`packages/{ui,shared,sdk,types}` remain planned, not yet created. There is no
`infra/nginx` and there will not be: Traefik alone fronts the stack, and nginx
would add a second certificate pipeline for nothing.)

## Non-negotiable design rules

These are the project's guardrails. Every feature decision should be checked against them:

1. **Zero-knowledge is load-bearing, not aspirational.** If a feature requires server-side decryption of user content, it must be redesigned or made an explicit, clearly-labeled opt-in. Never quietly add a server-side decrypt path. Corollary: content validation the server can't perform without decrypting (MIME/magic-number checks, virus scanning, "required field" enforcement) is not achievable server-side by design: don't attempt it; enforce client-side only and document the limitation, as already done for file uploads and required questions. **Minimum password length now belongs on that list**: the server receives a fixed-size verifier, never the password behind it, so it has nothing to measure. The rule is the `minLength={12}` on the signup and recovery forms and nothing else, and `apps/api/src/auth/routes.rs` says so at the top of `register`. Do not "fix" this by sending a length alongside the verifier. A self-reported length is not a check. **Searching responses is on that list too**: the dashboard filters answers it has already decrypted, in the browser (`apps/web/lib/response-search.ts`), and there is no query parameter to add. Sending the query, or an index of what the answers contain, would hand the server the content it is built not to hold, so "search is slow on a large form" is answered inside that file and never by moving the work. The single thing the server stores in the clear is the TOTP secret, which it must read to verify codes; it is an authentication factor rather than form content, so the boundary around responses is unchanged. Do not let that precedent creep.
2. **No invented crypto.** Only libsodium primitives, and only the ones in use: `crypto_secretbox` (XSalsa20-Poly1305) for symmetric encryption and key wrapping, `crypto_pwhash` (Argon2id) for unlock keys, `crypto_generichash` (BLAKE2b) for salts, verifiers and commitments, and X25519 inside the hybrid KEM below. Reaching for a primitive not on this list is a design change, not an implementation detail. Encryption keys are generated client-side; the server only ever stores wrapped/encrypted keys.
   - Argon2id is used in **two independent places**, and they must not be confused. The browser derives unlock keys from the password and from the vault recovery code with `deriveUnlockKey` in `packages/crypto/src/account-key.ts`; the server separately hashes the *verifiers* those unlock keys produce, with parameters pinned in `apps/api/src/password.rs`. Only the browser's derivation protects user content, and its output never leaves the browser. Server-side parameters are pinned rather than left to `Argon2::default()` so a crate upgrade cannot silently change them; raising them is safe because each PHC hash carries its own parameters and verification reads them from the hash.
   - **One named exception to "libsodium primitives only": ML-KEM-768.** Sealing to a public key uses `ml_kem768_x25519` (X-Wing) from `@noble/post-quantum/hybrid.js`, pinned to an exact version in `packages/crypto/package.json`: no caret, because a crypto primitive must not float. The reason for the exception: libsodium ships no post-quantum KEM, and the form public key is genuinely public (`get_form_public` in `apps/api/src/forms/routes.rs` hands it to anyone with the link), so recorded response ciphertext is a harvest-now-decrypt-later target in a way the password-derived layer is not. Two constraints must survive every future edit. **Hybrid only, never bare ML-KEM:** the shared secret depends on both halves, so a total break of ML-KEM leaves the seal exactly as safe as the X25519 sealing it replaced. **Always the library's combiner, never a hand-rolled `HKDF(mlkem ‖ x25519)`:** that is precisely the invented crypto this rule exists to forbid. And be honest about what is being depended on: the library's own README states it **has not been independently audited**; it records one self-audit, by the maintainers, at 0.6.1 in April 2026, and nothing further, while the version pinned here is 0.7.1, past that audit. That is the fact a future reader most needs and the one most likely to be lost in an edit. It also makes no constant-time claim, which carries a constraint on where decapsulation may run; see "Sealing to a public key".
3. **No ORM on the backend.** Rust API uses SQLx with compile-time checked, parameterized SQL only: no string-interpolated queries, ever.
4. **Prefer opaque server-side sessions over JWTs.** Avoid JWT unless there's a specific reason; opaque sessions allow server-side revocation.
5. **IDs are UUIDv7, except where the id is published.** Never expose
   incremental or sequential IDs. v7 is the default because it is
   non-enumerable and keeps primary key inserts at the right edge of the
   B-tree. **An id that appears in a public link uses v4 instead**, which today
   means `forms.id` and nothing else: v7 spends its first 48 bits on a
   millisecond clock, so a form link would tell whoever holds it when the form
   was made, and two links would tell them the order. v4 also leaves 122 random
   bits against v7's 74. The trade is index locality, which is why `responses`
   and `form_members` keep v7.
6. **Never log** passwords, tokens, secrets, keys, PII, or full response bodies: only IDs.
7. **Errors returned to clients are always generic**: never leak stack traces, SQL, filesystem paths, or Rust panics.
8. **Strict CSP with nonces, no `unsafe-eval` in production, no inline JS.** Full security header set (HSTS, Referrer-Policy, Permissions-Policy, X-Frame-Options, COOP/COEP/CORP, X-Content-Type-Options) is mandatory on every response; the static headers come from `headers()` in `apps/web/next.config.ts`, and the CSP alone from Next.js 16 `apps/web/proxy.ts`, which mints a nonce per request and sets the policy on both the request (how Next learns to stamp its own scripts) and the response; the builder lives in `lib/csp.ts` so it can be unit tested. Do not add a CSP to `next.config.ts` as well: two headers are enforced as an intersection and would silently narrow the nonce policy. Two constraints are load-bearing: `'wasm-unsafe-eval'` must stay, or libsodium cannot compile its wasm and every crypto call fails, and the layout must forward the nonce to next-themes, whose flash-prevention script is inline. `lib/csp.ts` adds `'unsafe-eval'` in development only, for the dev server's tooling; a production build never carries it. `style-src` still carries `'unsafe-inline'` because Next injects inline `<style>`; that is a known gap, far smaller than inline script, and worth closing if it becomes possible.
9. **All API responses follow the standard envelope**: `{ "success": bool, "data": {}, "meta": {}, "error": null }`, versioned under `/api/v1/`.
10. **No em-dashes, anywhere.** Not in UI copy, code comments, string
    literals, tests, commit messages or these documents. Do not substitute an
    en-dash or a double hyphen either. Rewrite the sentence instead: commas or
    parentheses around an aside, a period or semicolon between two clauses, a
    colon before an explanation. Hyphens inside compound words such as
    "zero-knowledge" are correct and stay. This is a house style rule rather
    than a security one, but it is enforced the same way: the repository
    currently contains none outside the generated Next block at the end of
    `apps/web/CLAUDE.md`, so grepping the source for U+2014 and
    finding a match elsewhere means a regression.

Every claim in `SECURITY.md` has to stay true of the code: changing a default,
a limit or a header means changing it there in the same commit.

## The account key hierarchy

The password does not wrap form keys, and does not reach the server. A random
32-byte **account key**, generated in the browser (`generateAccountKey` in
`packages/crypto/src/account-key.ts`), sits between them:

```
password      ──Argon2id(vault salt)───────> password unlock key ─┬─ wraps ──> account key
                                                                  └─ BLAKE2b ─> auth verifier ──> API

recovery code ──Argon2id(recovery salt)────> recovery unlock key ─┬─ wraps ──> account key
                                                                  └─ BLAKE2b ─> recovery verifier ──> API

passkey PRF   ──BLAKE2b-256(domain)────────> passkey unlock key ─── wraps ──> account key

account key ──> wraps form data keys, form private keys, and the account sharing private key
```

Four properties to preserve:

- **Salts are derived, not stored.** `deriveVaultSalt`/`deriveRecoverySalt`
  compute `BLAKE2b-128(domain ‖ trimmed, lowercased email)`, so `users.master_key_salt`
  is gone (migration `0015`). A random per-user salt would have to be fetched
  before authentication, and that endpoint is an account-enumeration oracle. A
  salt only has to be unique, not secret. The four domain strings at the top of
  `account-key.ts` are frozen: changing one locks every existing account out.
- **The server receives verifiers, not secrets.** The browser sends
  `BLAKE2b-256(domain ‖ unlock key)` and the API Argon2-hashes *that*
  (`hash_auth_verifier` in `apps/api/src/password.rs`). A logged request body, a
  compromised proxy, or a database dump yields nothing that opens a wrapper.
  This is not a PAKE and does not claim to be: an attacker holding the database
  still cracks a weak password offline by computing `Argon2id(guess)` → verifier
  → compare. It removes the password from the wire and from the server's memory,
  which is what it says on the landing page and no more.
- **Exactly one password and one recovery code wrapper, written in one
  transaction.** `account_key_wrappers` holds `method = 'password'` and
  `method = 'recovery_code'` for every account (plus any passkey rows),
  both inserted by `ensure_verified_user` alongside the `users` row, so "every
  account has a recovery method" is structural rather than a UI convention.
- **Adding a third unlock method is a wrapper, not a re-encryption.** Passkeys
  shipped as exactly that: a `method = 'passkey'` row over the same account
  key, so nothing below it was touched. It still needed migration `0020` for
  the credential table and the widened method constraint; what never changes is
  everything *below* the account key.

## Sealing to a public key

Anonymous response submission, response editing, **response** file
attachments and collaborator grants all seal to a public key. One file in the
`attachments` table deliberately does not: see "The header image is the one
attachment respondents can read" below, and do not generalise this sentence
into "every attachment is sealed". Since the post-quantum work that
is a hybrid KEM-DEM, not `crypto_box_seal`: X-Wing (`ml_kem768_x25519`)
encapsulates a 32-byte shared secret, and `crypto_secretbox` covers the
payload. `packages/crypto/src/seal.ts` is the only implementation:
`sealBox`/`unsealBox` for text, `sealBoxBytes`/`unsealBoxBytes` for file bytes,
one wire format: `K2` tag ‖ 1120-byte KEM ciphertext ‖ 24-byte nonce ‖ AEAD.

**The sizes are the trap.** Bare ML-KEM-768's figures (1184 / 2400 / 1088) are
**not** the hybrid's. The X-Wing public key is **1216** bytes, mirrored
server-side by `SHARING_PUBLIC_KEY_BYTES` in `apps/api/src/sharing/keys.rs`,
so changing the primitive means changing that constant too. KEM ciphertext is
**1120**; shared secret and secret key are both **32**: the secret key is a
compact seed X-Wing expands on demand, which is why wrapped private keys did
not grow.

Six things to preserve:

- **The symmetric layer and account key hierarchy are untouched.** Wrapping is
  still `crypto_secretbox`, unlock keys still Argon2id; both are already
  post-quantum safe at these sizes. No document or copy may imply this work
  changed vault recovery, key wrapping, or the account key.
- **Implicit rejection: `decapsulate` does not throw.** A corrupted KEM
  ciphertext yields a wrong-but-plausible shared secret, so reaching the AEAD
  step is never evidence the blob was intact. The `crypto_secretbox` MAC is the
  only thing that rejects tampering.
- **The tag is compared in the clear and is not authenticated.** Harmless with
  one scheme. The day a second exists, that byte becomes attacker-influenceable
  input selecting a parser, and it must never select a weaker scheme than the
  account is entitled to. `seal.ts` carries the same note; keep both.
- **`SHARING_KEY_VERSION` stays at 1, and version 1 means X-Wing.** No
  version-1 X25519 key survives the clean break, so bumping it would buy
  nothing. Algorithm identity lives in the blob tag; the length check is what
  actually rejects an old key.
- **The form public key is committed to inside the encrypted schema.**
  `forms.form_public_key` is plaintext and served to respondents, so the
  schema carries `publicKeyCommitment`, `formKeyCommitment` of that key
  (BLAKE2b-256 under a frozen domain string in `keys.ts`), and
  `loadPublicForm` refuses a served key that does not match. The schema is
  authenticated by the fragment key the server never sees, which is what makes
  this a check a database writer cannot satisfy. Two rules keep it honest.
  A save must commit to the key derived from the member's own private key
  (`sealPublicKeyFromPrivate`), never to the served one, or it would bless a
  key already swapped. And a schema with no commitment is refused, not
  trusted: only a form written before the check could lack one, and passing
  those would be a way around the check. This shipped strict because no such
  form existed yet; there is no legacy path to add back.
- **The KEM is not constant-time**: the library says so, and JIT, GC and
  `bigint` arithmetic offer no guarantee. This is tolerable only because
  decapsulation runs solely in the user's own browser with the user's own key,
  and `apps/api/src` has no decapsulation path. That used to rest on every
  importer of `apps/web/lib/form-grants.ts` happening to be a `"use client"`
  page, which is an audit obligation on every future import rather than a
  property. Both that module and `apps/web/lib/form-workspace.ts` now carry the
  directive themselves, so calling either from a server component is a build
  error and the constraint holds without anyone having to notice. Keep the
  directive on any module that opens a grant. **Do not move decapsulation
  anywhere an attacker could time it** (a shared worker, a cross-origin
  surface, or any server-side path) without a hardened implementation. The
  residual (a co-resident process on the user's own machine) costs one user
  their own key; a server-side path would cost every account.

## Ciphertext length is padded, and files are not

`crypto_secretbox` is a stream cipher plus a MAC, so a ciphertext is exactly as
long as its plaintext plus a constant. Unpadded, `forms.title_ciphertext`,
`forms.schema_ciphertext` and `responses.ciphertext` each published the length
of what they hold, which distinguishes a ticked checkbox from three paragraphs
and reads roughly how many questions a form asks off the schema column.

`packages/crypto/src/pad.ts` pads to a floor of 1024 bytes, then Padme above
it. The floor is where nearly all the value is: measured across the
development database it put every title, every response and all but one of 939
schemas into a single indistinguishable size, while Padme alone barely pads a
small input at all.

Four things to preserve:

- **The string helpers pad and the byte helpers do not.** `sealBox`,
  `unsealBox`, `encryptWithKey` and `decryptWithKey` carry user content whose
  length is meaningful. `sealBoxBytes` and `encryptBytesWithKey` carry files,
  whose size is already in `attachments.byte_size` because the storage quota is
  counted against it. Padding a file while publishing its size next to it would
  be theatre.
- **Padding lives inside those helpers, never at a call site.** They have well
  over a dozen callers across the web app and the crypto package, and a rule
  spread over every call site is one the next caller will forget.
- **The version byte is inside the AEAD, and the seal tag stays `K2`.** A `K3`
  beside `K2` would create exactly the condition the sealing section warns
  about, where an unauthenticated byte selects a parser, for a reason unrelated
  to the KEM. Under the MAC, flipping it fails the open.
- **`unpad` is strict and has no legacy path.** Anything that is not the exact
  format is an error rather than a fallback to unpadded bytes. This was
  affordable because the change shipped pre-launch and every stored payload was
  deleted rather than migrated. It stops being affordable the moment the
  instance takes a real signup, so do not introduce a second accepted shape.

## The header image is the one attachment respondents can read

A form's header image is stored in the same `attachments` table as a response
attachment and is encrypted the opposite way, which is the whole reason this
section exists.

A response attachment is **sealed to the form public key**, so only a
collaborator holding the private key can open it. That is exactly wrong for a
header image: an anonymous respondent has to see it, and never holds that
private key. It is encrypted with the **schema key** instead, the one in the
link fragment that already decrypts the questions, using
`encryptBytesWithKey`/`decryptBytesWithKey` (the byte forms of the string
helpers, same nonce-then-ciphertext layout). Sealing it to the public key
would produce a header nobody filling in the form could ever render.

Two things guard the public route, and both must survive any edit.

`GET /forms/:id/header-image` takes no session, because a respondent has none.
It authorises on `forms.header_attachment_id`: the bytes are served only when
the caller asks for the attachment that column names. That column is plaintext
for exactly this reason, since the server has to authorise without decrypting
anything. Widening the route to serve any attachment id belonging to the form
would turn a form link into a reader for every response attachment on it.

`update_form` resolves the pointer through a subquery restricted to that
form's own attachments **whose `uploaded_by` is set**, so it cannot be aimed
at another form's object, nor at a respondent's. Uploads are anonymous, so
the server originally had no way to tell a header upload from a response
attachment, and an Editor could name a respondent's sealed file as the header
and have the public route serve its ciphertext to anyone with the link.
Migration `0026` added the column; `upload_attachment` stamps it only when the
request carried a session belonging to a member with edit rights on that
form, which the dashboard's upload does and a respondent's never can. Both
reads report only whether an image exists, never the id.

The theme carries no image reference at all. The form row owns it, so there is
one source of truth rather than two that can disagree, and `FormTheme` no
longer has a `headerImageUrl`: the URL that field held made every respondent's
browser fetch a third party, handing that host their IP on a form that may be
collecting exactly what encryption is for.

## Form sharing and collaboration

Every account initializes one hybrid X-Wing sharing keypair in the browser (`generateSealKeyPair`; see "Sealing to a public key"). The public
key and the private key wrapped under the account key are stored by the
API; the unwrapped private key remains client-memory-only. Owners retain a
`master_wrap_v1` grant, while accepted collaborators receive independent
`account_sealed_box_v1` grants for the form data key and form private key.

Invitations are exact-email capabilities with a seven-day expiry. The emailed
raw token is kept in the URL fragment, exchanged once for a distinct HttpOnly
continuation cookie, and stored by the API only as a SHA-256 hash. Acceptance is
always explicit. A sharing-ready Editor or Viewer can accept while the Owner is
offline. A new account accepts into `awaiting_keys`; the next unlocked Owner
dashboard opens its own grant locally, seals both form keys to the recipient's
current sharing public key, and provisions access without server decryption.

Permissions are membership-backed: only the Owner manages sharing, transfers
ownership, or deletes; Editors can mutate content/settings and read responses;
Viewers can decrypt the form/responses but cannot mutate them. Every mutation
carries `expected_version`; a stale version returns `409 Conflict`, preserves
the later local draft, and is never retried automatically.

**`expected_version` must come from the read the edit was made against.** The
dashboard rename used to fetch a fresh version immediately before its PATCH,
which reads like optimistic concurrency and is the opposite: a rename by
someone else raises the version, the fresh read picks that version up, and the
write then overwrites their change with no conflict raised. `list_forms`
returns `version` for exactly this reason, and the rename sends the version its
list was read at, keeping the version each success returns so a second rename
in the same session is not a phantom conflict. Do not "simplify" any write path
by re-reading the version just before writing.

Removal, leaving, invitation revocation/expiry, and ownership changes revoke
future API access. This revocation is deliberately **not retroactive**: it
cannot erase form keys, ciphertext, or plaintext a collaborator already copied.
Do not describe removal as rotating keys or revoking previously obtained data.

## Subsystem design lives with its code

The design of individual subsystems is in the directory guidance, loaded when
work touches that directory. Read it before changing the subsystem:

- `apps/api/CLAUDE.md`: response notifications and form limits (including the
  single definition of "open"), billing and quotas, the sharing handler
  layout, the two kinds of form authorization, TOTP, passkeys, email
  verification, sessions, password reset with both kinds of recovery code,
  the rate limiter's keys, client addresses behind a proxy, and quizzes (the
  answer key and grades storage).
- `apps/web/CLAUDE.md`: the Classic and Focus layouts and the step machine
  they share, on-device drafts, self-hosted fonts, the respondent-written
  "Other" answer encoding, why the web image carries no domain, and quiz
  mode's member-only scoring.

The one fact from those sections every change must respect is the recovery
guarantee: without the vault recovery code **the vault is permanently
unreadable**, there is no admin-assisted recovery, and adding one would mean
holding key material the server deliberately does not hold.

## The licence is AGPL-3.0-or-later, and that is load-bearing

`LICENSE` holds the canonical text; every manifest declares
`AGPL-3.0-or-later`. Copyleft was chosen for a reason specific to this product
rather than as a default, and a future relicensing discussion should start
from it.

The guarantee krypta makes is that encryption happens in the browser and the
server holds nothing readable. The only way anyone can check that is by
reading the code. Under a permissive licence, someone could take krypta, add
one line that ships the schema key to their server, and run it as a service
with no obligation to say so. Section 13 of the AGPL is what closes that:
running a modified version over a network obliges publishing the
modification. The licence is therefore part of the security argument, not
only the business one.

Two consequences worth keeping in mind. Publishing images carries an
obligation to offer corresponding source, which a public repository at the
tag an image was built from satisfies, and the build provenance already links
the two. And the `build:` path in `docker-compose.prod.yml` is what lets
someone actually exercise the right this licence gives them, which is a
second reason not to remove it.

## Decision filter for new features

Every proposed feature should pass these three questions:
1. Does it preserve end-to-end encryption?
2. Does it keep the interface simple enough that a creator needs no
   instructions to build a form, and a respondent needs none to fill one in?
3. Does it reduce long-term maintenance (favor established libraries/predictable architecture over clever complexity)?

## Commands

Per-service commands and their gotchas live with the code: `apps/api/CLAUDE.md`
and `apps/web/CLAUDE.md`. Services for local work:

```bash
docker compose -f infra/docker/docker-compose.dev.yml up -d   # Postgres, Redis, Garage, Mailpit
```
First time only, `bun run ci:prepare` (or `./scripts/ci.sh prepare`) writes
`garage.toml`, starts the stack, creates the Garage bucket and key, and writes
`apps/api/.env`; it changes nothing on a machine already set up.

### Running the checks

`scripts/ci.sh` is the single definition of what passing means, and
`.github/workflows/ci.yml` invokes it rather than listing steps itself, so CI
and local runs cannot drift. Add a check to the script, not the workflow.

```bash
bun run ci:static       # fmt, clippy, types, lint, unit tests, audits, build; needs `bun run ci:prepare` to have run, because the unit tests open Postgres, Redis and the bucket
bun run ci:integration  # API integration + Playwright; needs `bun run ci:prepare` to have run, plus the API and web dev servers up
bun run ci:images       # build both Docker images and boot each; needs Docker, Postgres and Redis
bun run ci               # static and integration
```

`cargo audit` runs with three advisories explicitly ignored, each with its
reason recorded in the script. Anything not on that list fails, so a new
advisory cannot be absorbed silently; when one is fixed upstream, remove it from
the list rather than leaving it.

### Rate limits will bite you

The limits default to production values. `REGISTER_EMAIL_RATE_LIMIT_PER_HOUR`
and `VERIFY_RATE_LIMIT_PER_MINUTE` are read from the environment on every
start, so raising them in `apps/api/.env` works. **`REGISTER_RATE_LIMIT_PER_HOUR`
and `LOGIN_RATE_LIMIT_PER_MINUTE` only seed `instance_settings` when that row
is first created** (`seed_instance_settings` in `main.rs`, `ON CONFLICT DO
NOTHING`); after that the API reads the database, so change them through
`/api/v1/admin/settings` or the row itself, not `.env`. `ci:integration` also
clears the counters between suites. Even so, ~3 full suite
runs back to back exhaust them, and the e2e fixture registers one account per
worker.

**The symptom is misleading:** registration returns 429, so the session cookie
is never injected, `/auth/me` returns 401, and the test fails at `waitForURL` on
the *next* step rather than at registration. Clear the limit before concluding
anything is broken:

```bash
docker compose -f infra/docker/docker-compose.dev.yml exec redis redis-cli --scan --pattern 'ratelimit:*' | xargs -r docker compose -f infra/docker/docker-compose.dev.yml exec redis redis-cli DEL
```

### Production stack (Traefik)

`infra/docker/docker-compose.prod.yml`, driven by `.env.prod` (template in
`.env.prod.example`) and the Traefik static config in `infra/docker/traefik/`.
Traefik is the only published port: it terminates TLS for one hostname with
Let's Encrypt and routes `/api` to the API and everything else to the web app.
Postgres and Redis sit on an internal network with no host ports.
Attachments go to an external S3-compatible store; Garage is only the dev and
smoke stand-in. `S3_REGION` is configuration because providers such as B2
reject a signing region that does not match the bucket, while R2 requires the
literal `auto`. On a store that versions objects the bucket's lifecycle must
expire hidden versions, or the API's cleanup only ever hides them; R2 has no
versioning, so a delete there is already final.

Two things a future edit would break by accident, plus the client address
rules in `apps/api/CLAUDE.md` ("Client addresses and trusted proxies"):

- **One hostname, path-routed, on purpose.** The session cookie is
  `SameSite=Lax` and the web app calls the API with credentials, so the two
  must be same-site at minimum. Same-origin makes CORS moot, keeps the CSP at
  `connect-src 'self'`, and makes the WebAuthn origin and RP ID one string.
  Splitting the API onto its own subdomain works but buys a second certificate
  and a CORS configuration for nothing.
- **The proxy does not, and cannot, touch encryption.** It forwards ciphertext,
  verifiers and wrapped keys, all of which the API already stores. It must not
  add security headers either: both apps set their own, and a second CSP is
  enforced as an intersection that would silently narrow the nonce policy.

`scripts/ci.sh images` (`bun run ci:images`) builds both images and boots
each one, polling the API's health route and the web app's root; the workflow
runs it as its own job on pushes to `main` and on every pull request.
`.github/workflows/release.yml` builds both again on a `v*` tag and publishes
them to GHCR for amd64 and arm64, writing the tags only after every build
succeeds. Building is necessary and not sufficient for a published image:
the `RUST_LOG` silence recorded in `apps/api/CLAUDE.md` survived a build and
needed a boot to catch, which is why the check boots what it builds.

**Building from source is a supported path, not a fallback.** The compose file
keeps both `image:` and `build:`, defaulting to local names so a clone with
nothing configured builds as it always did. That is deliberate rather than
transitional: this project's claim is that the browser does the encryption, and
someone relying on that has to be able to run code they have read instead of a
binary we handed them. Do not remove the build path to simplify the file.

Operating a deployment (the read-only Docker socket, the project name that
keeps a production run off the dev volumes, the permanent `WEBAUTHN_RP_ID`
choice, `backup.sh` and the uptime probe, container hardening) is the
operator's guide, `infra/docker/README.md`, and is not repeated here.

### One-command full stack (Docker)

`docker compose -f infra/docker/docker-compose.yml up -d` builds and starts
everything including the API and web app; `down` stops it (data persists in
the `krypta-smoke_*` volumes; `-v` wipes them). It is a local smoke stack whose
plaintext SMTP terminates at Mailpit and **must not be reused for
production**. Do not run it alongside `docker-compose.dev.yml` or native
`cargo run`/`bun run dev`: they bind the same host ports (5433, 6379, 3900,
8025, 8080, 3000) and will conflict.
