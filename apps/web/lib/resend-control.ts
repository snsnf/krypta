export function resendControlState(
  cooldownSeconds: number,
  sending: boolean
): { disabled: boolean; label: string } {
  if (sending) {
    return { disabled: true, label: "Sending another code..." }
  }
  if (cooldownSeconds > 0) {
    return {
      disabled: true,
      label: `Send another code in ${cooldownSeconds}s`,
    }
  }
  return { disabled: false, label: "Send another code" }
}
