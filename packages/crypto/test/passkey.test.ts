import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import {
  derivePasskeyUnlockKey,
  passkeyPrfSalt,
  unwrapAccountKeyForPasskey,
  wrapAccountKeyForPasskey,
} from "../src/passkey";
import { generateAccountKey } from "../src/account-key";

function prf(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

describe("passkeyPrfSalt", () => {
  it("is 32 bytes and stable across calls", () => {
    const a = passkeyPrfSalt();
    const b = passkeyPrfSalt();
    expect(a.length).toBe(32);
    expect(sodium.to_base64(a)).toBe(sodium.to_base64(b));
  });

  it("is frozen: changing it locks every enrolled passkey out", () => {
    // Pinned so an edit to the domain string fails here rather than silently
    // in production. Regenerate ONLY if every existing passkey is being
    // deliberately invalidated.
    expect(sodium.to_base64(passkeyPrfSalt())).toBe(
      sodium.to_base64(
        sodium.crypto_generichash(
          32,
          sodium.from_string("krypta-passkey-prf-v1"),
          null
        )
      )
    );
  });
});

describe("derivePasskeyUnlockKey", () => {
  it("is deterministic for one PRF output", () => {
    expect(derivePasskeyUnlockKey(prf(7))).toBe(derivePasskeyUnlockKey(prf(7)));
  });

  it("differs for different PRF outputs", () => {
    expect(derivePasskeyUnlockKey(prf(7))).not.toBe(
      derivePasskeyUnlockKey(prf(8))
    );
  });

  it("is domain separated from the raw PRF output", () => {
    expect(derivePasskeyUnlockKey(prf(7))).not.toBe(sodium.to_base64(prf(7)));
  });

  it("produces a secretbox-sized key", () => {
    expect(sodium.from_base64(derivePasskeyUnlockKey(prf(7))).length).toBe(
      sodium.crypto_secretbox_KEYBYTES
    );
  });

  it("refuses a short PRF output rather than deriving a weak key", () => {
    expect(() => derivePasskeyUnlockKey(new Uint8Array(16))).toThrow();
  });
});

describe("wrapping the account key", () => {
  it("round-trips the same account key", () => {
    const accountKey = generateAccountKey();
    const unlockKey = derivePasskeyUnlockKey(prf(3));
    const wrapped = wrapAccountKeyForPasskey(accountKey, unlockKey);
    expect(unwrapAccountKeyForPasskey(wrapped, unlockKey)).toBe(accountKey);
  });

  it("cannot be opened by a different passkey's unlock key", () => {
    const accountKey = generateAccountKey();
    const wrapped = wrapAccountKeyForPasskey(
      accountKey,
      derivePasskeyUnlockKey(prf(3))
    );
    expect(() =>
      unwrapAccountKeyForPasskey(wrapped, derivePasskeyUnlockKey(prf(4)))
    ).toThrow();
  });
});
