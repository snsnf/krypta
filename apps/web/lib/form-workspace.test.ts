import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  decryptWithKey: vi.fn(),
  unsealBox: vi.fn(),
  openMemberGrant: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock("@krypta/crypto", () => ({
  decryptWithKey: mocks.decryptWithKey,
  unsealBox: mocks.unsealBox,
}))

vi.mock("./form-grants", () => ({
  openMemberGrant: mocks.openMemberGrant,
}))

vi.mock("./api", () => ({
  apiFetch: mocks.apiFetch,
}))

import type { AccountSharingMaterial } from "./account-sharing-key"
import { loadFormWorkspace } from "./form-workspace"

const sharing: AccountSharingMaterial = {
  sharingPublicKey: "sharing-public-key",
  wrappedSharingPrivateKey: "wrapped-sharing-private-key",
  sharingPrivateKey: "sharing-private-key",
  version: 1,
}

const schema = {
  questions: [{ id: "q1", type: "short_text", label: "Q1" }],
  theme: {},
  settings: {},
}

function formWire(overrides: Record<string, unknown> = {}) {
  return {
    title_ciphertext: "ct-title",
    schema_ciphertext: "ct-schema",
    form_public_key: "pub",
    role: "owner",
    membership_state: "active",
    key_scheme: "master_wrap_v1",
    encrypted_form_data_key: "wrapped-data",
    encrypted_form_private_key: "wrapped-priv",
    allow_response_editing: false,
    accepting_responses: true,
    closes_at: null,
    max_responses: null,
    notify_on_response: false,
    version: 4,
    header_image: true,
    ...overrides,
  }
}

/** Wires the two GETs the loader makes, in the order it makes them. */
function respondWith(form: unknown, responses: unknown[]) {
  mocks.apiFetch.mockImplementation(async (path: string) =>
    path.endsWith("/responses") ? { responses } : form
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.openMemberGrant.mockReturnValue({
    formDataKey: "data-key",
    formPrivateKey: "private-key",
  })
  mocks.decryptWithKey.mockImplementation((ciphertext: string) =>
    ciphertext === "ct-title" ? "My form" : JSON.stringify(schema)
  )
  mocks.unsealBox.mockImplementation(() => JSON.stringify({ q1: "an answer" }))
})

describe("loadFormWorkspace", () => {
  it("opens the grant, decrypts the form and unseals every response", async () => {
    respondWith(formWire(), [
      { id: "r1", ciphertext: "ct-1" },
      { id: "r2", ciphertext: "ct-2" },
    ])

    const workspace = await loadFormWorkspace("form-1", "account-key", sharing)

    expect(mocks.openMemberGrant).toHaveBeenCalledWith(
      expect.objectContaining({ key_scheme: "master_wrap_v1" }),
      "account-key",
      sharing
    )
    expect(workspace.title).toBe("My form")
    expect(workspace.questions).toEqual(schema.questions)
    expect(workspace.version).toBe(4)
    expect(workspace.hasHeaderImage).toBe(true)
    expect(workspace.responses).toEqual([
      { id: "r1", answers: { q1: "an answer" } },
      { id: "r2", answers: { q1: "an answer" } },
    ])
    expect(workspace.unreadableResponses).toBe(0)
  })

  it("follows the response cursor until the last page", async () => {
    const form = formWire()
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/responses"))
        return {
          responses: [{ id: "r1", ciphertext: "ct-1" }],
          next_cursor: "r1",
        }
      if (path.endsWith("/responses?cursor=r1"))
        return {
          responses: [{ id: "r2", ciphertext: "ct-2" }],
          next_cursor: null,
        }
      return form
    })

    const workspace = await loadFormWorkspace("form-1", "account-key", sharing)

    expect(workspace.responses.map((r) => r.id)).toEqual(["r1", "r2"])
  })

  it("keeps the workspace when one response will not decrypt", async () => {
    // This used to take the whole page down: a form with good responses became
    // unreadable because of a single bad blob.
    mocks.unsealBox.mockImplementation((ciphertext: string) => {
      if (ciphertext === "ct-bad") throw new Error("bad mac")
      return JSON.stringify({ q1: "an answer" })
    })
    respondWith(formWire(), [
      { id: "r1", ciphertext: "ct-1" },
      { id: "r2", ciphertext: "ct-bad" },
      { id: "r3", ciphertext: "ct-3" },
    ])

    const workspace = await loadFormWorkspace("form-1", "account-key", sharing)

    expect(workspace.responses.map((r) => r.id)).toEqual(["r1", "r3"])
    expect(workspace.unreadableResponses).toBe(1)
    expect(workspace.title).toBe("My form")
  })

  it("counts a response whose plaintext is not the shape we expect", async () => {
    mocks.unsealBox.mockImplementation(() => "not json")
    respondWith(formWire(), [{ id: "r1", ciphertext: "ct-1" }])

    const workspace = await loadFormWorkspace("form-1", "account-key", sharing)

    expect(workspace.responses).toEqual([])
    expect(workspace.unreadableResponses).toBe(1)
  })

  it("reports a membership whose keys are not provisioned as not ready", async () => {
    // The exact string `describeWorkspaceLoadFailure` matches to show "waiting
    // for the owner" rather than "keys unreadable".
    mocks.openMemberGrant.mockImplementation(() => {
      throw new Error("Form access is not ready")
    })
    respondWith(formWire({ membership_state: "awaiting_keys" }), [])

    await expect(
      loadFormWorkspace("form-1", "account-key", sharing)
    ).rejects.toThrow("Form access is not ready")
  })

  it("refuses a payload that does not describe a usable membership", async () => {
    respondWith(formWire({ role: "stranger" }), [])
    await expect(
      loadFormWorkspace("form-1", "account-key", sharing)
    ).rejects.toThrow("Form access is not ready")

    respondWith(formWire({ version: 1.5 }), [])
    await expect(
      loadFormWorkspace("form-1", "account-key", sharing)
    ).rejects.toThrow("Form access is not ready")

    expect(mocks.openMemberGrant).not.toHaveBeenCalled()
  })

  it("never asks for responses when the grant will not open", async () => {
    mocks.openMemberGrant.mockImplementation(() => {
      throw new Error("Form access is not ready")
    })
    respondWith(formWire(), [])

    await expect(
      loadFormWorkspace("form-1", "account-key", sharing)
    ).rejects.toThrow()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })
})
