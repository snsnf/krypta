import { describe, expect, it } from "vitest";
import {
  deriveAuthVerifier,
  deriveRecoverySalt,
  deriveRecoveryVerifier,
  deriveUnlockKey,
  deriveVaultSalt,
  generateAccountKey,
  unwrapAccountKey,
  wrapAccountKey,
} from "../src/account-key";

describe("salts", () => {
  it("is stable for the same email", () => {
    expect(deriveVaultSalt("a@b.com")).toBe(deriveVaultSalt("a@b.com"));
  });

  it("ignores case and surrounding whitespace", () => {
    expect(deriveVaultSalt("  A@B.com ")).toBe(deriveVaultSalt("a@b.com"));
  });

  it("differs per email", () => {
    expect(deriveVaultSalt("a@b.com")).not.toBe(deriveVaultSalt("c@d.com"));
  });

  it("separates the vault and recovery domains for one email", () => {
    expect(deriveVaultSalt("a@b.com")).not.toBe(deriveRecoverySalt("a@b.com"));
  });
});

describe("unlock keys and verifiers", () => {
  it("derives the same unlock key from the same secret and salt", async () => {
    const salt = deriveVaultSalt("a@b.com");
    expect(await deriveUnlockKey("hunter2", salt)).toBe(
      await deriveUnlockKey("hunter2", salt)
    );
  });

  it("derives a different unlock key for a different secret", async () => {
    const salt = deriveVaultSalt("a@b.com");
    expect(await deriveUnlockKey("hunter2", salt)).not.toBe(
      await deriveUnlockKey("hunter3", salt)
    );
  });

  it("produces a verifier that is not the unlock key", async () => {
    const key = await deriveUnlockKey("hunter2", deriveVaultSalt("a@b.com"));
    const verifier = deriveAuthVerifier(key);
    expect(verifier).not.toBe(key);
    expect(deriveAuthVerifier(key)).toBe(verifier);
  });

  it("separates the auth and recovery verifier domains", async () => {
    const key = await deriveUnlockKey("hunter2", deriveVaultSalt("a@b.com"));
    expect(deriveAuthVerifier(key)).not.toBe(deriveRecoveryVerifier(key));
  });
});

describe("account key wrapping", () => {
  it("opens one account key from two independent unlock keys", async () => {
    const accountKey = generateAccountKey();
    const passwordKey = await deriveUnlockKey("hunter2", deriveVaultSalt("a@b.com"));
    const recoveryKey = await deriveUnlockKey("CODE", deriveRecoverySalt("a@b.com"));

    const viaPassword = wrapAccountKey(accountKey, passwordKey);
    const viaRecovery = wrapAccountKey(accountKey, recoveryKey);

    expect(viaPassword).not.toBe(viaRecovery);
    expect(unwrapAccountKey(viaPassword, passwordKey)).toBe(accountKey);
    expect(unwrapAccountKey(viaRecovery, recoveryKey)).toBe(accountKey);
  });

  it("fails to unwrap with the wrong unlock key", async () => {
    const accountKey = generateAccountKey();
    const right = await deriveUnlockKey("hunter2", deriveVaultSalt("a@b.com"));
    const wrong = await deriveUnlockKey("hunter3", deriveVaultSalt("a@b.com"));
    expect(() => unwrapAccountKey(wrapAccountKey(accountKey, right), wrong)).toThrow();
  });

  it("generates a distinct account key each time", () => {
    expect(generateAccountKey()).not.toBe(generateAccountKey());
  });
});
