import {
  matchesMemberApprovalTag,
  sealFormGrant,
  type FormKeyScheme,
} from "@krypta/crypto"
import type { AccountSharingMaterial } from "./account-sharing-key"
import { apiFetch } from "./api"
import { openMemberGrant } from "./form-grants"

interface ProvisioningWireItem {
  form_id: string
  member_id: string
  recipient_sharing_public_key: string
  owner_key_scheme: FormKeyScheme
  owner_encrypted_form_data_key: string
  owner_encrypted_form_private_key: string
  member_email: string
  approval_tag: string | null
}

interface ProvisioningWireResponse {
  items: ProvisioningWireItem[]
}

/**
 * Why one pending member was not given keys. `unapproved` is not a transient
 * fault: the member carries no tag this form's owner made, so refreshing will
 * not help, and the owner has to remove and re-invite them.
 */
export type ProvisioningFailure = "failed" | "unapproved"

type ProvisioningFailureHandler = (reason: ProvisioningFailure) => void

function reportItemFailure(
  onItemFailure: ProvisioningFailureHandler | undefined,
  reason: ProvisioningFailure
): void {
  try {
    onItemFailure?.(reason)
  } catch {
    // Reporting is best-effort and must not prevent later activations.
  }
}

export async function provisionPendingMembers(
  accountKey: string,
  sharingMaterial: AccountSharingMaterial,
  onItemFailure?: ProvisioningFailureHandler
): Promise<number> {
  const { items } = await apiFetch<ProvisioningWireResponse>(
    "/sharing/provisioning"
  )
  let activated = 0

  for (const item of items) {
    try {
      const { formDataKey, formPrivateKey } = openMemberGrant(
        {
          membership_state: "active",
          key_scheme: item.owner_key_scheme,
          encrypted_form_data_key: item.owner_encrypted_form_data_key,
          encrypted_form_private_key: item.owner_encrypted_form_private_key,
        },
        accountKey,
        sharingMaterial
      )
      // The server builds this list, and anyone able to write its tables could
      // add a member of their own to it. Keys go only to an address this form's
      // owner approved, with a tag made under a key the server never holds.
      // A member without one (invited before tags existed, or never invited
      // at all) is reported, not served: the owner can remove and re-invite.
      if (
        item.approval_tag === null ||
        !matchesMemberApprovalTag(
          item.approval_tag,
          formPrivateKey,
          item.form_id,
          item.member_email
        )
      ) {
        reportItemFailure(onItemFailure, "unapproved")
        continue
      }
      const sealedGrant = sealFormGrant(
        formDataKey,
        formPrivateKey,
        item.recipient_sharing_public_key
      )

      await apiFetch<{ membership_state: "active" }>(
        `/forms/${item.form_id}/members/${item.member_id}/key-grant`,
        {
          method: "PUT",
          body: JSON.stringify({
            recipient_sharing_public_key: item.recipient_sharing_public_key,
            encrypted_form_data_key: sealedGrant.encryptedFormDataKey,
            encrypted_form_private_key: sealedGrant.encryptedFormPrivateKey,
          }),
        }
      )
      activated += 1
    } catch {
      reportItemFailure(onItemFailure, "failed")
    }
  }

  return activated
}
