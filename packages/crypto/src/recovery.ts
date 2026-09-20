import sodium from "libsodium-wrappers-sumo";
import { encodeBase32, normalizeBase32 } from "./base32";
import { deriveRecoverySalt, deriveUnlockKey } from "./account-key";

// 20 bytes is 160 bits and encodes to exactly 32 base32 characters.
const RECOVERY_CODE_BYTES = 20;
const RECOVERY_CODE_LENGTH = 32;
const GROUP_SIZE = 4;

const RECOVERY_UNLOCK_DOMAIN = "krypta-recovery-unlock-v1";

export function generateRecoveryCode(): string {
  const bytes = sodium.randombytes_buf(RECOVERY_CODE_BYTES);
  return encodeBase32(bytes)
    .match(new RegExp(`.{1,${GROUP_SIZE}}`, "g"))!
    .join("-");
}

export function normalizeRecoveryCode(input: string): string {
  const normalized = normalizeBase32(input);
  if (normalized.length !== RECOVERY_CODE_LENGTH) {
    throw new Error("invalid recovery code");
  }
  return normalized;
}

export async function deriveRecoveryUnlockKey(
  code: string,
  email: string
): Promise<string> {
  return deriveUnlockKey(
    RECOVERY_UNLOCK_DOMAIN + normalizeRecoveryCode(code),
    deriveRecoverySalt(email)
  );
}
