import {
  sealFormGrant,
  type EncryptedFormGrant,
  type FormRole,
} from "@krypta/crypto"
import { apiFetch } from "./api"

type InvitationRole = Exclude<FormRole, "owner">

interface RecipientKeyResponse {
  sharing_public_key: string | null
  sharing_key_version: number | null
}

interface SendInvitationInput {
  formId: string
  invitationId?: string
  email: string
  role: InvitationRole
  formDataKey: string
  formPrivateKey: string
}

export type InvitationApiFetch = <T>(
  path: string,
  init?: RequestInit
) => Promise<T>

export type InvitationSealer = (
  formDataKey: string,
  formPrivateKey: string,
  recipientPublicKey: string
) => EncryptedFormGrant

interface SendInvitationDependencies {
  apiFetch: InvitationApiFetch
  sealFormGrant: InvitationSealer
}

const defaultDependencies: SendInvitationDependencies = {
  apiFetch,
  sealFormGrant,
}

function trySealGrant(
  recipient: RecipientKeyResponse,
  formDataKey: string,
  formPrivateKey: string,
  seal: InvitationSealer
): {
  recipientSharingPublicKey: string | null
  encryptedFormDataKey: string | null
  encryptedFormPrivateKey: string | null
} {
  if (
    recipient.sharing_key_version !== 1 ||
    typeof recipient.sharing_public_key !== "string" ||
    recipient.sharing_public_key.length === 0
  ) {
    return {
      recipientSharingPublicKey: null,
      encryptedFormDataKey: null,
      encryptedFormPrivateKey: null,
    }
  }

  try {
    const grant = seal(
      formDataKey,
      formPrivateKey,
      recipient.sharing_public_key
    )
    return {
      recipientSharingPublicKey: recipient.sharing_public_key,
      encryptedFormDataKey: grant.encryptedFormDataKey,
      encryptedFormPrivateKey: grant.encryptedFormPrivateKey,
    }
  } catch {
    return {
      recipientSharingPublicKey: null,
      encryptedFormDataKey: null,
      encryptedFormPrivateKey: null,
    }
  }
}

export async function sendInvitation(
  input: SendInvitationInput,
  dependencies: SendInvitationDependencies = defaultDependencies
): Promise<void> {
  const recipient = await dependencies.apiFetch<RecipientKeyResponse>(
    `/forms/${input.formId}/invitations/recipient-key`,
    {
      method: "POST",
      body: JSON.stringify({ invited_email: input.email }),
    }
  )
  const grant = trySealGrant(
    recipient,
    input.formDataKey,
    input.formPrivateKey,
    dependencies.sealFormGrant
  )
  const invitationPath = input.invitationId
    ? `/forms/${input.formId}/invitations/${input.invitationId}/resend`
    : `/forms/${input.formId}/invitations`

  await dependencies.apiFetch(invitationPath, {
    method: "POST",
    body: JSON.stringify({
      invited_email: input.email,
      role: input.role,
      recipient_sharing_public_key: grant.recipientSharingPublicKey,
      encrypted_form_data_key: grant.encryptedFormDataKey,
      encrypted_form_private_key: grant.encryptedFormPrivateKey,
    }),
  })
}
