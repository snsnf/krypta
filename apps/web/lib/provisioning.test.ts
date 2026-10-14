import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  openMemberGrant: vi.fn(),
  sealFormGrant: vi.fn(),
  matchesMemberApprovalTag: vi.fn(),
}))

vi.mock("./api", () => ({
  apiFetch: mocks.apiFetch,
}))

vi.mock("./form-grants", () => ({
  openMemberGrant: mocks.openMemberGrant,
}))

vi.mock("@krypta/crypto", () => ({
  sealFormGrant: mocks.sealFormGrant,
  matchesMemberApprovalTag: mocks.matchesMemberApprovalTag,
}))

import type { AccountSharingMaterial } from "./account-sharing-key"
import { provisionPendingMembers } from "./provisioning"

const accountKey = "owner-master-key"
const formDataKey = "raw-form-data-key"
const formPrivateKey = "raw-form-private-key"
const recipientPublicKey = "recipient-public-key"
const sharingMaterial: AccountSharingMaterial = {
  sharingPublicKey: "owner-sharing-public-key",
  wrappedSharingPrivateKey: "owner-wrapped-sharing-private-key",
  sharingPrivateKey: "owner-sharing-private-key",
  version: 1,
}

const provisioningItem = {
  form_id: "0198-form-one",
  member_id: "0198-member-one",
  recipient_sharing_public_key: recipientPublicKey,
  owner_key_scheme: "master_wrap_v1" as const,
  owner_encrypted_form_data_key: "wrapped-owner-form-data-key",
  owner_encrypted_form_private_key: "wrapped-owner-form-private-key",
  member_email: "bob@example.com",
  approval_tag: "owner-approval-tag",
}

describe("provisionPendingMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openMemberGrant.mockReturnValue({ formDataKey, formPrivateKey })
    // Stand-in for the keyed tag: only the owner's tag for this address
    // verifies. Its binding to the form id is covered in @krypta/crypto.
    mocks.matchesMemberApprovalTag.mockImplementation(
      (tag: string, key: string, _formId: string, email: string) =>
        tag === "owner-approval-tag" &&
        key === formPrivateKey &&
        email === "bob@example.com"
    )
    mocks.sealFormGrant.mockReturnValue({
      keyScheme: "account_sealed_box_v1",
      encryptedFormDataKey: "sealed-form-data-key",
      encryptedFormPrivateKey: "sealed-form-private-key",
    })
  })

  it("activates a pending member with ciphertext only", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({ items: [provisioningItem] })
      .mockResolvedValueOnce({ membership_state: "active" })

    const activated = await provisionPendingMembers(accountKey, sharingMaterial)

    expect(activated).toBe(1)
    expect(mocks.openMemberGrant).toHaveBeenCalledWith(
      {
        membership_state: "active",
        key_scheme: "master_wrap_v1",
        encrypted_form_data_key: "wrapped-owner-form-data-key",
        encrypted_form_private_key: "wrapped-owner-form-private-key",
      },
      accountKey,
      sharingMaterial
    )
    expect(mocks.sealFormGrant).toHaveBeenCalledWith(
      formDataKey,
      formPrivateKey,
      recipientPublicKey
    )

    const putCall = mocks.apiFetch.mock.calls[1]
    expect(putCall[0]).toBe(
      "/forms/0198-form-one/members/0198-member-one/key-grant"
    )
    expect(putCall[1]?.method).toBe("PUT")
    expect(JSON.parse(String(putCall[1]?.body))).toEqual({
      recipient_sharing_public_key: recipientPublicKey,
      encrypted_form_data_key: "sealed-form-data-key",
      encrypted_form_private_key: "sealed-form-private-key",
    })
    expect(String(putCall[1]?.body)).not.toContain(formDataKey)
    expect(String(putCall[1]?.body)).not.toContain(formPrivateKey)
  })

  it("makes no activation request when no members need provisioning", async () => {
    mocks.apiFetch.mockResolvedValueOnce({ items: [] })

    const activated = await provisionPendingMembers(accountKey, sharingMaterial)

    expect(activated).toBe(0)
    expect(mocks.apiFetch).toHaveBeenCalledOnce()
    expect(mocks.apiFetch).toHaveBeenCalledWith("/sharing/provisioning")
    expect(mocks.openMemberGrant).not.toHaveBeenCalled()
    expect(mocks.sealFormGrant).not.toHaveBeenCalled()
  })

  it("continues after one activation fails and reports only a generic failure", async () => {
    const secondItem = {
      ...provisioningItem,
      form_id: "0198-form-two",
      member_id: "0198-member-two",
      recipient_sharing_public_key: "second-recipient-public-key",
    }
    mocks.apiFetch.mockImplementation(
      (path: string, init?: RequestInit): Promise<unknown> => {
        if (path === "/sharing/provisioning") {
          return Promise.resolve({ items: [provisioningItem, secondItem] })
        }
        if (path.includes("0198-member-one")) {
          return Promise.reject(new Error("activation failed"))
        }
        expect(init?.method).toBe("PUT")
        return Promise.resolve({ membership_state: "active" })
      }
    )
    const onItemFailure = vi.fn()

    const activated = await provisionPendingMembers(
      accountKey,
      sharingMaterial,
      onItemFailure
    )

    expect(activated).toBe(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/forms/0198-form-two/members/0198-member-two/key-grant",
      expect.objectContaining({ method: "PUT" })
    )
    expect(onItemFailure).toHaveBeenCalledOnce()
    expect(onItemFailure).toHaveBeenCalledWith("failed")
  })

  it("hands no keys to a member the owner never approved", async () => {
    // A row written straight into form_members carries no tag the owner made,
    // so the owner's browser must not seal the form keys to it.
    const injected = { ...provisioningItem, approval_tag: null }
    const forged = { ...provisioningItem, member_id: "0198-member-two", approval_tag: "forged" }
    mocks.apiFetch.mockResolvedValueOnce({ items: [injected, forged] })
    const onItemFailure = vi.fn()

    const activated = await provisionPendingMembers(
      accountKey,
      sharingMaterial,
      onItemFailure
    )

    expect(activated).toBe(0)
    expect(mocks.sealFormGrant).not.toHaveBeenCalled()
    expect(mocks.apiFetch).toHaveBeenCalledOnce()
    expect(onItemFailure).toHaveBeenCalledTimes(2)
    expect(onItemFailure).toHaveBeenCalledWith("unapproved")
  })

  it("refuses a tag made for another address", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      items: [{ ...provisioningItem, member_email: "eve@example.com" }],
    })

    const activated = await provisionPendingMembers(accountKey, sharingMaterial)

    expect(activated).toBe(0)
    expect(mocks.sealFormGrant).not.toHaveBeenCalled()
  })
})
