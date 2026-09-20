import { generateSealKeyPair } from "./keys"
import { sealBox, unsealBox } from "./seal"
import { unwrapKey, wrapKey } from "./wrap"

export type FormRole = "owner" | "editor" | "viewer"
export type FormKeyScheme = "master_wrap_v1" | "account_sealed_box_v1"

export interface AccountSharingKeyRecord {
  sharingPublicKey: string
  wrappedSharingPrivateKey: string
  version: 1
}

export interface EncryptedFormGrant {
  keyScheme: FormKeyScheme
  encryptedFormDataKey: string
  encryptedFormPrivateKey: string
}

export function createAccountSharingKey(
  masterKey: string
): AccountSharingKeyRecord {
  const pair = generateSealKeyPair()
  return {
    sharingPublicKey: pair.publicKey,
    wrappedSharingPrivateKey: wrapKey(pair.privateKey, masterKey),
    version: 1,
  }
}

export function openSharingPrivateKey(
  record: AccountSharingKeyRecord,
  masterKey: string
): string {
  return unwrapKey(record.wrappedSharingPrivateKey, masterKey)
}

export function sealFormGrant(
  formDataKey: string,
  formPrivateKey: string,
  recipientPublicKey: string
): EncryptedFormGrant {
  return {
    keyScheme: "account_sealed_box_v1",
    encryptedFormDataKey: sealBox(formDataKey, recipientPublicKey),
    encryptedFormPrivateKey: sealBox(formPrivateKey, recipientPublicKey),
  }
}

export function openSealedFormGrant(
  grant: EncryptedFormGrant,
  sharingPrivateKey: string
): { formDataKey: string; formPrivateKey: string } {
  if (grant.keyScheme !== "account_sealed_box_v1") {
    throw new Error("Unsupported form grant")
  }
  return {
    formDataKey: unsealBox(grant.encryptedFormDataKey, sharingPrivateKey),
    formPrivateKey: unsealBox(grant.encryptedFormPrivateKey, sharingPrivateKey),
  }
}
