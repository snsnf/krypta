import { sealFormGrant, type FormKeyScheme } from "@krypta/crypto"
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
}

interface ProvisioningWireResponse {
  items: ProvisioningWireItem[]
}

type ProvisioningFailureHandler = () => void

function reportItemFailure(onItemFailure?: ProvisioningFailureHandler): void {
  try {
    onItemFailure?.()
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
      reportItemFailure(onItemFailure)
    }
  }

  return activated
}
