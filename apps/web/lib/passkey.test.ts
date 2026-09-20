import { describe, expect, it, vi } from "vitest"

// BOTH `@/` imports in passkey.ts's module graph must be mocked. Any bare
// `@/...` import anywhere in the graph is unresolvable under this repo's
// vitest, and one unmocked import fails every test in the file at load time.
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(),
  ApiClientError: class extends Error {},
}))
vi.mock("@/lib/sodium-ready", () => ({
  ensureSodiumReady: async () => {},
}))

const {
  base64UrlToBytes,
  bufferToBase64Url,
  decodeOptions,
  prfSupportFrom,
  readPrfOutput,
} = await import("./passkey")

describe("base64url", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128])
    expect(base64UrlToBytes(bufferToBase64Url(bytes))).toEqual(bytes)
  })

  it("emits no padding or URL-unsafe characters", () => {
    const encoded = bufferToBase64Url(new Uint8Array([251, 255, 254]))
    expect(encoded).not.toMatch(/[+/=]/)
  })
})

describe("prfSupportFrom", () => {
  it("reads an output returned during creation", () => {
    const results = { prf: { enabled: true, results: { first: new Uint8Array(32).buffer } } }
    expect(prfSupportFrom(results)).toBe("usable")
    expect(readPrfOutput(results)).toHaveLength(32)
  })

  it("asks for a second assertion when PRF is enabled but returned nothing", () => {
    // The common case: many clients report enabled at create() and only
    // produce output on a later get().
    expect(prfSupportFrom({ prf: { enabled: true } })).toBe("needs-assertion")
    expect(readPrfOutput({ prf: { enabled: true } })).toBeNull()
  })

  it("reports unsupported when the extension is absent", () => {
    expect(prfSupportFrom({})).toBe("unsupported")
    expect(prfSupportFrom({ prf: { enabled: false } })).toBe("unsupported")
  })

  it("reports unsupported rather than throwing on a malformed result", () => {
    expect(prfSupportFrom(null)).toBe("unsupported")
    expect(prfSupportFrom("nonsense")).toBe("unsupported")
  })

  it("refuses an output shorter than a key", () => {
    // A short output must never be silently accepted and stretched.
    expect(
      readPrfOutput({ prf: { enabled: true, results: { first: new Uint8Array(8).buffer } } })
    ).toBeNull()
  })

  it("reads an assertion result, which never carries `enabled`", () => {
    // Per the WebAuthn spec, `enabled` is reported only for create(); an
    // assertion from get() returns just `{ prf: { results: { first } } }`.
    // readPrfOutput must accept this shape or every passkey login fails.
    const results = { prf: { results: { first: new Uint8Array(32).buffer } } }
    expect(readPrfOutput(results)).toHaveLength(32)
  })

  it("refuses a short assertion-shaped output with no `enabled` key", () => {
    const results = { prf: { results: { first: new Uint8Array(8).buffer } } }
    expect(readPrfOutput(results)).toBeNull()
  })
})

describe("decodeOptions", () => {
  it("converts base64url fields to BufferSources", () => {
    const challenge = bufferToBase64Url(new Uint8Array([1, 2, 3]))
    const userId = bufferToBase64Url(new Uint8Array([4, 5, 6]))
    const excludeId = bufferToBase64Url(new Uint8Array([7, 8]))
    const allowId = bufferToBase64Url(new Uint8Array([9, 10]))

    const decoded = decodeOptions<{
      publicKey: {
        challenge: Uint8Array
        user: { id: Uint8Array }
        excludeCredentials: Array<{ id: Uint8Array; type: string }>
        allowCredentials: Array<{ id: Uint8Array; type: string }>
      }
    }>({
      publicKey: {
        challenge,
        user: { id: userId, name: "someone" },
        excludeCredentials: [{ id: excludeId, type: "public-key" }],
        allowCredentials: [{ id: allowId, type: "public-key" }],
      },
    })

    expect(decoded.publicKey.challenge).toEqual(new Uint8Array([1, 2, 3]))
    expect(decoded.publicKey.user.id).toEqual(new Uint8Array([4, 5, 6]))
    expect(decoded.publicKey.excludeCredentials[0].id).toEqual(
      new Uint8Array([7, 8])
    )
    expect(decoded.publicKey.allowCredentials[0].id).toEqual(
      new Uint8Array([9, 10])
    )
  })
})
