import { describe, expect, it } from "vitest"
import {
  formKeyCommitment,
  generateSealKeyPair,
  matchesFormKeyCommitment,
} from "@krypta/crypto"
import { formShareLink, readFragmentParam, responseEditLink } from "./form-link"
import { ensureSodiumReady } from "./sodium-ready"

describe("readFragmentParam", () => {
  it("reads a value from a form link", () => {
    expect(readFragmentParam("#key=abc", "key")).toBe("abc")
  })

  it("reads each value from an edit link, in either order, decoded", () => {
    expect(readFragmentParam("#token=t%2B1&key=k", "token")).toBe("t+1")
    expect(readFragmentParam("#token=t%2B1&key=k", "key")).toBe("k")
    expect(readFragmentParam("#key=k&token=t", "token")).toBe("t")
  })

  it("is null when the value is missing", () => {
    expect(readFragmentParam("", "key")).toBeNull()
    expect(readFragmentParam("#token=t", "key")).toBeNull()
  })

  it("does not match a longer name that ends in the one asked for", () => {
    expect(readFragmentParam("#monkey=x", "key")).toBeNull()
  })

  it("is null, not a throw, when the value is not valid percent-encoding", () => {
    expect(readFragmentParam("#key=%E0%A4%A", "key")).toBeNull()
  })
})

describe("formShareLink", () => {
  it("carries the data key and a fingerprint of the key derived from the private key", async () => {
    await ensureSodiumReady()
    const pair = generateSealKeyPair()
    const link = formShareLink("https://x.test", "f1", "data/key+", pair.privateKey)
    const hash = link.slice(link.indexOf("#"))

    expect(link.startsWith("https://x.test/f/f1#")).toBe(true)
    expect(readFragmentParam(hash, "key")).toBe("data/key+")
    const pk = readFragmentParam(hash, "pk")
    expect(pk).not.toBeNull()
    expect(matchesFormKeyCommitment(pair.publicKey, pk!)).toBe(true)
  })
})

describe("responseEditLink", () => {
  it("keeps the fingerprint the respondent arrived with", async () => {
    await ensureSodiumReady()
    const pair = generateSealKeyPair()
    const fingerprint = formKeyCommitment(pair.publicKey)
    const link = responseEditLink("https://x.test", "f1", "tok", "k", fingerprint)
    const hash = link.slice(link.indexOf("#"))

    expect(readFragmentParam(hash, "token")).toBe("tok")
    expect(readFragmentParam(hash, "key")).toBe("k")
    expect(readFragmentParam(hash, "pk")).toBe(fingerprint)
  })

  it("adds no fingerprint for a link that never had one", () => {
    expect(responseEditLink("https://x.test", "f1", "tok", "k", null)).toBe(
      "https://x.test/f/f1/r#token=tok&key=k"
    )
  })
})
