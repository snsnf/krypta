import { describe, expect, it, vi } from "vitest"
import type { EncryptedFormGrant } from "@krypta/crypto"
import {
  sendInvitation,
  type InvitationApiFetch,
  type InvitationSealer,
} from "./sharing-invitations"

describe("sendInvitation", () => {
  it("sends only recipient-sealed grants when the latest sharing key is usable", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []
    const apiFetch = vi.fn(async <T>(path: string, init?: RequestInit) => {
      requests.push({ path, init })
      return (
        requests.length === 1
          ? {
              sharing_public_key: "recipient-public-key",
              sharing_key_version: 1,
            }
          : {}
      ) as T
    }) as InvitationApiFetch
    const sealFormGrant = vi.fn((): EncryptedFormGrant => ({
      keyScheme: "account_sealed_box_v1",
      encryptedFormDataKey: "sealed-data-key",
      encryptedFormPrivateKey: "sealed-private-key",
    })) as InvitationSealer

    await sendInvitation(
      {
        formId: "018f0000-0000-7000-8000-000000000001",
        email: "collaborator@example.com",
        role: "editor",
        formDataKey: "raw-data-key",
        formPrivateKey: "raw-private-key",
      },
      { apiFetch, sealFormGrant }
    )

    expect(sealFormGrant).toHaveBeenCalledWith(
      "raw-data-key",
      "raw-private-key",
      "recipient-public-key"
    )
    expect(requests.map(({ path }) => path)).toEqual([
      "/forms/018f0000-0000-7000-8000-000000000001/invitations/recipient-key",
      "/forms/018f0000-0000-7000-8000-000000000001/invitations",
    ])
    expect(JSON.parse(requests[1]!.init?.body as string)).toEqual({
      invited_email: "collaborator@example.com",
      role: "editor",
      recipient_sharing_public_key: "recipient-public-key",
      encrypted_form_data_key: "sealed-data-key",
      encrypted_form_private_key: "sealed-private-key",
    })
    expect(requests[1]!.init?.body).not.toContain("raw-data-key")
    expect(requests[1]!.init?.body).not.toContain("raw-private-key")
  })

  it.each([
    {
      name: "no recipient key",
      lookup: { sharing_public_key: null, sharing_key_version: null },
    },
    {
      name: "unsupported key version",
      lookup: {
        sharing_public_key: "future-public-key",
        sharing_key_version: 2,
      },
    },
  ])("sends an explicit null grant for $name", async ({ lookup }) => {
    const requests: Array<{ path: string; init?: RequestInit }> = []
    const apiFetch = vi.fn(async <T>(path: string, init?: RequestInit) => {
      requests.push({ path, init })
      return (requests.length === 1 ? lookup : {}) as T
    }) as InvitationApiFetch
    const sealFormGrant = vi.fn() as InvitationSealer

    await sendInvitation(
      {
        formId: "018f0000-0000-7000-8000-000000000001",
        email: "collaborator@example.com",
        role: "viewer",
        formDataKey: "raw-data-key",
        formPrivateKey: "raw-private-key",
      },
      { apiFetch, sealFormGrant }
    )

    expect(sealFormGrant).not.toHaveBeenCalled()
    expect(JSON.parse(requests[1]!.init?.body as string)).toEqual({
      invited_email: "collaborator@example.com",
      role: "viewer",
      recipient_sharing_public_key: null,
      encrypted_form_data_key: null,
      encrypted_form_private_key: null,
    })
  })

  it("falls back to an explicit null grant when a version-one key cannot be sealed", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []
    const apiFetch = vi.fn(async <T>(path: string, init?: RequestInit) => {
      requests.push({ path, init })
      return (
        requests.length === 1
          ? { sharing_public_key: "malformed-key", sharing_key_version: 1 }
          : {}
      ) as T
    }) as InvitationApiFetch
    const sealFormGrant = vi.fn(() => {
      throw new Error("invalid recipient key")
    }) as InvitationSealer

    await sendInvitation(
      {
        formId: "018f0000-0000-7000-8000-000000000001",
        email: "collaborator@example.com",
        role: "viewer",
        formDataKey: "raw-data-key",
        formPrivateKey: "raw-private-key",
      },
      { apiFetch, sealFormGrant }
    )

    expect(JSON.parse(requests[1]!.init?.body as string)).toEqual({
      invited_email: "collaborator@example.com",
      role: "viewer",
      recipient_sharing_public_key: null,
      encrypted_form_data_key: null,
      encrypted_form_private_key: null,
    })
  })

  it("reseals a resend for the invitation's latest email and exact endpoint", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []
    const apiFetch = vi.fn(async <T>(path: string, init?: RequestInit) => {
      requests.push({ path, init })
      return (
        requests.length === 1
          ? { sharing_public_key: "latest-public-key", sharing_key_version: 1 }
          : {}
      ) as T
    }) as InvitationApiFetch
    const sealFormGrant = vi.fn((): EncryptedFormGrant => ({
      keyScheme: "account_sealed_box_v1",
      encryptedFormDataKey: "latest-sealed-data",
      encryptedFormPrivateKey: "latest-sealed-private",
    })) as InvitationSealer

    await sendInvitation(
      {
        formId: "018f0000-0000-7000-8000-000000000001",
        invitationId: "018f0000-0000-7000-8000-000000000002",
        email: "latest@example.com",
        role: "editor",
        formDataKey: "raw-data-key",
        formPrivateKey: "raw-private-key",
      },
      { apiFetch, sealFormGrant }
    )

    expect(requests.map(({ path }) => path)).toEqual([
      "/forms/018f0000-0000-7000-8000-000000000001/invitations/recipient-key",
      "/forms/018f0000-0000-7000-8000-000000000001/invitations/018f0000-0000-7000-8000-000000000002/resend",
    ])
    expect(JSON.parse(requests[1]!.init?.body as string)).toEqual({
      invited_email: "latest@example.com",
      role: "editor",
      recipient_sharing_public_key: "latest-public-key",
      encrypted_form_data_key: "latest-sealed-data",
      encrypted_form_private_key: "latest-sealed-private",
    })
  })
})
