import { beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import {
  generateSealKeyPair,
  matchesMemberApprovalTag,
  memberApprovalTag,
} from "./keys";

beforeAll(async () => {
  await sodium.ready;
});

describe("memberApprovalTag", () => {
  const formId = "0198e904-aa65-7bd1-a2d2-b734286d8f72";

  // Pinned so neither frozen domain string can drift: a changed string would
  // make every tag an owner has already issued fail to verify.
  it("matches the pinned vector", () => {
    const privateKey = sodium.to_base64(new Uint8Array(32).map((_, i) => i));
    expect(memberApprovalTag(privateKey, formId, "bob@example.com")).toBe(
      "1uHG0bHVIPkDkl6H2OES5D36kL7wcAep0xK9pad3vC0",
    );
  });

  it("verifies for the form and address it was made for", () => {
    const { privateKey } = generateSealKeyPair();
    const tag = memberApprovalTag(privateKey, formId, "bob@example.com");
    expect(matchesMemberApprovalTag(tag, privateKey, formId, "bob@example.com")).toBe(true);
  });

  it("matches the address the way the API stores it", () => {
    const { privateKey } = generateSealKeyPair();
    const tag = memberApprovalTag(privateKey, formId, "  Bob@Example.com ");
    expect(matchesMemberApprovalTag(tag, privateKey, formId, "bob@example.com")).toBe(true);
  });

  it("does not approve another address, another form, or under another form key", () => {
    const { privateKey } = generateSealKeyPair();
    const other = generateSealKeyPair().privateKey;
    const tag = memberApprovalTag(privateKey, formId, "bob@example.com");
    expect(matchesMemberApprovalTag(tag, privateKey, formId, "eve@example.com")).toBe(false);
    expect(
      matchesMemberApprovalTag(tag, privateKey, "0198e904-aa65-7bd1-a2d2-b734286d8f73", "bob@example.com"),
    ).toBe(false);
    expect(matchesMemberApprovalTag(tag, other, formId, "bob@example.com")).toBe(false);
  });

  it("treats a tag that does not decode as no approval", () => {
    const { privateKey } = generateSealKeyPair();
    expect(matchesMemberApprovalTag("not base64 !", privateKey, formId, "bob@example.com")).toBe(
      false,
    );
  });
});
