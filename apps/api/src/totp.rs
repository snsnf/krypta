use rand::RngCore;
use redis::{AsyncCommands, aio::ConnectionManager};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use totp_rs::{Algorithm, Builder, Totp};
use uuid::Uuid;

const ISSUER: &str = "krypta";
const SECRET_BYTES: usize = 20;
const RECOVERY_CODE_COUNT: usize = 8;
/// How long a used timestep is remembered. Two steps of skew are accepted, so
/// the window has to outlive them or a replay could land after expiry.
const REPLAY_MEMORY_SECS: i64 = 120;

pub fn generate_secret() -> Vec<u8> {
    let mut bytes = vec![0u8; SECRET_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
}

fn totp_for(secret: &[u8], account: &str) -> anyhow::Result<Totp> {
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        // One step of skew either side: enough for clock drift, small enough
        // that a stolen code is not usable for long.
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(secret.to_vec())
        .with_issuer(Some(ISSUER))
        .with_account_name(account)
        .build()
        .map_err(|e| anyhow::anyhow!("invalid totp configuration: {e}"))
}

/// The `otpauth://` URI an authenticator app scans.
pub fn provisioning_uri(secret: &[u8], account: &str) -> anyhow::Result<String> {
    totp_for(secret, account)?
        .to_url()
        .map_err(|e| anyhow::anyhow!("could not build provisioning uri: {e}"))
}

/// The same URI as a PNG data URI, rendered here so the browser needs no QR
/// library and the secret never has to be laid out in the DOM to be scanned.
pub fn provisioning_qr(secret: &[u8], account: &str) -> anyhow::Result<String> {
    let png = totp_for(secret, account)?
        .to_qr_base64()
        .map_err(|e| anyhow::anyhow!("could not render qr: {e}"))?;
    Ok(format!("data:image/png;base64,{png}"))
}

/// Checks `code` against `secret`, rejecting a code already used this timestep.
///
/// Without the replay check, a code observed in transit stays valid for the rest
/// of its 30-second step, which is the whole window an attacker needs.
pub async fn verify_code(
    redis: &mut ConnectionManager,
    user_id: Uuid,
    secret: &[u8],
    account: &str,
    code: &str,
) -> anyhow::Result<bool> {
    let totp = totp_for(secret, account)?;
    // Some(step) when the code is valid; the step is what gets claimed below, so
    // the whole 30-second window is consumed rather than just this digit string.
    let Some(step) = totp.check_current(code) else {
        return Ok(false);
    };

    // SET NX on the accepted step: the first use wins, later ones are replays.
    let key = format!("totp_used:{user_id}:{step}");
    let claimed: bool = redis
        .set_options(
            &key,
            1,
            redis::SetOptions::default()
                .conditional_set(redis::ExistenceCheck::NX)
                .with_expiration(redis::SetExpiry::EX(REPLAY_MEMORY_SECS as u64)),
        )
        .await?;

    Ok(claimed)
}

/// How long the password step stays redeemable for a code. Long enough to open
/// an authenticator app, short enough that a leaked handle is near-useless.
const PENDING_TTL_SECS: u64 = 300;

fn pending_key(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("totp_pending:{:x}", hasher.finalize())
}

#[derive(Serialize, Deserialize)]
pub struct PendingLogin {
    pub user_id: Uuid,
    pub generation: i64,
}

/// Issues the handle that ties the password step to the code step.
///
/// No session exists until the code is accepted, so a stolen password alone
/// gains nothing: this handle only permits presenting a code.
pub async fn create_pending(
    redis: &mut ConnectionManager,
    user_id: Uuid,
    generation: i64,
) -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);
    let value = serde_json::to_string(&PendingLogin {
        user_id,
        generation,
    })?;
    let _: () = redis
        .set_ex(pending_key(&token), value, PENDING_TTL_SECS)
        .await?;
    Ok(token)
}

/// Redeems a pending handle, consuming it so a single password step cannot be
/// used to brute-force codes indefinitely.
pub async fn take_pending(
    redis: &mut ConnectionManager,
    token: &str,
) -> anyhow::Result<Option<PendingLogin>> {
    // GETDEL rather than GET then DEL: two verify requests racing on the same
    // handle must not both read it, or one password step buys two code
    // guesses instead of the one the design allows.
    let key = pending_key(token);
    let value: Option<String> = redis.get_del(&key).await?;
    let Some(value) = value else { return Ok(None) };
    Ok(serde_json::from_str(&value).ok())
}

/// Plaintext codes for the user to store, paired with hashes for the database.
///
/// Returned once at enrolment and never recoverable afterwards, which is why the
/// caller has to surface them immediately.
pub fn generate_recovery_codes() -> anyhow::Result<Vec<(String, String)>> {
    let mut out = Vec::with_capacity(RECOVERY_CODE_COUNT);
    for _ in 0..RECOVERY_CODE_COUNT {
        let mut bytes = [0u8; 10];
        rand::thread_rng().fill_bytes(&mut bytes);
        // Crockford-ish alphabet: no look-alike characters to mistype.
        const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";
        let code: String = bytes
            .iter()
            .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
            .collect();
        let formatted = format!("{}-{}", &code[..5], &code[5..]);
        // A TOTP recovery code is *not* a verifier: it is a server-generated
        // string typed straight into the login form, and it never passes through
        // the browser derivation that produces `krypta-auth-verifier-v1` or
        // `krypta-recovery-verifier-v1`. It restores account access and cannot
        // decrypt anything.
        let hash = crate::password::hash_secret(&formatted)?;
        out.push((formatted, hash));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisioning_uri_names_the_issuer_and_account() {
        let secret = generate_secret();
        let uri = provisioning_uri(&secret, "someone@example.com").unwrap();
        assert!(uri.starts_with("otpauth://totp/"));
        assert!(uri.contains("issuer=krypta"));
        assert!(uri.contains("someone%40example.com"));
    }

    #[test]
    fn secrets_differ_between_calls() {
        assert_ne!(generate_secret(), generate_secret());
    }

    #[test]
    fn recovery_codes_are_unique_and_verify_against_their_hash() {
        let codes = generate_recovery_codes().unwrap();
        assert_eq!(codes.len(), RECOVERY_CODE_COUNT);

        let plaintexts: std::collections::HashSet<_> =
            codes.iter().map(|(c, _)| c.clone()).collect();
        assert_eq!(
            plaintexts.len(),
            RECOVERY_CODE_COUNT,
            "codes must be unique"
        );

        for (code, hash) in &codes {
            assert!(crate::password::verify_auth_verifier(code, hash).unwrap());
            assert!(!crate::password::verify_auth_verifier("WRONG-CODE1", hash).unwrap());
        }
    }
}
