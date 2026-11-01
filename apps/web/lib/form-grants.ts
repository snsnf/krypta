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
  matchesFormKeyPin,
  openSealedFormGrant,
  unwrapKey,
  type FormKeyScheme,
} from "@krypta/crypto"
import type { AccountSharingMaterial } from "./account-sharing-key"
import { formKeyFingerprint } from "./form-link"
import { FormKeyMismatchError } from "./load-public-form"

export interface MemberGrant {
  membership_state: "active" | "awaiting_keys"
  key_scheme: FormKeyScheme | null
  encrypted_form_data_key: string | null
  encrypted_form_private_key: string | null
  /** This member's pin of the form's key, made when they accepted. */
  key_pin: string | null
}

/**
 * Opens this member's grant for `formId`.
 *
 * An owner's grant is wrapped under their own account key, which nobody else
 * can produce, so it is trusted as it opens. A collaborator's grant is sealed
 * to their public sharing key, and anyone able to write the database can seal
 * a private key of their own to that, so a sealed grant opens only when the
 * key inside matches the pin the member made on accepting, from the key
 * fingerprint in their invitation email. A sealed grant with no pin is refused
 * too: a missing pin is what a planted grant would look like, and there is no
 * fallback that trusts what was served. Both refusals throw
 * `FormKeyMismatchError`, so the workspace says the form cannot be trusted.
 */
export function openMemberGrant(
  grant: MemberGrant,
  accountKey: string,
  sharing: AccountSharingMaterial,
  formId: string
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
    const opened = openSealedFormGrant(
      {
        keyScheme: "account_sealed_box_v1",
        encryptedFormDataKey: grant.encrypted_form_data_key,
        encryptedFormPrivateKey: grant.encrypted_form_private_key,
      },
      sharing.sharingPrivateKey
    )
    if (
      typeof grant.key_pin !== "string" ||
      !matchesFormKeyPin(
        grant.key_pin,
        accountKey,
        formId,
        formKeyFingerprint(opened.formPrivateKey)
      )
    ) {
      throw new FormKeyMismatchError()
    }
    return opened
  }

  throw new Error("Unsupported form access")
}
