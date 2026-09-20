export type SafeAuthReturn = "/dashboard" | "/invitations/accept"

export function safeAuthReturn(value: string | null): SafeAuthReturn {
  return value === "/invitations/accept" ? "/invitations/accept" : "/dashboard"
}
