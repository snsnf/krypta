import { describe, expect, it } from "vitest";
import { generateSymmetricKey, generateSealKeyPair } from "../src/keys";

describe("keys", () => {
  it("generates a symmetric key of the expected length", () => {
    const key = generateSymmetricKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("generates a usable hybrid keypair", () => {
    const pair = generateSealKeyPair();
    expect(pair.publicKey).toBeTruthy();
    expect(pair.privateKey).toBeTruthy();
    expect(pair.publicKey).not.toEqual(pair.privateKey);
  });
});
