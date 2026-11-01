import sodium from "libsodium-wrappers-sumo";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";

export function generateSymmetricKey(): string {
  return sodium.to_base64(sodium.crypto_secretbox_keygen());
}

/**
 * A hybrid ML-KEM-768 + X25519 (X-Wing) keypair, used to seal responses,
 * attachments and collaborator grants.
 *
 * Named for the seal rather than the primitive: callers must not assume
 * X25519. The public key is 1184 (ML-KEM-768) + 32 (X25519) = 1216 bytes.
 * The private key stays 32 bytes: X-Wing represents it as a compact root
 * seed rather than an expanded ML-KEM secret key, which is why wrapped
 * private keys stored elsewhere do not grow.
 *
 * No seed is passed. The library's default randomness is the platform CSPRNG,
 * and supplying a seed only adds a way to get it wrong.
 */
export function generateSealKeyPair(): { publicKey: string; privateKey: string } {
  const pair = ml_kem768_x25519.keygen();
  return {
    publicKey: sodium.to_base64(pair.publicKey),
    privateKey: sodium.to_base64(pair.secretKey),
  };
}

// Frozen. Every form schema written with a commitment carries a hash under
// this string; changing it makes every such form refuse its own public key.
const FORM_KEY_COMMITMENT_DOMAIN = "krypta-form-public-key-commitment-v1";

/**
 * The public half of a seal keypair, recomputed from its private half.
 *
 * The private key is X-Wing's 32-byte root seed, from which the public key is
 * deterministic. A form member who holds the private key through their grant
 * can therefore know the true public key without trusting the copy the server
 * serves, which is what `formKeyCommitment` must be computed over.
 */
export function sealPublicKeyFromPrivate(privateKeyBase64: string): string {
  const privateKey = sodium.from_base64(privateKeyBase64);
  return sodium.to_base64(ml_kem768_x25519.getPublicKey(privateKey));
}

/**
 * Binds a form's public key into its encrypted schema.
 *
 * The server stores and serves `form_public_key` in the clear, and a
 * respondent seals every answer to whatever it serves. Nothing the
 * respondent could authenticate committed to that key, so anyone able to
 * write the forms table could swap in their own and read every response
 * submitted afterwards, with the form still decrypting and looking exactly as
 * before. The schema is authenticated by the key in the link fragment, which
 * the server never sees, so a commitment inside it is one the server cannot
 * rewrite. BLAKE2b-256 over a domain string and the key bytes, the same
 * construction as the vault salts.
 */
export function formKeyCommitment(publicKeyBase64: string): string {
  const publicKey = sodium.from_base64(publicKeyBase64);
  const domain = sodium.from_string(FORM_KEY_COMMITMENT_DOMAIN);
  const input = new Uint8Array(domain.length + publicKey.length);
  input.set(domain, 0);
  input.set(publicKey, domain.length);
  return sodium.to_base64(sodium.crypto_generichash(32, input, null));
}

/** Whether a served public key is the one a schema committed to. */
export function matchesFormKeyCommitment(
  publicKeyBase64: string,
  commitment: string,
): boolean {
  try {
    const expected = sodium.from_base64(commitment);
    const actual = sodium.from_base64(formKeyCommitment(publicKeyBase64));
    return expected.length === actual.length && sodium.memcmp(expected, actual);
  } catch {
    // A key or commitment that does not even decode matches nothing.
    return false;
  }
}

// Frozen. Every answer key and grade blob is encrypted under a key derived
// with this string; changing it makes all of them unreadable.
const QUIZ_KEY_DOMAIN = "krypta:quiz-key:v1";

/**
 * The key a form's answer key and manual grades are encrypted under.
 *
 * Not the form data key: that key travels in every form link, so every
 * respondent holds it, and an answer key under it would be kept from them only
 * by the server choosing not to send it. The form private key is held by every
 * member with keys (the owner's master wrap, each collaborator's sealed grant)
 * and by no respondent, since responses are sealed to its public half. The
 * private key never rotates, so neither does this key.
 *
 * BLAKE2b-256 over a domain string and the key bytes, the same construction as
 * the passkey unlock key: the input is already a uniform 256-bit secret, so a
 * single hash is the whole derivation.
 */
export function deriveQuizKey(formPrivateKeyBase64: string): string {
  const privateKey = sodium.from_base64(formPrivateKeyBase64);
  const domain = sodium.from_string(QUIZ_KEY_DOMAIN);
  const input = new Uint8Array(domain.length + privateKey.length);
  input.set(domain, 0);
  input.set(privateKey, domain.length);
  return sodium.to_base64(
    sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, input, null),
  );
}

// Frozen, both of them. Every approval tag an owner has issued is computed
// under a key derived with the first and over a message beginning with the
// second; changing either makes every pending collaborator unapprovable.
const MEMBER_APPROVAL_KEY_DOMAIN = "krypta:member-approval-key:v1";
const MEMBER_APPROVAL_MESSAGE_DOMAIN = "krypta:member-approval:v1";

function memberApprovalKey(formPrivateKeyBase64: string): Uint8Array {
  const privateKey = sodium.from_base64(formPrivateKeyBase64);
  const domain = sodium.from_string(MEMBER_APPROVAL_KEY_DOMAIN);
  const input = new Uint8Array(domain.length + privateKey.length);
  input.set(domain, 0);
  input.set(privateKey, domain.length);
  return sodium.crypto_generichash(32, input, null);
}

/**
 * The owner's statement that an address was invited to a form, which the
 * owner's browser checks before it hands that member the form keys.
 *
 * The list of members waiting for keys comes from the server, and nothing in
 * it was authenticated by anything the owner holds, so a party able to write
 * the database could add a row for an account of their own and receive both
 * form keys on the owner's next dashboard load. This tag is made when the
 * owner invites and is keyed from the form private key, which no respondent
 * and no server holds, so it cannot be produced for an address the owner did
 * not invite. Not keyed from the form data key: that key is in every form
 * link. Keyed BLAKE2b-256, the same primitive as the commitments, over the
 * form id and the address trimmed and lowercased the way the API stores it.
 */
export function memberApprovalTag(
  formPrivateKeyBase64: string,
  formId: string,
  email: string,
): string {
  const message = sodium.from_string(
    `${MEMBER_APPROVAL_MESSAGE_DOMAIN}\u0000${formId}\u0000${email.trim().toLowerCase()}`,
  );
  return sodium.to_base64(
    sodium.crypto_generichash(32, message, memberApprovalKey(formPrivateKeyBase64)),
  );
}

/** Whether a stored approval tag is the owner's tag for this form and address. */
export function matchesMemberApprovalTag(
  tag: string,
  formPrivateKeyBase64: string,
  formId: string,
  email: string,
): boolean {
  try {
    const expected = sodium.from_base64(
      memberApprovalTag(formPrivateKeyBase64, formId, email),
    );
    const actual = sodium.from_base64(tag);
    return expected.length === actual.length && sodium.memcmp(expected, actual);
  } catch {
    // A tag that does not decode approves nothing.
    return false;
  }
}

// Frozen, both of them. Every pin a member's browser has written is computed
// under a key derived with the first and over a message beginning with the
// second; changing either makes every shared form refuse to open.
const FORM_KEY_PIN_KEY_DOMAIN = "krypta:form-key-pin-key:v1";
const FORM_KEY_PIN_MESSAGE_DOMAIN = "krypta:form-key-pin:v1";

function formKeyPinKey(accountKeyBase64: string): Uint8Array {
  const accountKey = sodium.from_base64(accountKeyBase64);
  const domain = sodium.from_string(FORM_KEY_PIN_KEY_DOMAIN);
  const input = new Uint8Array(domain.length + accountKey.length);
  input.set(domain, 0);
  input.set(accountKey, domain.length);
  return sodium.crypto_generichash(32, input, null);
}

/**
 * A member's own record of which key a shared form seals to, stored beside
 * their grant.
 *
 * A collaborator's grant is sealed to their public sharing key, and sealing
 * authenticates nobody: anyone able to write the database can seal a private
 * key of their own to that member. The pin is what tells the member's browser
 * the grant holds the form's real key. It is written when the member accepts,
 * from the key fingerprint in the invitation email (which the owner's browser
 * computed and the database never held), and keyed from the member's account
 * key, so no one else can produce one. The fingerprint itself is public, it is
 * in every share link, so the pin authenticates it rather than hiding it.
 * Keyed BLAKE2b-256 over the form id and the fingerprint, the same
 * construction as the owner approval tag.
 */
export function formKeyPin(
  accountKeyBase64: string,
  formId: string,
  keyFingerprint: string,
): string {
  const message = sodium.from_string(
    `${FORM_KEY_PIN_MESSAGE_DOMAIN}\u0000${formId}\u0000${keyFingerprint}`,
  );
  return sodium.to_base64(
    sodium.crypto_generichash(32, message, formKeyPinKey(accountKeyBase64)),
  );
}

/** Whether a stored pin is this account's pin of this fingerprint for this form. */
export function matchesFormKeyPin(
  pin: string,
  accountKeyBase64: string,
  formId: string,
  keyFingerprint: string,
): boolean {
  try {
    const expected = sodium.from_base64(
      formKeyPin(accountKeyBase64, formId, keyFingerprint),
    );
    const actual = sodium.from_base64(pin);
    return expected.length === actual.length && sodium.memcmp(expected, actual);
  } catch {
    // A pin that does not decode pins nothing.
    return false;
  }
}
