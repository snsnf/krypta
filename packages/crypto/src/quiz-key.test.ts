import { beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import { deriveQuizKey, generateSealKeyPair, generateSymmetricKey } from "./keys";
import { decryptWithKey, encryptWithKey } from "./seal";

describe("quiz key", () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  // Pinned so the frozen domain string cannot drift: a changed string would
  // make every stored answer key and grade unreadable.
  it("matches the pinned vector", () => {
    const privateKey = sodium.to_base64(new Uint8Array(32).map((_, i) => i));
    expect(privateKey).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(deriveQuizKey(privateKey)).toBe(
      "ZGPwYai87SBpsJvrgZnSXw8Udw3zc-kjWjD7uZPXgIk",
    );
  });

  it("is deterministic and differs per form", () => {
    const a = generateSealKeyPair().privateKey;
    const b = generateSealKeyPair().privateKey;
    expect(deriveQuizKey(a)).toBe(deriveQuizKey(a));
    expect(deriveQuizKey(a)).not.toBe(deriveQuizKey(b));
  });

  it("is a working secretbox key that the link key cannot open", () => {
    const quizKey = deriveQuizKey(generateSealKeyPair().privateKey);
    const sealed = encryptWithKey("Paris", quizKey);
    expect(decryptWithKey(sealed, quizKey)).toBe("Paris");
    expect(() => decryptWithKey(sealed, generateSymmetricKey())).toThrow();
  });
});
