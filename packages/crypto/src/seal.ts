import sodium from "libsodium-wrappers-sumo";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { pad, unpad } from "./pad";

// KEM-DEM, scheme 2. Scheme 1 is the untagged crypto_box_seal format this
// replaces, which is why the first tagged version is not K1. The tag lives on
// the raw bytes rather than being a string prefix, because sealBoxBytes returns
// a Uint8Array for file uploads and both variants need one representation.
const SEAL_TAG = new Uint8Array([0x4b, 0x32]); // "K2"
// X-Wing's ciphertext is ML-KEM-768's 1088 bytes plus the 32-byte X25519 half.
const KEM_CIPHERTEXT_BYTES = 1120;

function prefixBytes(): number {
  return SEAL_TAG.length + KEM_CIPHERTEXT_BYTES + sodium.crypto_secretbox_NONCEBYTES;
}

/**
 * The DEM key, guaranteed to be crypto_secretbox_KEYBYTES.
 *
 * X-Wing's shared secret is documented as 32 bytes but the library's README
 * does not state it, so this asserts rather than assumes. Hashing rather than
 * truncating means no entropy is silently discarded if that ever changes.
 */
function demKey(sharedSecret: Uint8Array): Uint8Array {
  if (sharedSecret.length === sodium.crypto_secretbox_KEYBYTES) return sharedSecret;
  return sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, sharedSecret, null);
}

/**
 * Seals to a hybrid public key.
 *
 * ml_kem768_x25519 is X-Wing: the shared secret depends on BOTH the ML-KEM and
 * the X25519 halves, so a total break of ML-KEM leaves this exactly as safe as
 * the X25519-only sealing it replaces. Never substitute bare ML-KEM, and never
 * hand-roll the combiner.
 */
export function sealBoxBytes(bytes: Uint8Array, publicKeyBase64: string): Uint8Array {
  const publicKey = sodium.from_base64(publicKeyBase64);
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(publicKey);
  // The unseal path parses at a hardcoded KEM_CIPHERTEXT_BYTES offset, so a
  // library change that alters this size must fail loudly here rather than
  // silently emitting a blob the parser mis-slices.
  if (cipherText.length !== KEM_CIPHERTEXT_BYTES) {
    throw new Error("unexpected KEM ciphertext length");
  }
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const body = sodium.crypto_secretbox_easy(bytes, nonce, demKey(sharedSecret));

  const out = new Uint8Array(SEAL_TAG.length + cipherText.length + nonce.length + body.length);
  out.set(SEAL_TAG, 0);
  out.set(cipherText, SEAL_TAG.length);
  out.set(nonce, SEAL_TAG.length + cipherText.length);
  out.set(body, SEAL_TAG.length + cipherText.length + nonce.length);
  return out;
}

export function unsealBoxBytes(sealed: Uint8Array, privateKeyBase64: string): Uint8Array {
  if (sealed.length < prefixBytes()) {
    throw new Error("malformed sealed payload");
  }
  // The tag is compared in the clear and is NOT authenticated data: it is
  // never passed into the AEAD as associated data. Harmless with a single
  // scheme, since there is nothing to downgrade to; once a second scheme
  // exists, an attacker able to flip this byte chooses which parser runs.
  if (sealed[0] !== SEAL_TAG[0] || sealed[1] !== SEAL_TAG[1]) {
    throw new Error("unsupported seal format");
  }

  const kemStart = SEAL_TAG.length;
  const nonceStart = kemStart + KEM_CIPHERTEXT_BYTES;
  const bodyStart = nonceStart + sodium.crypto_secretbox_NONCEBYTES;
  const privateKey = sodium.from_base64(privateKeyBase64);

  // ML-KEM has implicit rejection: decapsulate does NOT throw on a corrupted
  // ciphertext, it returns a wrong-but-plausible shared secret. The secretbox
  // MAC below is what actually rejects a tampered payload: a successful
  // decapsulate says nothing about authenticity.
  const sharedSecret = ml_kem768_x25519.decapsulate(
    sealed.slice(kemStart, nonceStart),
    privateKey
  );

  return sodium.crypto_secretbox_open_easy(
    sealed.slice(bodyStart),
    sealed.slice(nonceStart, bodyStart),
    demKey(sharedSecret)
  );
}

/*
 * The string variants pad; the byte variants do not.
 *
 * That split is the whole design, not an accident of which functions happened
 * to need it. A string payload here is user content whose length is meaningful
 * (a title, a schema, a set of answers), and its ciphertext length would
 * otherwise publish it. A byte payload is a file, and a file's size is already
 * in attachments.byte_size, because the storage quota is counted against it.
 *
 * Padding lives here rather than at the call sites because there are nine of
 * them across six files, and a rule spread over nine places is a rule one of
 * them will eventually forget.
 */
export function sealBox(plaintext: string, publicKeyBase64: string): string {
  return sodium.to_base64(sealBoxBytes(pad(sodium.from_string(plaintext)), publicKeyBase64));
}

export function unsealBox(sealedBase64: string, privateKeyBase64: string): string {
  return sodium.to_string(
    unpad(unsealBoxBytes(sodium.from_base64(sealedBase64), privateKeyBase64))
  );
}

/*
 * Byte variants of encryptWithKey. Same layout, nonce followed by ciphertext,
 * so the two stay one format rather than two that happen to both use
 * secretbox. These exist for a form's header image, which every respondent has
 * to be able to open: it is encrypted under the schema key from the link
 * fragment, not sealed to the form public key the way a response attachment is,
 * because a respondent never holds the matching private key.
 */
export function encryptBytesWithKey(bytes: Uint8Array, keyBase64: string): Uint8Array {
  const key = sodium.from_base64(keyBase64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(bytes, nonce, key);
  return new Uint8Array([...nonce, ...ciphertext]);
}

export function decryptBytesWithKey(sealed: Uint8Array, keyBase64: string): Uint8Array {
  const nonce = sealed.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sealed.slice(sodium.crypto_secretbox_NONCEBYTES);
  const key = sodium.from_base64(keyBase64);
  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
}

export function encryptWithKey(plaintext: string, keyBase64: string): string {
  const key = sodium.from_base64(keyBase64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const message = pad(sodium.from_string(plaintext));
  const ciphertext = sodium.crypto_secretbox_easy(message, nonce, key);
  return sodium.to_base64(new Uint8Array([...nonce, ...ciphertext]));
}

export function decryptWithKey(ciphertextBase64: string, keyBase64: string): string {
  const combined = sodium.from_base64(ciphertextBase64);
  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
  const key = sodium.from_base64(keyBase64);
  const opened = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  return sodium.to_string(unpad(opened));
}
