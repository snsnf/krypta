import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  decryptWithKey: vi.fn(),
  openMemberGrant: vi.fn(),
}))

vi.mock("@krypta/crypto", () => ({
  decryptWithKey: mocks.decryptWithKey,
}))

vi.mock("./form-grants", () => ({
  openMemberGrant: mocks.openMemberGrant,
}))

import type { AccountSharingMaterial } from "./account-sharing-key"
import {
  canDuplicate,
  decryptFormList,
  groupDashboardForms,
  type FormListWireItem,
} from "./dashboard-forms"

const sharingMaterial: AccountSharingMaterial = {
  sharingPublicKey: "sharing-public-key",
  wrappedSharingPrivateKey: "wrapped-sharing-private-key",
  sharingPrivateKey: "sharing-private-key",
  version: 1,
}

const ownerForm: FormListWireItem = {
  id: "owner-form",
  role: "owner",
  membership_state: "active",
  title_ciphertext: "owner-title-ciphertext",
  key_scheme: "master_wrap_v1",
  encrypted_form_data_key: "wrapped-owner-data-key",
  encrypted_form_private_key: "wrapped-owner-private-key",
  created_at: "2026-08-25T12:00:00Z",
  archived_at: null,
  version: 3,
}

describe("dashboard form preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openMemberGrant.mockReturnValue({
      formDataKey: "opened-form-data-key",
      formPrivateKey: "opened-form-private-key",
    })
    mocks.decryptWithKey.mockReturnValue("Decrypted title")
  })

  it("groups owners separately from editor and viewer memberships", () => {
    const decrypted = decryptFormList(
      [
        ownerForm,
        { ...ownerForm, id: "editor-form", role: "editor" },
        { ...ownerForm, id: "viewer-form", role: "viewer" },
      ],
      "master-key",
      sharingMaterial
    )

    const grouped = groupDashboardForms(decrypted)

    expect(grouped.owned.map((form) => form.id)).toEqual(["owner-form"])
    expect(grouped.shared.map((form) => form.id)).toEqual([
      "editor-form",
      "viewer-form",
    ])
  })

  it("does not invoke crypto for an awaiting form with null protected fields", () => {
    const awaiting: FormListWireItem = {
      id: "awaiting-form",
      role: "editor",
      membership_state: "awaiting_keys",
      title_ciphertext: null,
      key_scheme: null,
      encrypted_form_data_key: null,
      encrypted_form_private_key: null,
      created_at: "2026-08-26T12:00:00Z",
      archived_at: null,
      version: null,
    }

    const [form] = decryptFormList([awaiting], "master-key", sharingMaterial)

    expect(form.title).toBe("Shared form: waiting for secure access")
    expect(form.accessState).toBe("awaiting")
    expect(mocks.openMemberGrant).not.toHaveBeenCalled()
    expect(mocks.decryptWithKey).not.toHaveBeenCalled()
  })

  it("carries the version the title was read at, which a rename sends back", () => {
    // Without this the rename has to re-read the version just before writing,
    // which picks up someone else's concurrent rename and overwrites it.
    const [form] = decryptFormList([ownerForm], "master-key", sharingMaterial)

    expect(form.version).toBe(3)
  })

  it("leaves version undefined when the API did not send one", () => {
    // An API that predates list_forms returning `version` omits the key
    // rather than sending null, so it arrives as undefined despite the type.
    // The rename guard uses `== null` to catch both; this pins the shape that
    // makes the loose comparison necessary.
    const withoutVersion: Partial<FormListWireItem> = { ...ownerForm }
    delete withoutVersion.version
    const [form] = decryptFormList(
      [withoutVersion as FormListWireItem],
      "master-key",
      sharingMaterial
    )

    expect(form.version).toBeUndefined()
    expect(form.version == null).toBe(true)
  })

  it("retains the opened form data key for a ready form", () => {
    const [form] = decryptFormList([ownerForm], "master-key", sharingMaterial)

    expect(form.accessState).toBe("ready")
    expect(form.formDataKey).toBe("opened-form-data-key")
  })

  it("keeps the form data key null for an awaiting form", () => {
    const awaiting: FormListWireItem = {
      id: "awaiting-form",
      role: "editor",
      membership_state: "awaiting_keys",
      title_ciphertext: null,
      key_scheme: null,
      encrypted_form_data_key: null,
      encrypted_form_private_key: null,
      created_at: "2026-08-26T12:00:00Z",
      archived_at: null,
      version: null,
    }

    const [form] = decryptFormList([awaiting], "master-key", sharingMaterial)

    expect(form.accessState).toBe("awaiting")
    expect(form.formDataKey).toBeNull()
  })

  it("keeps the form data key null when the grant fails to open", () => {
    mocks.openMemberGrant.mockImplementationOnce(() => {
      throw new Error("wrapped ciphertext should not escape")
    })

    const [form] = decryptFormList([ownerForm], "master-key", sharingMaterial)

    expect(form.accessState).toBe("unavailable")
    expect(form.formDataKey).toBeNull()
  })

  it("contains an individual active-form decrypt failure", () => {
    mocks.openMemberGrant.mockImplementationOnce(() => {
      throw new Error("wrapped ciphertext should not escape")
    })

    const [form] = decryptFormList([ownerForm], "master-key", sharingMaterial)

    expect(form.title).toBe("Form unavailable")
    expect(form.accessState).toBe("unavailable")
  })
})

describe("canDuplicate", () => {
  it("allows owners and editors whose access is ready", () => {
    expect(canDuplicate({ role: "owner", accessState: "ready" })).toBe(true)
    expect(canDuplicate({ role: "editor", accessState: "ready" })).toBe(true)
  })

  it("refuses viewers and anyone whose keys are not ready", () => {
    expect(canDuplicate({ role: "viewer", accessState: "ready" })).toBe(false)
    expect(canDuplicate({ role: "owner", accessState: "awaiting" })).toBe(false)
    expect(canDuplicate({ role: "editor", accessState: "unavailable" })).toBe(false)
  })
})
