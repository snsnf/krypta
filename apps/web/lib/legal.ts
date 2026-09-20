/**
 * Who operates this instance, for the pages that have to name someone.
 *
 * `/security` describes the software and is true of every instance, so it
 * ships as it is. A privacy policy and a set of terms cannot work that way:
 * they are promises made by a particular operator to their own users, and the
 * published image is run by people we have never met. Baking one operator's
 * company and contact address into it would hand every self-hoster a legal
 * document naming the wrong party, which is worse than having no page at all
 * because it reads as binding.
 *
 * So the pages are configuration, in the same way billing is: an instance that
 * has not named an operator does not serve them, and nothing links to them.
 * Setting both values is the operator saying the text is theirs.
 *
 * Read at request time and deliberately not `NEXT_PUBLIC_`, exactly as
 * `SITE_URL` is: a `NEXT_PUBLIC_` value is compiled into the bundle, so one
 * published image would carry whichever operator happened to build it.
 */
export interface LegalIdentity {
  /** The legal person who runs this instance, as it should appear in a contract. */
  entity: string
  /** Where to reach them about privacy, data requests and the terms. */
  contactEmail: string
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim()
  return text === undefined || text === "" ? null : text
}

/**
 * The configured operator, or null when this instance has not named one.
 *
 * Both the entity and the contact address are required together. A policy that
 * names a company with no way to reach it fails the one thing a reader needs
 * it for, which is knowing where to send a request about their own data.
 */
export function legalIdentity(): LegalIdentity | null {
  const entity = trimmed(process.env.LEGAL_ENTITY)
  const contactEmail = trimmed(process.env.LEGAL_CONTACT_EMAIL)
  if (entity === null || contactEmail === null) return null
  return { entity, contactEmail }
}
