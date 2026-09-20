import { describe, expect, it } from "vitest";
import { generateSealKeyPair } from "../src/keys";
import { sealBox, unsealBox, sealBoxBytes, unsealBoxBytes } from "../src/seal";

const TAG = [0x4b, 0x32]; // "K2"
// X-Wing's ciphertext is ML-KEM-768's 1088 bytes plus the 32-byte X25519 half.
const KEM_CIPHERTEXT_BYTES = 1120;
const NONCE_BYTES = 24;
const PREFIX_BYTES = TAG.length + KEM_CIPHERTEXT_BYTES + NONCE_BYTES;

describe("generateSealKeyPair", () => {
  it("produces a distinct hybrid keypair each time", () => {
    const a = generateSealKeyPair();
    const b = generateSealKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("produces keys of the documented X-Wing hybrid sizes", async () => {
    const sodium = (await import("libsodium-wrappers-sumo")).default;
    await sodium.ready;
    const { publicKey, privateKey } = generateSealKeyPair();
    expect(sodium.from_base64(publicKey).length).toBe(1216);
    // The private key is a compact 32-byte root seed, not an expanded
    // ML-KEM-768 secret key: X-Wing expands it deterministically on demand.
    expect(sodium.from_base64(privateKey).length).toBe(32);
  });
});

// The DEM key must be crypto_secretbox_KEYBYTES. The library documents 32 but
// its README does not state it, so pin the assumption here: if a future version
// changes it, this fails loudly rather than silently routing through the
// hashing fallback in demKey.
describe("the hybrid KEM's shared secret", () => {
  it("is 32 bytes, the secretbox key length", async () => {
    const { ml_kem768_x25519 } = await import("@noble/post-quantum/hybrid.js");
    const { publicKey } = ml_kem768_x25519.keygen();
    const { sharedSecret } = ml_kem768_x25519.encapsulate(publicKey);
    expect(sharedSecret.length).toBe(32);
  });
});

describe("sealBox/unsealBox", () => {
  it("round-trips a message", () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    const message = JSON.stringify({ answer: "hello world" });
    expect(unsealBox(sealBox(message, publicKey), privateKey)).toEqual(message);
  });

  it("fails with the wrong private key", () => {
    const { publicKey } = generateSealKeyPair();
    const { privateKey: wrong } = generateSealKeyPair();
    const sealed = sealBox("secret", publicKey);
    expect(() => unsealBox(sealed, wrong)).toThrow();
  });
});

describe("sealBoxBytes/unsealBoxBytes", () => {
  it("round-trips arbitrary binary bytes", () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    const original = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 127]);
    expect(unsealBoxBytes(sealBoxBytes(original, publicKey), privateKey)).toEqual(original);
  });

  it("round-trips an empty payload", () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    const empty = new Uint8Array(0);
    expect(unsealBoxBytes(sealBoxBytes(empty, publicKey), privateKey)).toEqual(empty);
  });

  it("round-trips a payload larger than a megabyte", () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    const big = new Uint8Array(1024 * 1024 + 7).map((_, i) => i % 256);
    expect(unsealBoxBytes(sealBoxBytes(big, publicKey), privateKey)).toEqual(big);
  });
});

describe("the sealed format", () => {
  it("carries the K2 tag and the expected fixed prefix", () => {
    const { publicKey } = generateSealKeyPair();
    const sealed = sealBoxBytes(new Uint8Array([1, 2, 3]), publicKey);
    expect(Array.from(sealed.slice(0, 2))).toEqual(TAG);
    // 3 bytes of payload plus the Poly1305 tag.
    expect(sealed.length).toBe(PREFIX_BYTES + 3 + 16);
  });

  it("rejects a blob whose tag does not match", () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    const sealed = sealBoxBytes(new Uint8Array([1, 2, 3]), publicKey);
    sealed[0] = 0x58;
    expect(() => unsealBoxBytes(sealed, privateKey)).toThrow();
  });

  it("rejects a blob shorter than the fixed prefix without an index error", () => {
    const { privateKey } = generateSealKeyPair();
    const truncated = new Uint8Array([0x4b, 0x32, 0x00, 0x01]);
    expect(() => unsealBoxBytes(truncated, privateKey)).toThrow(/malformed/i);
  });

  // ML-KEM has implicit rejection: decapsulate returns a wrong-but-plausible
  // shared secret rather than throwing, so this asserts the secretbox MAC is
  // what actually rejects a tampered KEM ciphertext. If this test ever passes
  // because decapsulate threw, the property being checked has been lost.
  it("rejects a tampered KEM ciphertext", () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    const sealed = sealBoxBytes(new Uint8Array([1, 2, 3]), publicKey);
    sealed[10] ^= 0xff;
    expect(() => unsealBoxBytes(sealed, privateKey)).toThrow();
  });

  it("rejects a tampered AEAD body", () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    const sealed = sealBoxBytes(new Uint8Array([1, 2, 3]), publicKey);
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => unsealBoxBytes(sealed, privateKey)).toThrow();
  });

  it("produces a different blob each time for the same input", () => {
    const { publicKey } = generateSealKeyPair();
    const a = sealBoxBytes(new Uint8Array([1, 2, 3]), publicKey);
    const b = sealBoxBytes(new Uint8Array([1, 2, 3]), publicKey);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
