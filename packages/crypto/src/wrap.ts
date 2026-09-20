import sodium from "libsodium-wrappers-sumo";

export function wrapKey(rawKeyBase64: string, masterKeyBase64: string): string {
  const rawKey = sodium.from_base64(rawKeyBase64);
  const masterKey = sodium.from_base64(masterKeyBase64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(rawKey, nonce, masterKey);
  return sodium.to_base64(new Uint8Array([...nonce, ...ciphertext]));
}

export function unwrapKey(wrappedBase64: string, masterKeyBase64: string): string {
  const combined = sodium.from_base64(wrappedBase64);
  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
  const masterKey = sodium.from_base64(masterKeyBase64);
  const rawKey = sodium.crypto_secretbox_open_easy(ciphertext, nonce, masterKey);
  return sodium.to_base64(rawKey);
}
