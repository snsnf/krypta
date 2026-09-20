import { beforeAll, describe, expect, it } from "vitest"
import sodium from "libsodium-wrappers-sumo"
import { generateSealKeyPair } from "./keys"
import {
  decryptBytesWithKey,
  decryptWithKey,
  encryptBytesWithKey,
  encryptWithKey,
  sealBox,
  sealBoxBytes,
  unsealBox,
  unsealBoxBytes,
} from "./seal"

describe("padding through the real helpers", () => {
  beforeAll(async () => {
    await sodium.ready
  })

  function key(): string {
    return sodium.to_base64(sodium.randombytes_buf(32))
  }

  it("round-trips a symmetric payload", () => {
    const k = key()
    expect(decryptWithKey(encryptWithKey("a form title", k), k)).toBe("a form title")
  })

  it("round-trips a sealed payload", () => {
    const pair = generateSealKeyPair()
    const message = JSON.stringify({ q1: "yes", q2: ["a", "b"] })
    expect(unsealBox(sealBox(message, pair.publicKey), pair.privateKey)).toBe(message)
  })

  it("round-trips text that is not ASCII, so the length is bytes and not characters", () => {
    const k = key()
    const message = "استبيان الملاحظات"
    expect(decryptWithKey(encryptWithKey(message, k), k)).toBe(message)
  })

  it("gives two short titles the same ciphertext length", () => {
    const k = key()
    const short = encryptWithKey("Feedback", k)
    const longer = encryptWithKey("Customer satisfaction survey, Q3 2026", k)
    expect(short.length).toBe(longer.length)
  })

  it("gives two short responses the same ciphertext length", () => {
    const pair = generateSealKeyPair()
    const small = sealBox(JSON.stringify({ q1: "y" }), pair.publicKey)
    const larger = sealBox(
      JSON.stringify({ q1: "yes, and here is a whole sentence of detail" }),
      pair.publicKey
    )
    expect(small.length).toBe(larger.length)
  })

  it("leaves the byte helpers unpadded, because attachment sizes are already public", () => {
    const k = key()
    const small = encryptBytesWithKey(new Uint8Array(10), k)
    const larger = encryptBytesWithKey(new Uint8Array(5000), k)
    expect(small.length).toBeLessThan(larger.length)

    const pair = generateSealKeyPair()
    const sealedSmall = sealBoxBytes(new Uint8Array(10), pair.publicKey)
    const sealedLarge = sealBoxBytes(new Uint8Array(5000), pair.publicKey)
    expect(sealedSmall.length).toBeLessThan(sealedLarge.length)
  })

  it("still round-trips the byte helpers", () => {
    const k = key()
    const bytes = sodium.randombytes_buf(4096)
    expect(decryptBytesWithKey(encryptBytesWithKey(bytes, k), k)).toEqual(bytes)

    const pair = generateSealKeyPair()
    expect(unsealBoxBytes(sealBoxBytes(bytes, pair.publicKey), pair.privateKey)).toEqual(bytes)
  })
})
