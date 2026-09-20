import { apiFetch } from "./api"

interface MemberControlSubject {
  role: "owner" | "editor" | "viewer"
  state: "active" | "awaiting_keys"
}

interface MemberControlAvailability {
  canChangeRole: boolean
  canRemove: boolean
  canTransfer: boolean
}

export type SharingMutationFetch = <T>(
  path: string,
  init?: RequestInit
) => Promise<T>

export function memberControls(
  member: MemberControlSubject
): MemberControlAvailability {
  const isCollaborator = member.role === "editor" || member.role === "viewer"
  const isActiveCollaborator = isCollaborator && member.state === "active"
  return {
    canChangeRole: isActiveCollaborator,
    canRemove: isCollaborator,
    canTransfer: isActiveCollaborator,
  }
}

export async function transferOwnership(
  formId: string,
  memberId: string,
  onOwnershipTransferred: () => void,
  request: SharingMutationFetch = apiFetch
): Promise<void> {
  await request(`/forms/${formId}/transfer-ownership`, {
    method: "POST",
    body: JSON.stringify({ member_id: memberId }),
  })
  onOwnershipTransferred()
}
