import { ApiClientError } from "./api"

export type InvitationRole = "editor" | "viewer"

export type InvitationViewState =
  | { kind: "exchanging" }
  | { kind: "signed_out" }
  | { kind: "ready"; role: InvitationRole; maskedEmail: string }
  | { kind: "accepting"; role: InvitationRole }
  | { kind: "awaiting_keys" }
  | { kind: "active"; formId: string }
  | { kind: "wrong_account" }
  | { kind: "invalid" }

// Any UUID version, deliberately. This check exists to reject a value that is
// not an id at all before it is interpolated into a dashboard URL, not to
// assert which generator made it. Pinning the version nibble to 7 broke
// acceptance outright the day form ids moved to v4: the server made the
// caller an editor and the browser told them the invitation was expired.
// Form ids are v4 because they appear in public links; see design rule 5 in
// the root CLAUDE.md for why the two versions coexist.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ReplaceState = (
  data: unknown,
  unused: string,
  url?: string | URL | null
) => void

/**
 * The form an invitation is for and its key fingerprint, as the owner's
 * browser sent them into the emailed link. What the recipient's browser pins
 * on accepting.
 */
export interface InvitationKey {
  formId: string
  keyFingerprint: string
}

/**
 * What an invitation link carries in its fragment: the token, and the form and
 * its key fingerprint. The key is null for a link sent before invitations
 * carried one; such a link can still be opened, but not accepted, since there
 * would be nothing to pin.
 */
export interface InvitationLink {
  token: string
  key: InvitationKey | null
}

export function takeInvitationLink(
  fragment: string,
  replaceState: ReplaceState
): InvitationLink | null {
  if (fragment.length === 0) return null

  const params = new URLSearchParams(
    fragment.startsWith("#") ? fragment.slice(1) : fragment
  )
  const entries = [...params.entries()]

  // Clear the entire fragment before the caller can start any asynchronous
  // work. This also removes malformed fragments rather than reflecting them.
  replaceState(null, "", "/invitations/accept")

  const names = entries.map(([name]) => name)
  const token = params.get("token")
  const formId = params.get("form")
  const keyFingerprint = params.get("pk")
  if (
    token === null ||
    token.length === 0 ||
    names.some((name) => !["token", "form", "pk"].includes(name)) ||
    new Set(names).size !== names.length ||
    (formId === null) !== (keyFingerprint === null)
  ) {
    return null
  }
  if (formId === null || keyFingerprint === null) return { token, key: null }
  if (!UUID_PATTERN.test(formId) || keyFingerprint.length === 0) return null
  return { token, key: { formId, keyFingerprint } }
}

// Where the key waits while the recipient signs in, signs up or unlocks:
// those detours leave this page, and the fragment is gone by then. Session
// storage rather than local, so it never outlives the tab.
const INVITATION_KEY_STORAGE_KEY = "krypta:invitation-key"

/** Keeps the key of the link just opened, replacing any earlier one. */
export function rememberInvitationKey(
  storage: Storage,
  key: InvitationKey | null
): void {
  try {
    if (key === null) {
      storage.removeItem(INVITATION_KEY_STORAGE_KEY)
    } else {
      storage.setItem(INVITATION_KEY_STORAGE_KEY, JSON.stringify(key))
    }
  } catch {
    // Storage can be blocked; acceptance then refuses for want of a pin.
  }
}

export function recallInvitationKey(storage: Storage): InvitationKey | null {
  try {
    const stored: unknown = JSON.parse(
      storage.getItem(INVITATION_KEY_STORAGE_KEY) ?? "null"
    )
    if (
      typeof stored === "object" &&
      stored !== null &&
      "formId" in stored &&
      "keyFingerprint" in stored &&
      typeof stored.formId === "string" &&
      UUID_PATTERN.test(stored.formId) &&
      typeof stored.keyFingerprint === "string" &&
      stored.keyFingerprint.length > 0
    ) {
      return { formId: stored.formId, keyFingerprint: stored.keyFingerprint }
    }
    return null
  } catch {
    return null
  }
}

export function forgetInvitationKey(storage: Storage): void {
  rememberInvitationKey(storage, null)
}

export function currentInvitationViewState(
  value: unknown
): InvitationViewState {
  if (typeof value !== "object" || value === null) return { kind: "invalid" }

  const invitation = value as Record<string, unknown>
  if (
    (invitation.role !== "editor" && invitation.role !== "viewer") ||
    invitation.status !== "pending" ||
    typeof invitation.masked_email !== "string" ||
    !invitation.masked_email.includes("*") ||
    typeof invitation.grant_ready !== "boolean"
  ) {
    return { kind: "invalid" }
  }

  return {
    kind: "ready",
    role: invitation.role,
    maskedEmail: invitation.masked_email,
  }
}

export function acceptanceViewState(value: unknown): InvitationViewState {
  if (typeof value !== "object" || value === null) return { kind: "invalid" }

  const acceptance = value as Record<string, unknown>
  if (
    typeof acceptance.form_id !== "string" ||
    !UUID_PATTERN.test(acceptance.form_id)
  ) {
    return { kind: "invalid" }
  }
  if (acceptance.membership_state === "awaiting_keys") {
    return { kind: "awaiting_keys" }
  }
  if (acceptance.membership_state === "active") {
    return { kind: "active", formId: acceptance.form_id }
  }
  return { kind: "invalid" }
}

export function invitationErrorViewState(error: unknown): InvitationViewState {
  if (error instanceof ApiClientError) {
    if (error.code === "unauthorized") return { kind: "signed_out" }
    if (error.code === "wrong_account") return { kind: "wrong_account" }
  }
  return { kind: "invalid" }
}
