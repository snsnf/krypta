import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  unwrapKey: vi.fn(),
  openSealedFormGrant: vi.fn(),
}))

vi.mock("@krypta/crypto", () => ({
  unwrapKey: mocks.unwrapKey,
  openSealedFormGrant: mocks.openSealedFormGrant,
}))

import type { AccountSharingMaterial } from "./account-sharing-key"
import { openMemberGrant, type MemberGrant } from "./form-grants"

const sharing: AccountSharingMaterial = {
  sharingPublicKey: "sharing-public",
  wrappedSharingPrivateKey: "sharing-wrapped-private",
  sharingPrivateKey: "sharing-private",
  version: 1,
}

describe("openMemberGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("unwraps both Owner ciphertexts with the master key", () => {
    mocks.unwrapKey
      .mockReturnValueOnce("form-data-key")
      .mockReturnValueOnce("form-private-key")

    const opened = openMemberGrant(
      {
        membership_state: "active",
        key_scheme: "master_wrap_v1",
        encrypted_form_data_key: "wrapped-data",
        encrypted_form_private_key: "wrapped-private",
      },
      "master-key",
      sharing
    )

    expect(opened).toEqual({
      formDataKey: "form-data-key",
      formPrivateKey: "form-private-key",
    })
    expect(mocks.unwrapKey).toHaveBeenNthCalledWith(
      1,
      "wrapped-data",
      "master-key"
    )
    expect(mocks.unwrapKey).toHaveBeenNthCalledWith(
      2,
      "wrapped-private",
      "master-key"
    )
    expect(mocks.openSealedFormGrant).not.toHaveBeenCalled()
  })

  it("opens a collaborator grant with the current account sharing key pair", () => {
    mocks.openSealedFormGrant.mockReturnValue({
      formDataKey: "form-data-key",
      formPrivateKey: "form-private-key",
    })

    const opened = openMemberGrant(
      {
        membership_state: "active",
        key_scheme: "account_sealed_box_v1",
        encrypted_form_data_key: "sealed-data",
        encrypted_form_private_key: "sealed-private",
      },
      "master-key",
      sharing
    )

    expect(opened).toEqual({
      formDataKey: "form-data-key",
      formPrivateKey: "form-private-key",
    })
    expect(mocks.openSealedFormGrant).toHaveBeenCalledWith(
      {
        keyScheme: "account_sealed_box_v1",
        encryptedFormDataKey: "sealed-data",
        encryptedFormPrivateKey: "sealed-private",
      },
      "sharing-private"
    )
    expect(mocks.unwrapKey).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "awaiting membership",
      grant: {
        membership_state: "awaiting_keys",
        key_scheme: null,
        encrypted_form_data_key: null,
        encrypted_form_private_key: null,
      },
    },
    {
      name: "null scheme",
      grant: {
        membership_state: "active",
        key_scheme: null,
        encrypted_form_data_key: "ciphertext",
        encrypted_form_private_key: "ciphertext",
      },
    },
    {
      name: "unknown scheme",
      grant: {
        membership_state: "active",
        key_scheme: "future_scheme",
        encrypted_form_data_key: "ciphertext",
        encrypted_form_private_key: "ciphertext",
      },
    },
    {
      name: "incomplete ciphertexts",
      grant: {
        membership_state: "active",
        key_scheme: "master_wrap_v1",
        encrypted_form_data_key: "ciphertext",
        encrypted_form_private_key: null,
      },
    },
  ])("rejects a $name before invoking crypto", ({ grant }) => {
    expect(() =>
      openMemberGrant(grant as MemberGrant, "master-key", sharing)
    ).toThrow()

    expect(mocks.unwrapKey).not.toHaveBeenCalled()
    expect(mocks.openSealedFormGrant).not.toHaveBeenCalled()
  })
})
