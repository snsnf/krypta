import { describe, expect, it } from "vitest"
import { pad, paddedLength, unpad } from "./pad"

function bytes(length: number, fill = 0x41): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

describe("paddedLength", () => {
  it("pads everything at or under the floor to the floor", () => {
    expect(paddedLength(0)).toBe(1024)
    expect(paddedLength(1)).toBe(1024)
    expect(paddedLength(1023)).toBe(1024)
    expect(paddedLength(1024)).toBe(1024)
  })

  it("applies Padme above the floor", () => {
    // 1025: E = 10, S = floor(log2 10) + 1 = 4, z = 6, bucket = 64.
    expect(paddedLength(1025)).toBe(1088)
    // 1500 rounds up to the next 64.
    expect(paddedLength(1500)).toBe(1536)
    // 8192 is already a bucket boundary and must not grow.
    expect(paddedLength(8192)).toBe(8192)
  })

  it("never shrinks a payload", () => {
    for (const length of [0, 1, 1024, 1025, 5000, 60000, 1_000_000]) {
      expect(paddedLength(length)).toBeGreaterThanOrEqual(length)
    }
  })

  it("costs at most 12 percent above the floor", () => {
    for (let length = 1025; length < 200_000; length += 977) {
      expect(paddedLength(length)).toBeLessThanOrEqual(Math.ceil(length * 1.12))
    }
  })
})

describe("pad and unpad", () => {
  it("round-trips content of every shape", () => {
    for (const length of [0, 1, 100, 1019, 1020, 5000]) {
      const content = bytes(length)
      expect(unpad(pad(content))).toEqual(content)
    }
  })

  it("round-trips content that is not text", () => {
    const content = new Uint8Array([0x00, 0xff, 0x01, 0x80, 0xfe])
    expect(unpad(pad(content))).toEqual(content)
  })

  it("hides the length of anything that fits under the floor", () => {
    // The property the whole change exists for.
    expect(pad(bytes(1)).length).toBe(pad(bytes(900)).length)
  })

  it("writes the version byte first", () => {
    expect(pad(bytes(10))[0]).toBe(0x01)
  })

  it("leaves only zeros after the content", () => {
    const padded = pad(bytes(10, 0x41))
    expect(padded.slice(15).every((byte) => byte === 0)).toBe(true)
  })

  it("rejects a payload shorter than the header", () => {
    expect(() => unpad(new Uint8Array([0x01, 0x00, 0x00]))).toThrow()
  })

  it("rejects an unknown version byte", () => {
    const padded = pad(bytes(10))
    padded[0] = 0x02
    expect(() => unpad(padded)).toThrow()
  })

  it("rejects a length that runs past the end", () => {
    const padded = pad(bytes(10))
    new DataView(padded.buffer).setUint32(1, 999_999, true)
    expect(() => unpad(padded)).toThrow()
  })

  it("rejects a non-zero byte inside the padding", () => {
    const padded = pad(bytes(10))
    padded[padded.length - 1] = 0x41
    expect(() => unpad(padded)).toThrow()
  })

  it("rejects unpadded legacy bytes, rather than returning them", () => {
    // A payload written before this change is JSON. It must fail loudly.
    const legacy = new TextEncoder().encode('{"q1":"yes"}')
    expect(() => unpad(legacy)).toThrow()
  })
})
