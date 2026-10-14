import { formKeyCommitment, sealPublicKeyFromPrivate } from "@krypta/crypto"

/**
 * One named value from a link fragment such as `#token=...&key=...`, decoded,
 * or null when it is absent.
 *
 * A value that is not valid percent-encoding is also null rather than a
 * thrown URIError. The fill and edit pages decode inside an effect nobody
 * awaits, so a throw there left the page on its loading spinner forever; a
 * value that cannot be decoded is exactly as unusable as a missing one, and
 * both pages already say "This link is incomplete" for that.
 *
 * `name` is always a literal chosen by the caller, never user input, so it is
 * safe to place in the pattern.
 */
export function readFragmentParam(hash: string, name: string): string | null {
  const match = new RegExp(`(?:^#|&)${name}=([^&]+)`).exec(hash)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/**
 * The respondent link for a form: the data key that opens the schema, and a
 * fingerprint of the key answers are sealed to.
 *
 * The fingerprint is there because the data key cannot vouch for the seal
 * target on its own. Every respondent holds that key, so anyone with the link
 * can decrypt the schema, rewrite the commitment inside it and encrypt it
 * again; with write access to the forms row they could then serve a key of
 * their own that passes the commitment check. A value in the fragment is
 * fixed when a member copies the link and never reaches the server, so no
 * database write can change it. It is computed from the member's private key,
 * which the workspace has already checked against the schema, never from the
 * served public key.
 */
export function formShareLink(
  origin: string,
  formId: string,
  formDataKey: string,
  formPrivateKey: string
): string {
  const fingerprint = formKeyCommitment(sealPublicKeyFromPrivate(formPrivateKey))
  return `${origin}/f/${formId}#key=${encodeURIComponent(formDataKey)}&pk=${encodeURIComponent(fingerprint)}`
}

/**
 * The link a respondent keeps to edit their answer. It carries the same key
 * fingerprint as the link they arrived through, when that link had one, so
 * editing is held to the same check as submitting.
 */
export function responseEditLink(
  origin: string,
  formId: string,
  editToken: string,
  formDataKey: string,
  keyFingerprint: string | null
): string {
  const pk =
    keyFingerprint === null ? "" : `&pk=${encodeURIComponent(keyFingerprint)}`
  return `${origin}/f/${formId}/r#token=${encodeURIComponent(editToken)}&key=${encodeURIComponent(formDataKey)}${pk}`
}
