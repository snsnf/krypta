use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use password_hash::{PasswordHash, SaltString, rand_core::OsRng};

// Argon2id parameters for the server-side login hash, pinned rather than left
// to `Argon2::default()` so that a crate upgrade cannot silently change the
// cost of new hashes. These match the OWASP baseline (19 MiB, 2 iterations,
// 1 lane), which is also the argon2 0.5 default at the time of writing.
//
// Raising them later is safe. Every hash records its own parameters in the PHC
// string and verification reads them from there, so hashes created under the
// old cost keep verifying; only newly written hashes use the values below.
//
// This is *not* the hash that protects user content, and its input is no longer
// a password. The browser derives an unlock key from the password with an
// email-derived salt, then sends BLAKE2b("krypta-auth-verifier-v1" || unlock
// key). The server hashes that verifier. Neither the password nor the unlock
// key reaches this process, so a request log or a database dump yields nothing
// that opens a key wrapper.
//
// Server-side hashing still earns its keep: it stops a database dump yielding a
// replayable bearer credential.
const ARGON2_M_COST_KIB: u32 = 19_456;
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

fn hasher() -> anyhow::Result<Argon2<'static>> {
    let params = Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, None)
        .map_err(|e| anyhow::anyhow!("invalid argon2 params: {e}"))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// The Argon2id primitive, named for what it does rather than for one caller.
///
/// Several unrelated secrets go through it (the login verifier, TOTP recovery
/// codes, and the vault recovery verifier), and only one of them is a verifier
/// in the `packages/crypto` sense. Calling it `hash_auth_verifier` at every
/// site made the other two read as something they are not.
pub fn hash_secret(plain: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = hasher()?
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hashing failed: {e}"))?;
    Ok(hash.to_string())
}

pub fn verify_secret(plain: &str, stored_hash: &str) -> anyhow::Result<bool> {
    let parsed_hash =
        PasswordHash::new(stored_hash).map_err(|e| anyhow::anyhow!("invalid stored hash: {e}"))?;
    // Parameters come from `parsed_hash`, not from this instance, which is what
    // keeps older hashes verifiable after the constants above change.
    Ok(hasher()?
        .verify_password(plain.as_bytes(), &parsed_hash)
        .is_ok())
}

/// The login verifier specifically.
///
/// Argon2id, like everything else here: the name records what the input is,
/// not a different algorithm. That input is already one-way: the browser
/// derives an unlock key from the password, then BLAKE2b over that unlock key
/// produces the verifier this hashes.
pub fn hash_auth_verifier(plain: &str) -> anyhow::Result<String> {
    hash_secret(plain)
}

pub fn verify_auth_verifier(plain: &str, stored_hash: &str) -> anyhow::Result<bool> {
    verify_secret(plain, stored_hash)
}

/// A fixed, valid Argon2id PHC string with no corresponding plaintext.
///
/// Used only to pay the same Argon2 cost on a path with nothing real to
/// verify as a genuine mismatch pays, so response latency cannot tell the two
/// apart. Never used to authorize anything.
const DUMMY_VERIFIER_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$UR4qdOZ2/8spdjlP5vUTeA$R6MS5K8pHMqoF6kJNLfCbRUP8dKc/kbFNpltC1ANnE8";

/// Spends one verification's worth of work and discards the result.
///
/// For the arm of a handler that has no stored hash to check against (no such
/// account, no live recovery code), which would otherwise answer measurably
/// faster than the arm that does, and so tell a caller which one they hit.
pub fn spend_verification_cost(plain: &str) {
    let _ = verify_secret(plain, DUMMY_VERIFIER_HASH);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dummy only equalises timing while it costs what a real hash costs,
    /// and a real hash costs what the constants above say. Raising those
    /// without re-minting the dummy would quietly reopen the oracle.
    #[test]
    fn the_dummy_hash_costs_what_a_real_one_does() {
        let dummy = PasswordHash::new(DUMMY_VERIFIER_HASH).unwrap();
        let real_hash = hash_auth_verifier("anything").unwrap();
        let real = PasswordHash::new(&real_hash).unwrap();
        assert_eq!(dummy.algorithm, real.algorithm);
        assert_eq!(dummy.params, real.params);
    }

    #[test]
    fn hash_then_verify_succeeds() {
        let hash = hash_auth_verifier("correct horse battery staple").unwrap();
        assert!(verify_auth_verifier("correct horse battery staple", &hash).unwrap());
    }

    #[test]
    fn a_wrong_verifier_fails_verification() {
        let hash = hash_auth_verifier("correct horse battery staple").unwrap();
        assert!(!verify_auth_verifier("wrong password", &hash).unwrap());
    }

    #[test]
    fn new_hashes_use_the_pinned_parameters() {
        let hash = hash_auth_verifier("correct horse battery staple").unwrap();
        let parsed = PasswordHash::new(&hash).unwrap();
        assert_eq!(parsed.algorithm.as_str(), "argon2id");
        let params = Params::try_from(&parsed).unwrap();
        assert_eq!(params.m_cost(), ARGON2_M_COST_KIB);
        assert_eq!(params.t_cost(), ARGON2_T_COST);
        assert_eq!(params.p_cost(), ARGON2_P_COST);
    }

    // Guards the upgrade path: raising the constants must not lock out accounts
    // whose verifier was hashed under the old cost.
    #[test]
    fn hashes_made_with_different_parameters_still_verify() {
        let weaker = Params::new(8, 1, 1, None).unwrap();
        let salt = SaltString::generate(&mut OsRng);
        let legacy = Argon2::new(Algorithm::Argon2id, Version::V0x13, weaker)
            .hash_password(b"correct horse battery staple", &salt)
            .unwrap()
            .to_string();

        assert!(verify_auth_verifier("correct horse battery staple", &legacy).unwrap());
        assert!(!verify_auth_verifier("wrong password", &legacy).unwrap());
    }
}
