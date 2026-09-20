import { apiFetch } from "./api"
import { useAuthStore } from "./auth-store"
import { clearPersistedAccountKey } from "./device-key"

const invitationLogin = "/login?next=%2Finvitations%2Faccept"

export interface InvitationAccountSwitchProgress {
  userId: string | null
  serverLoggedOut: boolean
}

export function createInvitationAccountSwitchProgress(): InvitationAccountSwitchProgress {
  return { userId: null, serverLoggedOut: false }
}

export async function switchInvitationAccount(
  progress: InvitationAccountSwitchProgress,
  navigate: (destination: string) => void
): Promise<"complete" | "failed"> {
  progress.userId ??= useAuthStore.getState().userId
  if (progress.userId === null) return "failed"

  if (!progress.serverLoggedOut) {
    try {
      await apiFetch<Record<string, never>>("/auth/logout", { method: "POST" })
      progress.serverLoggedOut = true
    } catch {
      return "failed"
    }
  }

  try {
    if (!(await clearPersistedAccountKey(progress.userId))) return "failed"
  } catch {
    return "failed"
  }

  useAuthStore.getState().clear()
  navigate(invitationLogin)
  return "complete"
}
