// Crockford base32: no I, L, O or U. Chosen because this alphabet is
// transcribed from paper by a human; the decoder folds the confusable
// characters rather than rejecting them.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function encodeBase32(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Uppercases, drops grouping characters, and folds I/L to 1 and O to 0. */
export function normalizeBase32(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
}
