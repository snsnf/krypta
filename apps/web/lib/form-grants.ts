"use client"

/*
 * Opening a grant unwraps or decapsulates with the user's own key, and the
 * hybrid KEM's decapsulation is not constant time. That is tolerable only
 * because it runs in the user's own browser: the cost of a timing attack there
 * is one user's own key, while a server-side path would put every account at
 * risk. This directive is what keeps that structural. Calling any of this from
 * a server component or a route handler is a build error rather than something
 * a reviewer has to catch, which is what the project guidance previously had to
 * rely on.
 */
import {
  openSealedFormGrant,
  unwrapKey,
  type FormKeyScheme,
} from "@krypta/crypto"
import type { AccountSharingMaterial } from "./account-sharing-key"

export interface MemberGrant {
  membership_state: "active" | "awaiting_keys"
  key_scheme: FormKeyScheme | null
  encrypted_form_data_key: string | null
  encrypted_form_private_key: string | null
}

export function openMemberGrant(
  grant: MemberGrant,
  accountKey: string,
  sharing: AccountSharingMaterial
): { formDataKey: string; formPrivateKey: string } {
  if (
    grant.membership_state !== "active" ||
    typeof grant.encrypted_form_data_key !== "string" ||
    grant.encrypted_form_data_key.length === 0 ||
    typeof grant.encrypted_form_private_key !== "string" ||
    grant.encrypted_form_private_key.length === 0
  ) {
    throw new Error("Form access is not ready")
  }

  if (grant.key_scheme === "master_wrap_v1") {
    return {
      formDataKey: unwrapKey(grant.encrypted_form_data_key, accountKey),
      formPrivateKey: unwrapKey(grant.encrypted_form_private_key, accountKey),
    }
  }

  if (grant.key_scheme === "account_sealed_box_v1") {
    return openSealedFormGrant(
      {
        keyScheme: "account_sealed_box_v1",
        encryptedFormDataKey: grant.encrypted_form_data_key,
        encryptedFormPrivateKey: grant.encrypted_form_private_key,
      },
      sharing.sharingPrivateKey
    )
  }

  throw new Error("Unsupported form access")
}
