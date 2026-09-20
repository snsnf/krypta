import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../src/keys";
import { wrapKey, unwrapKey } from "../src/wrap";

describe("wrap/unwrap", () => {
  it("round-trips a key through wrap then unwrap", () => {
    const masterKey = generateSymmetricKey();
    const dataKey = generateSymmetricKey();
    const wrapped = wrapKey(dataKey, masterKey);
    expect(wrapped).not.toEqual(dataKey);
    const unwrapped = unwrapKey(wrapped, masterKey);
    expect(unwrapped).toEqual(dataKey);
  });

  it("fails to unwrap with the wrong master key", () => {
    const masterKey = generateSymmetricKey();
    const wrongKey = generateSymmetricKey();
    const dataKey = generateSymmetricKey();
    const wrapped = wrapKey(dataKey, masterKey);
    expect(() => unwrapKey(wrapped, wrongKey)).toThrow();
  });
});
