import { beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import { formKeyPin, generateSymmetricKey, matchesFormKeyPin } from "./keys";

beforeAll(async () => {
  await sodium.ready;
});

describe("formKeyPin", () => {
  const formId = "0198e904-aa65-7bd1-a2d2-b734286d8f72";
  const fingerprint = "q1J9w0m8c3l2YhXx0bH4p7c1nE6tRk5sVd2aZ9yUo0E";

  // Pinned so neither frozen domain string can drift: a changed string would
  // make every pin a member has already written fail to verify.
  it("matches the pinned vector", () => {
    const accountKey = sodium.to_base64(new Uint8Array(32).map((_, i) => i));
    expect(formKeyPin(accountKey, formId, fingerprint)).toBe(
      "b6w6gvH98RHxvlqxRbU3X1_A1zmy-axPNeCzOobAg3g",
    );
  });

  it("verifies for the account, form and fingerprint it was made for", () => {
    const accountKey = generateSymmetricKey();
    const pin = formKeyPin(accountKey, formId, fingerprint);
    expect(matchesFormKeyPin(pin, accountKey, formId, fingerprint)).toBe(true);
  });

  it("does not pin another key, another form, or for another account", () => {
    const accountKey = generateSymmetricKey();
    const pin = formKeyPin(accountKey, formId, fingerprint);
    expect(
      matchesFormKeyPin(pin, accountKey, formId, "Z1J9w0m8c3l2YhXx0bH4p7c1nE6tRk5sVd2aZ9yUo0E"),
    ).toBe(false);
    expect(
      matchesFormKeyPin(pin, accountKey, "0198e904-aa65-7bd1-a2d2-b734286d8f73", fingerprint),
    ).toBe(false);
    expect(matchesFormKeyPin(pin, generateSymmetricKey(), formId, fingerprint)).toBe(false);
  });

  it("treats a pin that does not decode as no pin", () => {
    expect(matchesFormKeyPin("not base64 !", generateSymmetricKey(), formId, fingerprint)).toBe(
      false,
    );
  });
});
