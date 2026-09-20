import sodium from "libsodium-wrappers-sumo";
import { unwrapKey, wrapKey } from "./wrap";

// Frozen domain-separation strings, joining the four in `account-key.ts` under
// the same rule: changing either one locks every enrolled passkey out of the
// vault, with no migration and no recovery path except the password wrapper.
const PASSKEY_PRF_SALT_DOMAIN = "krypta-passkey-prf-v1";
const PASSKEY_UNLOCK_KEY_DOMAIN = "krypta-passkey-unlock-v1";

const PRF_SALT_BYTES = 32;
const MIN_PRF_OUTPUT_BYTES = 32;

/**
 * The salt the authenticator evaluates. One constant for every user and every
 * credential, deliberately.
 *
 * PRF output is HMAC(credential-unique secret, salt), so the per-credential
 * secret already makes every output distinct and the salt carries no
 * uniqueness burden; the RP ID separates krypta from every other site. It has
 * to be global because a discoverable login has no email until after the
 * assertion returns, so the email-derived pattern `deriveVaultSalt` uses has
 * nothing to derive from at the moment this is needed.
 */
export function passkeyPrfSalt(): Uint8Array {
  return sodium.crypto_generichash(
    PRF_SALT_BYTES,
    sodium.from_string(PASSKEY_PRF_SALT_DOMAIN),
    null
  );
}

/**
 * Turns a PRF output into the key that wraps the account key.
 *
 * No Argon2id here, deliberately. The password and recovery-code paths stretch
 * a low-entropy human secret, which is the entire reason for their cost
 * parameters. A PRF output is already a uniformly random 256 bits from a
 * hardware secret, so stretching it buys nothing and would add a second of
 * delay to every unlock. This is a KDF over a uniform secret, not a password
 * hash, and that distinction is the whole justification.
 */
export function derivePasskeyUnlockKey(prfOutput: Uint8Array): string {
  if (prfOutput.length < MIN_PRF_OUTPUT_BYTES) {
    throw new Error("passkey PRF output is too short to derive an unlock key");
  }
  const input = new Uint8Array([
    ...sodium.from_string(PASSKEY_UNLOCK_KEY_DOMAIN),
    ...prfOutput,
  ]);
  return sodium.to_base64(
    sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, input, null)
  );
}

export function wrapAccountKeyForPasskey(
  accountKeyBase64: string,
  unlockKeyBase64: string
): string {
  return wrapKey(accountKeyBase64, unlockKeyBase64);
}

export function unwrapAccountKeyForPasskey(
  wrappedBase64: string,
  unlockKeyBase64: string
): string {
  return unwrapKey(wrappedBase64, unlockKeyBase64);
}
