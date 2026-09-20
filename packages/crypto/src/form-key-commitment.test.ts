import { beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import {
  formKeyCommitment,
  generateSealKeyPair,
  matchesFormKeyCommitment,
  sealPublicKeyFromPrivate,
} from "./keys";

describe("form key commitment", () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  it("recomputes the public key from the private seed", () => {
    const pair = generateSealKeyPair();
    expect(sealPublicKeyFromPrivate(pair.privateKey)).toBe(pair.publicKey);
  });

  it("matches the committed key and refuses any other", () => {
    const owner = generateSealKeyPair();
    const attacker = generateSealKeyPair();
    const commitment = formKeyCommitment(owner.publicKey);

    expect(matchesFormKeyCommitment(owner.publicKey, commitment)).toBe(true);
    expect(matchesFormKeyCommitment(attacker.publicKey, commitment)).toBe(false);
  });

  it("refuses input that does not decode instead of throwing", () => {
    const owner = generateSealKeyPair();
    expect(matchesFormKeyCommitment("not base64!", formKeyCommitment(owner.publicKey))).toBe(
      false,
    );
    expect(matchesFormKeyCommitment(owner.publicKey, "not base64!")).toBe(false);
  });
});
