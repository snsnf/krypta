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

export function takeInvitationToken(
  fragment: string,
  replaceState: ReplaceState
): string | null {
  if (fragment.length === 0) return null

  const params = new URLSearchParams(
    fragment.startsWith("#") ? fragment.slice(1) : fragment
  )
  const entries = [...params.entries()]

  // Clear the entire fragment before the caller can start any asynchronous
  // work. This also removes malformed fragments rather than reflecting them.
  replaceState(null, "", "/invitations/accept")

  if (
    entries.length !== 1 ||
    entries[0][0] !== "token" ||
    entries[0][1].length === 0
  ) {
    return null
  }
  return entries[0][1]
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
