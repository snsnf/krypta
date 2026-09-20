import sodium from "libsodium-wrappers-sumo";
import { generateSymmetricKey } from "./keys";
import { unwrapKey, wrapKey } from "./wrap";

// Frozen domain-separation strings. Changing any of these invalidates every
// existing account, so they are versioned rather than edited.
const VAULT_SALT_DOMAIN = "krypta-vault-salt-v1";
const RECOVERY_SALT_DOMAIN = "krypta-recovery-salt-v1";
const AUTH_VERIFIER_DOMAIN = "krypta-auth-verifier-v1";
const RECOVERY_VERIFIER_DOMAIN = "krypta-recovery-verifier-v1";

const VERIFIER_BYTES = 32;

function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Salts are derived from the email rather than stored at random. A salt only
 * has to be unique per user, not secret: the server hands it out at login
 * anyway. Deriving it avoids a pre-authentication lookup endpoint, which would
 * be an account-enumeration oracle.
 */
function deriveSalt(domain: string, email: string): string {
  const input = sodium.from_string(domain + canonicalEmail(email));
  return sodium.to_base64(
    sodium.crypto_generichash(sodium.crypto_pwhash_SALTBYTES, input, null)
  );
}

export function deriveVaultSalt(email: string): string {
  return deriveSalt(VAULT_SALT_DOMAIN, email);
}

export function deriveRecoverySalt(email: string): string {
  return deriveSalt(RECOVERY_SALT_DOMAIN, email);
}

/** Argon2id at the same MODERATE cost the vault key has always used. */
export async function deriveUnlockKey(
  secret: string,
  saltBase64: string
): Promise<string> {
  await sodium.ready;
  const salt = sodium.from_base64(saltBase64);
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    secret,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  return sodium.to_base64(key);
}

/**
 * One-way. The server authenticates against this, so a logged request body,
 * a compromised proxy, or a database dump yields nothing that opens a wrapper.
 * One BLAKE2b rather than a second Argon2, so the login path stays single-cost.
 */
function deriveVerifier(domain: string, unlockKeyBase64: string): string {
  const input = new Uint8Array([
    ...sodium.from_string(domain),
    ...sodium.from_base64(unlockKeyBase64),
  ]);
  return sodium.to_base64(sodium.crypto_generichash(VERIFIER_BYTES, input, null));
}

export function deriveAuthVerifier(unlockKeyBase64: string): string {
  return deriveVerifier(AUTH_VERIFIER_DOMAIN, unlockKeyBase64);
}

export function deriveRecoveryVerifier(unlockKeyBase64: string): string {
  return deriveVerifier(RECOVERY_VERIFIER_DOMAIN, unlockKeyBase64);
}

export function generateAccountKey(): string {
  return generateSymmetricKey();
}

export function wrapAccountKey(
  accountKeyBase64: string,
  unlockKeyBase64: string
): string {
  return wrapKey(accountKeyBase64, unlockKeyBase64);
}

export function unwrapAccountKey(
  wrappedBase64: string,
  unlockKeyBase64: string
): string {
  return unwrapKey(wrappedBase64, unlockKeyBase64);
}
