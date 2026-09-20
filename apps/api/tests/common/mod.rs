//! Shared helpers for the integration suites.
//!
//! Registration is two steps now, so every suite that needs an account has to
//! read a code out of mailpit. This module is the one place that knows how.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use blake2::Blake2bVar;
use blake2::digest::VariableOutput;
use redis::AsyncCommands;
use reqwest::Client;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use totp_rs::Totp;
use uuid::Uuid;

/// Not every suite that pulls in this module calls this directly (some keep
/// their own local wrapper), so it is allowed to sit unused in those binaries.
#[allow(dead_code)]
pub fn base_url() -> String {
    std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string())
}

pub fn mailpit_url() -> String {
    std::env::var("TEST_MAILPIT_BASE").unwrap_or_else(|_| "http://localhost:8025".to_string())
}

/// The most recent verification code mailed to `email`.
///
/// Panics rather than returning an error: a missing mail means the suite
/// cannot proceed, and a panic points at the right line.
pub async fn latest_code_for(email: &str) -> String {
    latest_delivery_for(email).await.1
}

/// Most recent Mailpit message id and verification code for an address.
///
/// Response notifications now mail the same addresses these suites use, so
/// the newest message is not guaranteed to be a verification mail. A message
/// without a six-digit code is an ordinary, expected thing to skip; it is
/// checked newest-first and the first one that carries a code wins.
#[allow(dead_code)]
pub async fn latest_delivery_for(email: &str) -> (String, String) {
    let client = Client::new();
    let search = format!("{}/api/v1/search?query=to:{email}", mailpit_url());

    // Mail delivery is not instant. Poll briefly rather than sleeping a fixed
    // amount, so a fast machine is not punished and a slow one still passes.
    for _ in 0..40 {
        let body: serde_json::Value = client
            .get(&search)
            .send()
            .await
            .expect("mailpit is not reachable: is the mailpit container up?")
            .json()
            .await
            .unwrap();
        if let Some(messages) = body["messages"].as_array() {
            for summary in messages {
                let Some(id) = summary["ID"].as_str() else {
                    continue;
                };
                let message: serde_json::Value = client
                    .get(format!("{}/api/v1/message/{id}", mailpit_url()))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                let text = message["Text"].as_str().unwrap_or_default();
                if let Some(code) = first_six_digits(text) {
                    return (id.to_string(), code);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("no mail arrived for {email} within 4 seconds");
}

#[allow(dead_code)]
pub async fn next_delivery_for(email: &str, previous_id: &str) -> (String, String) {
    for _ in 0..40 {
        let delivery = latest_delivery_for(email).await;
        if delivery.0 != previous_id {
            return delivery;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("no new mail arrived for {email} within 4 seconds");
}

#[allow(dead_code)]
pub async fn delivery_count_for(email: &str) -> usize {
    let body: serde_json::Value = Client::new()
        .get(format!("{}/api/v1/search?query=to:{email}", mailpit_url()))
        .send()
        .await
        .expect("mailpit is not reachable: is the mailpit container up?")
        .json()
        .await
        .unwrap();
    body["messages"].as_array().map_or(0, Vec::len)
}

/// The opaque token in the most recent invitation mailed to `email`.
///
/// The token is intentionally returned only to the caller and never included
/// in panic or assertion output.
#[allow(dead_code)]
pub async fn latest_invitation_token_for(email: &str) -> String {
    latest_invitation_delivery_for(email).await.1
}

#[allow(dead_code)]
pub async fn latest_invitation_delivery_for(email: &str) -> (String, String) {
    invitation_delivery_after(email, None).await
}

#[allow(dead_code)]
pub async fn next_invitation_delivery_for(email: &str, previous_id: &str) -> (String, String) {
    invitation_delivery_after(email, Some(previous_id)).await
}

async fn invitation_delivery_after(email: &str, previous_id: Option<&str>) -> (String, String) {
    let client = Client::new();
    let search = format!("{}/api/v1/search?query=to:{email}", mailpit_url());

    for _ in 0..40 {
        let body: serde_json::Value = client
            .get(&search)
            .send()
            .await
            .expect("mailpit is not reachable: is the mailpit container up?")
            .json()
            .await
            .unwrap();
        if let Some(id) = body["messages"][0]["ID"].as_str()
            && previous_id != Some(id)
        {
            let message: serde_json::Value = client
                .get(format!("{}/api/v1/message/{id}", mailpit_url()))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let text = message["Text"].as_str().unwrap_or_default();
            if let Some(start) = text.find("#token=") {
                let token = text[start + "#token=".len()..]
                    .chars()
                    .take_while(|character| {
                        character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
                    })
                    .collect::<String>();
                if !token.is_empty() {
                    return (id.to_string(), token);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("no new invitation mail arrived within 4 seconds");
}

fn pending_key(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("pending_signup:{:x}", hasher.finalize())
}

async fn test_redis() -> redis::aio::ConnectionManager {
    let url =
        std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    let client = redis::Client::open(url).unwrap();
    redis::aio::ConnectionManager::new(client).await.unwrap()
}

#[allow(dead_code)]
pub async fn pending_record(token: &str) -> Option<serde_json::Value> {
    let mut redis = test_redis().await;
    let raw: Option<String> = redis.get(pending_key(token)).await.unwrap();
    raw.map(|value| serde_json::from_str(&value).unwrap())
}

#[allow(dead_code)]
pub async fn make_resend_eligible(token: &str) {
    let mut redis = test_redis().await;
    let key = pending_key(token);
    let raw: String = redis.get(&key).await.unwrap();
    let mut record: serde_json::Value = serde_json::from_str(&raw).unwrap();
    record["last_sent_at"] = json!("2000-01-01T00:00:00Z");
    record["last_sent_at_unix"] = json!(946_684_800);
    let updated = serde_json::to_string(&record).unwrap();
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg(updated)
        .arg("KEEPTTL")
        .query_async(&mut redis)
        .await
        .unwrap();
}

#[allow(dead_code)]
pub async fn pending_ttl(token: &str) -> i64 {
    let mut redis = test_redis().await;
    redis.ttl(pending_key(token)).await.unwrap()
}

fn first_six_digits(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    chars
        .windows(6)
        .find(|w| w.iter().all(|c| c.is_ascii_digit()))
        .map(|w| w.iter().collect())
}

// libsodium's `crypto_pwhash` MODERATE preset, which is what `deriveUnlockKey`
// in packages/crypto uses. These must match exactly or no test can log in.
const ARGON2_OPSLIMIT_MODERATE: u32 = 3;
const ARGON2_MEMLIMIT_MODERATE_KIB: u32 = 262_144; // 256 MiB

// Frozen domain-separation strings, mirroring packages/crypto/src/account-key.ts.
const VAULT_SALT_DOMAIN: &str = "krypta-vault-salt-v1";
const AUTH_VERIFIER_DOMAIN: &str = "krypta-auth-verifier-v1";

/// libsodium's `crypto_generichash`: BLAKE2b, unkeyed, variable output length.
fn blake2b(out_len: usize, input: &[u8]) -> Vec<u8> {
    let mut hasher = Blake2bVar::new(out_len).expect("valid blake2b length");
    blake2::digest::Update::update(&mut hasher, input);
    let mut out = vec![0u8; out_len];
    hasher
        .finalize_variable(&mut out)
        .expect("valid output buffer");
    out
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn derive_salt(domain: &str, email: &str) -> Vec<u8> {
    blake2b(
        16,
        format!("{domain}{}", email.trim().to_lowercase()).as_bytes(),
    )
}

fn derive_unlock_key(secret: &str, salt: &[u8]) -> Vec<u8> {
    let params = Params::new(
        ARGON2_MEMLIMIT_MODERATE_KIB,
        ARGON2_OPSLIMIT_MODERATE,
        1,
        Some(32),
    )
    .expect("valid argon2 params");
    let mut key = vec![0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(secret.as_bytes(), salt, &mut key)
        .expect("argon2 derivation");
    key
}

/// The value the browser actually sends to the auth endpoints.
///
/// Each derivation allocates 256 MiB and takes a noticeable fraction of a
/// second, and suites log the same account in repeatedly, so results are
/// memoised per (email, password).
#[allow(dead_code)]
pub fn auth_verifier(email: &str, password: &str) -> String {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (email.trim().to_lowercase(), password.to_string());
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return hit.clone();
    }

    let unlock_key = derive_unlock_key(password, &derive_salt(VAULT_SALT_DOMAIN, email));
    let mut input = AUTH_VERIFIER_DOMAIN.as_bytes().to_vec();
    input.extend_from_slice(&unlock_key);
    let verifier = b64(&blake2b(32, &input));

    cache.lock().unwrap().insert(key, verifier.clone());
    verifier
}

/// A well-formed but meaningless password wrapper.
///
/// `crypto_secretbox` over a 32-byte key is a 24-byte nonce, the 32 bytes, and
/// a 16-byte tag. The server validates that length and stores the blob; it can
/// never open one, so the suites do not need real ciphertext here, only bytes
/// the API will accept and hand back unchanged. The browser is the only place
/// a genuine wrapper is produced, and `apps/web/e2e/fixtures.ts` does exactly
/// that with `@krypta/crypto`.
#[allow(dead_code)]
pub fn opaque_wrapped_account_key() -> String {
    let mut bytes = [0u8; WRAPPED_ACCOUNT_KEY_BYTES];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    b64(&bytes)
}

/// 24-byte nonce + 32-byte key + 16-byte Poly1305 tag.
#[allow(dead_code)]
pub const WRAPPED_ACCOUNT_KEY_BYTES: usize = 24 + 32 + 16;

/// A well-formed but meaningless verifier.
///
/// Vault recovery verifiers are 32 bytes, like auth verifiers, and the server
/// only shape-checks then Argon2-hashes them. Nothing in these suites redeems a
/// vault recovery code, so random bytes are exactly as useful here as a real
/// `deriveRecoveryVerifier` output would be, and the real one is only
/// producible in the browser.
#[allow(dead_code)]
pub fn opaque_verifier() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    b64(&bytes)
}

/// An account the suites can authenticate as.
///
/// The password is kept alongside the verifier because a test that rotates a
/// credential has to re-derive, and because the value is what a person would
/// type; the server never sees it.
#[allow(dead_code)]
pub struct TestAccount {
    pub user_id: Uuid,
    pub email: String,
    pub password: String,
    pub verifier: String,
    /// Exactly what was sent as `wrapped_account_key_password` at signup, so a
    /// test can assert the API hands the same bytes back.
    pub wrapped_account_key: String,
    /// Exactly what was sent as `wrapped_account_key_recovery` at signup. The
    /// API stores it and never hands it back on an authenticated response;
    /// only a recovery unlock reads it.
    pub wrapped_account_key_recovery: String,
    /// The verifier sent at signup. The stored value is an Argon2 hash of it,
    /// so this is not what a database row contains.
    pub recovery_verifier: String,
}

#[allow(dead_code)]
impl TestAccount {
    /// The same account with a different password and its derived verifier.
    pub fn rotated(&self, new_password: &str) -> TestAccount {
        TestAccount {
            user_id: self.user_id,
            email: self.email.clone(),
            password: new_password.to_string(),
            verifier: auth_verifier(&self.email, new_password),
            wrapped_account_key: self.wrapped_account_key.clone(),
            wrapped_account_key_recovery: self.wrapped_account_key_recovery.clone(),
            recovery_verifier: self.recovery_verifier.clone(),
        }
    }
}

/// Registers and verifies in one call, leaving `client` holding the session
/// cookie.
pub async fn register_test_account(
    base: &str,
    client: &Client,
    email: &str,
    password: &str,
) -> TestAccount {
    let verifier = auth_verifier(email, password);
    let register: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/register"))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending_token = register["data"]["pending_token"]
        .as_str()
        .unwrap_or_else(|| panic!("register returned no pending token: {register}"));

    let code = latest_code_for(email).await;
    let wrapped_account_key = opaque_wrapped_account_key();
    let wrapped_account_key_recovery = opaque_wrapped_account_key();
    let recovery_verifier = opaque_verifier();
    let verify: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/verify-email"))
        .json(&json!({
            "pending_token": pending_token,
            "code": code,
            "wrapped_account_key_password": wrapped_account_key,
            "wrapped_account_key_recovery": wrapped_account_key_recovery,
            "recovery_verifier": recovery_verifier,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let user_id = verify["data"]["user_id"]
        .as_str()
        .unwrap_or_else(|| panic!("verify-email returned no user id: {verify}"))
        .parse()
        .unwrap();
    // `/auth/verify-email` is one of `auth_success`'s callers, and signup has
    // nothing to bootstrap a vault from unless it echoes the wrapper back.
    assert_eq!(
        verify["data"]["wrapped_account_key"].as_str(),
        Some(wrapped_account_key.as_str()),
        "verify-email did not echo the password wrapper",
    );

    TestAccount {
        user_id,
        email: email.to_string(),
        password: password.to_string(),
        verifier,
        wrapped_account_key,
        wrapped_account_key_recovery,
        recovery_verifier,
    }
}

/// The password every suite registers its accounts with.
#[allow(dead_code)]
pub const TEST_PASSWORD: &str = "correct horse battery staple";

/// A fresh password proof for the account `client` is authenticated as.
///
/// Enrolling a second factor requires one, so a stolen session alone cannot
/// add a gate that locks the real owner out.
#[allow(dead_code)]
pub async fn reauthentication_receipt(base: &str, client: &Client, password: &str) -> String {
    let me: serde_json::Value = client
        .get(format!("{base}/api/v1/auth/me"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let email = me["data"]["email"]
        .as_str()
        .expect("an authenticated client");
    let response = client
        .post(format!("{base}/api/v1/auth/reauthenticate"))
        .json(&json!({ "verifier": auth_verifier(email, password) }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "reauthenticate was refused");
    response.json::<serde_json::Value>().await.unwrap()["data"]["reauthentication_receipt"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Enrols TOTP on the account `client` is authenticated as.
///
/// Returns the authenticator rebuilt from the provisioning URI the server
/// issued, so tests prove the URI a user scans really does produce codes the
/// server accepts.
#[allow(dead_code)]
pub async fn enrol_totp(base: &str, client: &Client) -> Totp {
    let setup: serde_json::Value = client
        .post(format!("{base}/api/v1/auth/2fa/setup"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let uri = setup["data"]["provisioning_uri"]
        .as_str()
        .unwrap_or_else(|| panic!("2fa/setup returned no provisioning uri: {setup}"));
    let totp = authenticator_from(uri);

    let enable = client
        .post(format!("{base}/api/v1/auth/2fa/enable"))
        .json(&json!({
            "code": code_now(&totp),
            "reauthentication_receipt": reauthentication_receipt(base, client, TEST_PASSWORD).await,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(enable.status(), 200, "2fa/enable was refused");
    totp
}

/// Rebuilds the authenticator from a provisioning URI.
#[allow(dead_code)]
pub fn authenticator_from(uri: &str) -> Totp {
    Totp::from_url(uri).expect("server issued a parseable otpauth uri")
}

#[allow(dead_code)]
pub fn code_now(totp: &Totp) -> String {
    totp.generate_current().to_string()
}

/// Waits for the next timestep before producing a code.
///
/// Enrolment consumes the step its confirmation code belonged to, so a code
/// taken from that same step is a replay and is rejected by design. Tests that
/// mean to exercise a valid login have to cross the boundary first.
#[allow(dead_code)]
pub async fn code_from_next_step(totp: &Totp) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    tokio::time::sleep(std::time::Duration::from_secs(30 - (now % 30) + 1)).await;
    code_now(totp)
}

/// Starts a recovery and returns the pending handle.
#[allow(dead_code)]
pub async fn recover_start(base: &str, email: &str) -> (reqwest::StatusCode, String) {
    let response = Client::new()
        .post(format!("{base}/api/v1/auth/recover/start"))
        .json(&json!({ "email": email }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap();
    let token = body["data"]["pending_token"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    (status, token)
}

/// Presents every recovery factor. The caller owns the client, so a test can
/// choose whether the recovery session lands in a cookie jar.
#[allow(dead_code)]
pub async fn recover_verify(
    base: &str,
    client: &Client,
    pending_token: &str,
    email_code: &str,
    recovery_verifier: &str,
    totp_code: Option<String>,
) -> reqwest::Response {
    let mut body = json!({
        "pending_token": pending_token,
        "email_code": email_code,
        "recovery_verifier": recovery_verifier,
    });
    if let Some(code) = totp_code {
        body["totp_code"] = json!(code);
    }
    client
        .post(format!("{base}/api/v1/auth/recover/verify"))
        .json(&body)
        .send()
        .await
        .unwrap()
}

/// Drives the real `/auth/recover/start` + `/auth/recover/verify` pair and
/// returns the recovery-scoped session token.
///
/// This replaces an earlier stub that wrote a session record straight into
/// Redis: a test built on a hand-made record proves something about that
/// record's shape, not about what the endpoint actually mints.
#[allow(dead_code)]
pub async fn recovery_session_for(
    base: &str,
    account: &TestAccount,
    totp: Option<&Totp>,
) -> String {
    let (status, pending_token) = recover_start(base, &account.email).await;
    assert_eq!(status, 200, "recover/start was refused");
    let code = latest_code_for(&account.email).await;

    let totp_code = match totp {
        Some(totp) => Some(code_from_next_step(totp).await),
        None => None,
    };
    // No cookie jar: the token is returned to the caller rather than left
    // implicit, so a test can present it deliberately and in isolation.
    let response = recover_verify(
        base,
        &Client::builder().build().unwrap(),
        &pending_token,
        &code,
        &account.recovery_verifier,
        totp_code,
    )
    .await;
    assert_eq!(response.status(), 200, "recover/verify was refused");

    session_cookie_value(&response).expect("recover/verify set no session cookie")
}

/// The `__Host-session` value a response sets, if any.
#[allow(dead_code)]
pub fn session_cookie_value(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            value
                .strip_prefix("__Host-session=")
                .map(|rest| rest.split(';').next().unwrap_or_default().to_string())
        })
        .filter(|token| !token.is_empty())
}
