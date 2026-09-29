import { decryptWithKey, type FormRole } from "@krypta/crypto"
import type { AccountSharingMaterial } from "./account-sharing-key"
import type { FormListWireItem } from "./api"
import { openMemberGrant } from "./form-grants"

export type { FormListWireItem } from "./api"

export interface DashboardFormListItem {
  id: string
  role: FormRole
  title: string
  createdAt: string
  accessState: "ready" | "awaiting" | "unavailable"
  formDataKey: string | null
  /**
   * The version this title was read at. A rename sends it as
   * `expected_version`, so an edit made against a title someone else has since
   * changed is refused rather than silently overwriting them.
   */
  version: number | null
}

const awaitingTitle = "Shared form: waiting for secure access"

export function decryptFormList(
  rawForms: FormListWireItem[],
  accountKey: string,
  sharingMaterial: AccountSharingMaterial
): DashboardFormListItem[] {
  return rawForms.map((form) => {
    const base = {
      id: form.id,
      role: form.role,
      createdAt: form.created_at,
      version: form.version,
    }

    if (
      form.membership_state !== "active" ||
      form.title_ciphertext === null ||
      form.key_scheme === null ||
      form.encrypted_form_data_key === null ||
      form.encrypted_form_private_key === null
    ) {
      return {
        ...base,
        title: awaitingTitle,
        accessState: "awaiting" as const,
        formDataKey: null,
      }
    }

    try {
      const { formDataKey } = openMemberGrant(form, accountKey, sharingMaterial)
      return {
        ...base,
        title: decryptWithKey(form.title_ciphertext, formDataKey),
        accessState: "ready" as const,
        formDataKey,
      }
    } catch {
      return {
        ...base,
        title: "Form unavailable",
        accessState: "unavailable" as const,
        formDataKey: null,
      }
    }
  })
}

export function groupDashboardForms(forms: DashboardFormListItem[]): {
  owned: DashboardFormListItem[]
  shared: DashboardFormListItem[]
} {
  return {
    owned: forms.filter((form) => form.role === "owner"),
    shared: forms.filter((form) => form.role !== "owner"),
  }
}

/**
 * Owners and Editors can duplicate: the people who can already change the
 * content. The copy belongs to whoever makes it.
 */
export function canDuplicate(
  form: Pick<DashboardFormListItem, "role" | "accessState">
): boolean {
  return (
    (form.role === "owner" || form.role === "editor") &&
    form.accessState === "ready"
  )
}
