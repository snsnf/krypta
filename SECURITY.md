# Security

krypta is an end-to-end encrypted form builder. Everything below describes
what the running code does, not what is planned. Where this document and the
code disagree, the code is right and this document is a bug.

## Reporting a vulnerability

Report privately through the repository's security advisories rather than
opening a public issue, and please include enough detail to reproduce. If you
believe user data is at risk on a running instance, say so in the first line.

You are welcome to test against your own instance. Do not test against
instances you do not operate.

## What krypta guarantees

Form questions, responses, file attachments and form titles are encrypted in
the browser before they are sent. The server stores and moves ciphertext and
holds no key that opens any of it. That is the whole claim, and it is the only
one worth trusting: a database dump, a stolen backup, a compromised host or a
subpoena to the operator yields ciphertext.

The key a respondent's answers are sealed to is committed to inside the
encrypted form, which only the key in the link opens. Someone who can write
the database therefore cannot swap in their own key and read new responses:
the respondent's browser compares the served key with that commitment and
refuses to open the form if they differ, or if the form carries no
commitment at all.

Your password never reaches the server. The browser derives a key from it and
sends a one-way verifier instead, so the password is absent from the wire, from
request logs and from the server's memory.

## What krypta does not protect against

These are real limits, not oversights. Anyone relying on the guarantee above
should read them.

**An operator serving modified JavaScript.** The encryption happens in code the
server delivers. An operator who changes that code could take keys out of the
page before anything is encrypted. No protocol change fixes this. It is the
irreducible limit of browser-delivered end-to-end encryption, and it is why the
licence is AGPL and why building from source is a supported path: you can run
code you have read instead of a binary someone handed you.

**A weak password, once the database leaks.** The server stores an Argon2id
hash of a verifier that is itself derived from the password with Argon2id. An
attacker holding the database can still guess offline: compute the derivation
for a candidate password, compare, repeat. The browser's derivation costs
256 MiB of memory and three passes per guess, and a test pins those numbers so
an upgrade cannot lower them. Strong passwords are still load-bearing.
The signup form requires twelve characters and cannot check more than that,
because the server never receives the password to measure it.

**Losing both your password and your vault recovery code.** There is no
password reset that recovers your data, no administrator who can help, and no
key escrow. The vault becomes permanently unreadable. While you can still sign
in, you can mint a fresh vault recovery code from settings, so losing the code
alone is survivable.

**Content validation.** The server cannot check what it cannot read. There is
no MIME sniffing, no magic-number check and no virus scanning on uploads,
because the bytes arrive already encrypted. "Required" fields and conditional
visibility are enforced in the browser only. Treat downloaded attachments the
way you would treat any file a stranger sent you.

**Collaborator removal is not retroactive.** Removing someone, revoking an
invitation or transferring ownership stops future API access. It cannot erase
keys, ciphertext or plaintext they already copied.

**One response per person.** Submission is anonymous by design, so this is a
browser-side courtesy and nothing more. It is not enforced, and it cannot be
without collecting something identifying.

## What the server can see

Zero knowledge is about content. Some metadata is unavoidable if the service is
to function at all, and pretending otherwise would be dishonest:

- That an account exists for an address, and when it was created. The API never
  confirms this to an unauthenticated caller: registering an address that
  already exists returns the same response as a fresh signup, and only the
  address's real owner learns the difference, by mail.
- When forms and responses were created, and how many of each exist.
- The size of uploaded files, because storage quotas are counted against it.
  Ciphertext lengths for titles, schemas and responses are padded to a floor of
  1024 bytes and then by Padme, so those sizes reveal close to nothing.
- A form's close date and response cap, which are plaintext because a limit the
  server cannot read is a limit it cannot enforce.
- Whether a form is accepting responses, and who collaborates on it in what
  role.
- Whether quiz mode has ever been saved on a form (switching it off keeps the
  encrypted key, so the stored key looks the same whether quiz mode is on or
  off, though grades are only saved while it is on), and when and how many
  times the form's grades have been saved. The correct answers, the points and the
  grades themselves are encrypted under a key derived from the form's private
  key, which respondents never hold, so neither the server nor anyone holding
  the form link can read them.
- Which language (English or Arabic) an account's email is written in, because the
  server has to pick a template before it sends. It is a display preference and
  says nothing about any form or answer.
- TOTP secrets, which must be readable to verify codes. This is an
  authentication factor rather than form content.
- On an instance that bills, each account's plan, its subscription status and
  how many responses it received this month. Payment details stay with Stripe
  and never reach the instance.

## How keys are handled

A random 32-byte account key is generated in the browser and sits between your
password and everything else. It is wrapped separately by each unlock method,
and the wrapped blobs are all the server stores:

- Password: Argon2id over the password produces an unlock key that wraps the
  account key.
- Vault recovery code: the same, from the code printed at signup.
- Passkey: the WebAuthn PRF output, hashed once, wraps the account key.

The account key in turn wraps every form data key, every form private key and
the account's sharing private key. Nothing below it is tied to the password,
which is why recovering an account re-wraps rather than re-encrypts, and why
adding a passkey is a new wrapper rather than a migration.

Salts are derived from the address rather than stored, so no endpoint has to
hand a salt to an unauthenticated caller, which would be an account-enumeration
oracle.

Sealing to a form's public key uses X-Wing, the hybrid of ML-KEM-768 and
X25519, with the payload under XSalsa20-Poly1305. The hybrid is deliberate: a
total break of ML-KEM leaves the seal exactly as safe as the X25519 it
replaced. Worth knowing before you depend on it: the post-quantum library is
pinned to an exact version and its maintainers state it has not been
independently audited. Everything else is libsodium.

## Sessions

Opaque server-side sessions, not JWTs, so they can be revoked. Tokens are 32
random bytes and only their SHA-256 is stored, so a dump of the session store
yields nothing usable. Idle timeout is 30 days, refreshed on use, under a
90-day absolute expiry that refreshing cannot extend.

The cookie is `__Host-session`: `HttpOnly`, `Secure`, `SameSite=Lax`. Logging
in and verifying an address both revoke the session presented with the request
before issuing a new one, which closes session fixation. Sessions are indexed
per user so they can all be revoked at once.

Vault recovery mints a separate, narrower session that reaches one endpoint and
expires in 15 minutes, and whose lifetime is deliberately not renewed on use.

## Transport and headers

Every API response carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Strict-Transport-Security` for two years including
subdomains, `Referrer-Policy: no-referrer`, a `Permissions-Policy` denying
geolocation, microphone and camera, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Resource-Policy` and `Cross-Origin-Embedder-Policy`, and a
`Content-Security-Policy` of `default-src 'none'; frame-ancestors 'none'`.

The web app mints a fresh nonce per request and serves a strict CSP with no
`unsafe-eval` and no inline script. Two details are worth stating plainly:
`wasm-unsafe-eval` is present because libsodium compiles WebAssembly and
nothing encrypts without it, and `style-src` still allows inline styles because
the framework injects them. The second is a known gap, much smaller than inline
script would be, and it will be closed when it can be. Web pages also carry the
same `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` and
`Cross-Origin-Embedder-Policy` as the API, and their image policy names no
other host: images come from the instance itself, from inline `data:` URIs,
or from object URLs for images decrypted in the page.

No page loads anything from a third party. Fonts are served from the instance's
own origin rather than from Google, and forms carry no remote image, so opening
a form tells nobody but the instance you opened it. Emails behave the same way:
no images, no web fonts, no tracking pixel.

## Rate limits

Redis-backed, applied before the work they protect. The per-form limits are
fixed; the rest are defaults an operator can change:

| Action | Limit |
|---|---|
| Registration | 5 per hour per address, 5 per hour per IP |
| Login | 5 per minute per address, counted separately for each IP |
| Verification code entry | 10 per minute |
| TOTP code checks | 10 per minute per account |
| Passkey ceremonies | 10 per minute |
| Vault recovery start | 5 per hour |
| Vault recovery verify | 5 per minute |
| Invitations sent | 20 per hour and 100 per day per sender, 3 per hour per recipient |
| Invitation continuation | 30 per hour |
| Response submission | 20 per minute per source per form, and 100 per minute per form |
| Attachment upload | 5 per minute per source per form |
| Opening a form | 600 per minute per source per form |
| Header image download | 600 per minute per source per form |
| Editing a submitted response | 10 per minute per source per form |

Six-digit codes are additionally single-use and consumed on any attempt, and a
wrong TOTP code forces the password step again rather than allowing repeated
guesses.

Behind a proxy, the client address is read from `X-Forwarded-For` only when the
connecting peer is inside the configured trusted-proxy range or is a proxy
named in the configuration, and then only the rightmost address that is not
itself a trusted proxy. A named proxy is trusted only while its name resolves
to a single container, so another container on a shared network cannot become
trusted by taking the same name. With no range and no proxy name configured,
the header is ignored entirely. Never set that range to `0.0.0.0/0`: every
caller could then invent an address per request and the limits would stop
existing.

## Uploads

Attachments are encrypted in the browser and uploaded as ciphertext to an
S3-compatible store. A single attachment is capped a little above 10 MiB, a
form holds at most 20 attachments and 100 MiB, and the request body limit sits
just above the per-file cap. Accounts have their own storage quota on top.
An upload that no submitted response references is reclaimed 31 days after it
finished, one day past the lifetime of the respondent's saved draft, so an
abandoned upload stops holding the form's slots and the owner's quota. A
response submission or edit is capped at 512 KiB.
Stored objects are named by identifier, never by the uploaded filename: the
name a respondent chose is part of the encrypted payload and never reaches the
object store. Nothing served from the store is executable.

A form's header image is the one deliberate exception to sealing: respondents
have to see it, so it is encrypted with the schema key that already decrypts
the questions, and the public route serves only the single attachment the form
row names.

## Database and logging

All SQL is parameterized and checked at compile time. There is no ORM and no
string-interpolated query. Identifiers are UUIDv7, except a form's own id,
which is v4 because it appears in a public link and a v7 would leak the
creation time and the order of creation.

Logs carry identifiers only. Passwords, tokens, secrets, keys, personal data
and request bodies are never logged, and errors returned to clients are generic
so they cannot leak stack traces, SQL or paths.

## Deployment

Operator-facing hardening, including container privileges, network exposure,
backups and the trusted-proxy setting, is documented in
[`infra/docker/README.md`](infra/docker/README.md).
