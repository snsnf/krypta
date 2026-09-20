import type { FormSettings } from "@krypta/crypto"

export const DEFAULT_FORM_SETTINGS: FormSettings = {
  allowMultipleResponses: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeFormSettings(value: unknown): FormSettings {
  if (!isRecord(value)) return { ...DEFAULT_FORM_SETTINGS }
  return {
    allowMultipleResponses:
      typeof value.allowMultipleResponses === "boolean"
        ? value.allowMultipleResponses
        : DEFAULT_FORM_SETTINGS.allowMultipleResponses,
    confirmationMessage:
      typeof value.confirmationMessage === "string" &&
      value.confirmationMessage.trim() !== ""
        ? value.confirmationMessage
        : undefined,
  }
}
