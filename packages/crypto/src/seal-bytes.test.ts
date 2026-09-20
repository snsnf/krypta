import { beforeAll, describe, expect, it } from "vitest"
import sodium from "libsodium-wrappers-sumo"
import { decryptBytesWithKey, encryptBytesWithKey } from "./seal"

describe("byte-level symmetric encryption", () => {
  beforeAll(async () => {
    await sodium.ready
  })

  function key(): string {
    return sodium.to_base64(sodium.randombytes_buf(32))
  }

  it("round-trips arbitrary bytes", () => {
    const k = key()
    const bytes = sodium.randombytes_buf(4096)
    expect(decryptBytesWithKey(encryptBytesWithKey(bytes, k), k)).toEqual(bytes)
  })

  it("round-trips bytes that are not valid text, which an image is not", () => {
    const k = key()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
    expect(decryptBytesWithKey(encryptBytesWithKey(bytes, k), k)).toEqual(bytes)
  })

  it("produces different ciphertext each time, so the nonce is not reused", () => {
    const k = key()
    const bytes = sodium.randombytes_buf(64)
    const a = encryptBytesWithKey(bytes, k)
    const b = encryptBytesWithKey(bytes, k)
    expect(sodium.to_base64(a)).not.toBe(sodium.to_base64(b))
  })

  it("refuses a wrong key rather than returning wrong bytes", () => {
    const bytes = sodium.randombytes_buf(64)
    const sealed = encryptBytesWithKey(bytes, key())
    expect(() => decryptBytesWithKey(sealed, key())).toThrow()
  })

  it("refuses tampered ciphertext", () => {
    const k = key()
    const sealed = encryptBytesWithKey(sodium.randombytes_buf(64), k)
    // Past the nonce, so the MAC is what rejects this rather than a parse.
    sealed[sealed.length - 1] ^= 0x01
    expect(() => decryptBytesWithKey(sealed, k)).toThrow()
  })
})
