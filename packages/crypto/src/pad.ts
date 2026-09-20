/*
 * Length padding for the string-shaped payloads.
 *
 * crypto_secretbox is a stream cipher plus a MAC, so a ciphertext is exactly
 * as long as its plaintext plus a constant. Without padding, the stored length
 * of a form title, a form schema or a response publishes the length of what it
 * holds: an operator can tell a ticked checkbox from three paragraphs, rank a
 * form's responses by how much each person wrote, and read roughly how many
 * questions a form asks off the schema column.
 *
 * This module knows nothing about encryption on purpose. It is byte
 * manipulation, so every branch is testable without a crypto round trip.
 */

// Written as the first byte of the padded plaintext, INSIDE the AEAD. It is
// not a scheme selector on the wire: seal.ts keeps a single K2 format, and the
// warning there about an unauthenticated tag choosing a parser is exactly why
// this byte lives under the MAC instead. It exists so a future format change
// has somewhere to announce itself.
const FORMAT_VERSION = 0x01;
const HEADER_BYTES = 5;
const FLOOR_BYTES = 1024;

/**
 * The stored length for a payload of `length` bytes.
 *
 * Below the floor everything is one bucket, which is where nearly all the
 * value is: measured against the development database, a floor of 1 KiB puts
 * every title, every response and all but one of 939 schemas into a single
 * indistinguishable size. Padme alone would not, because it barely pads small
 * inputs at all: at length 5 it computes a bucket of 1 and pads to 5.
 *
 * Above the floor this is Padme, from Nikitin et al., "Reducing Metadata
 * Leakage from Encrypted Files and Communication with PURBs" (PETS 2019). It
 * costs at most about 12 percent and leaks at most log2(log2(L)) bits of the
 * length.
 */
export function paddedLength(length: number): number {
  if (length <= FLOOR_BYTES) return FLOOR_BYTES;
  const exponent = Math.floor(Math.log2(length));
  const significantBits = Math.floor(Math.log2(exponent)) + 1;
  // Arithmetic rather than a bitmask: JavaScript's bitwise operators coerce to
  // 32-bit signed, which would silently misbehave on a payload over 2 GiB.
  const bucket = 2 ** (exponent - significantBits);
  return Math.ceil(length / bucket) * bucket;
}

/**
 * `0x01 || uint32le(content length) || content || zeros`, to a bucket length.
 *
 * The length is explicit rather than delimited by a marker byte because it is
 * checkable: unpad can verify both that it fits and that everything after it
 * is zero, and two independent conditions are what make a malformed payload
 * fail rather than decode into something plausible.
 */
export function pad(content: Uint8Array): Uint8Array {
  const total = paddedLength(HEADER_BYTES + content.length);
  const padded = new Uint8Array(total);
  padded[0] = FORMAT_VERSION;
  new DataView(padded.buffer).setUint32(1, content.length, true);
  padded.set(content, HEADER_BYTES);
  return padded;
}

/**
 * Strict. Anything that is not this exact format is an error, never a
 * fallback to treating the bytes as unpadded. The project is pre-launch and
 * every stored payload was deleted rather than migrated, so there is no legacy
 * shape to accept and therefore nothing that can quietly return wrong bytes.
 */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < HEADER_BYTES) {
    throw new Error("malformed padded payload");
  }
  if (padded[0] !== FORMAT_VERSION) {
    throw new Error("unsupported padding version");
  }
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const end = HEADER_BYTES + view.getUint32(1, true);
  if (end > padded.length) {
    throw new Error("malformed padded payload");
  }
  for (let index = end; index < padded.length; index += 1) {
    if (padded[index] !== 0) {
      throw new Error("malformed padded payload");
    }
  }
  return padded.slice(HEADER_BYTES, end);
}
