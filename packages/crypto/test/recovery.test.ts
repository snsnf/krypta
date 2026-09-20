import { describe, expect, it } from "vitest";
import { deriveRecoverySalt, deriveUnlockKey } from "../src/account-key";
import {
  deriveRecoveryUnlockKey,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from "../src/recovery";

describe("generateRecoveryCode", () => {
  it("formats 160 bits as 8 groups of 4", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/
    );
  });

  it("is different every time", () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });
});

describe("normalizeRecoveryCode", () => {
  it("accepts the code as displayed", () => {
    const code = generateRecoveryCode();
    expect(normalizeRecoveryCode(code)).toHaveLength(32);
  });

  it("accepts a lowercase, unhyphenated, space-separated transcription", () => {
    const code = generateRecoveryCode();
    const mangled = code.toLowerCase().replace(/-/g, " ");
    expect(normalizeRecoveryCode(mangled)).toBe(normalizeRecoveryCode(code));
  });

  it("folds the confusable characters a human writes down", () => {
    expect(normalizeRecoveryCode("IL0O".repeat(8))).toBe("1100".repeat(8));
  });

  it("rejects a code of the wrong length", () => {
    expect(() => normalizeRecoveryCode("ABCD-EFGH")).toThrow();
  });
});

describe("deriveRecoveryUnlockKey", () => {
  it("is stable across equivalent transcriptions of the same code", async () => {
    const code = generateRecoveryCode();
    const fromDisplayed = await deriveRecoveryUnlockKey(code, "a@b.com");
    const fromTyped = await deriveRecoveryUnlockKey(
      code.toLowerCase().replace(/-/g, ""),
      "a@b.com"
    );
    expect(fromTyped).toBe(fromDisplayed);
  });

  it("differs per email", async () => {
    const code = generateRecoveryCode();
    expect(await deriveRecoveryUnlockKey(code, "a@b.com")).not.toBe(
      await deriveRecoveryUnlockKey(code, "c@d.com")
    );
  });

  it("is domain-separated from a bare unlock key over the same string", async () => {
    const code = generateRecoveryCode();
    const bare = await deriveUnlockKey(
      normalizeRecoveryCode(code),
      deriveRecoverySalt("a@b.com")
    );
    expect(await deriveRecoveryUnlockKey(code, "a@b.com")).not.toBe(bare);
  });
});
