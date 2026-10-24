/**
 * The longest description the builder accepts. The schema is padded and
 * encrypted whole, so this bounds what one field can add to it rather than
 * protecting the server, which never reads it.
 */
export const FORM_DESCRIPTION_MAX_LENGTH = 2000

/**
 * A form's description as it is kept in the schema: the text exactly as
 * typed, or undefined when there is none. Undefined rather than an empty
 * string, so a form with no description serialises exactly as one written
 * before descriptions existed. Every decrypted schema passes through here,
 * since a schema is untrusted input until it has been checked.
 */
export function normalizeFormDescription(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}
