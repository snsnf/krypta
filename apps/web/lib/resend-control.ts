import { appTranslator, type AppTranslator } from "./app-i18n"

/**
 * The resend button's state and label. The label is worded by `t`, which
 * defaults to English so callers that do not pass one behave as they always did.
 */
export function resendControlState(
  cooldownSeconds: number,
  sending: boolean,
  t: AppTranslator = appTranslator("en")
): { disabled: boolean; label: string } {
  if (sending) {
    return { disabled: true, label: t("auth.resend.sendingAnother") }
  }
  if (cooldownSeconds > 0) {
    return {
      disabled: true,
      label: t("auth.resend.sendAnotherIn", { seconds: cooldownSeconds }),
    }
  }
  return { disabled: false, label: t("auth.resend.sendAnother") }
}
