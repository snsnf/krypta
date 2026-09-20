import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  decryptWithKey: vi.fn(),
}))

vi.mock("./api", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("@krypta/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@krypta/crypto")>()),
  decryptWithKey: mocks.decryptWithKey,
}))

import { formKeyCommitment, generateSealKeyPair } from "@krypta/crypto"
import { FormKeyMismatchError, loadPublicForm } from "./load-public-form"
import { ensureSodiumReady } from "./sodium-ready"

describe("loadPublicForm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.apiFetch.mockResolvedValue({
      title_ciphertext: "encrypted-title",
      schema_ciphertext: "encrypted-schema",
      form_public_key: "public-key",
      accepting_responses: false,
    })
    mocks.decryptWithKey.mockImplementation((ciphertext: string) =>
      ciphertext === "encrypted-title"
        ? "Closed form"
        : JSON.stringify({ questions: [], theme: {}, settings: {} })
    )
  })

  it("exposes the canonical response-collection state", async () => {
    await ensureSodiumReady()
    const owner = generateSealKeyPair()
    mocks.apiFetch.mockResolvedValue({
      title_ciphertext: "encrypted-title",
      schema_ciphertext: "encrypted-schema",
      form_public_key: owner.publicKey,
      accepting_responses: false,
    })
    mocks.decryptWithKey.mockImplementation((ciphertext: string) =>
      ciphertext === "encrypted-title"
        ? "Closed form"
        : JSON.stringify({
            questions: [],
            theme: {},
            settings: {},
            publicKeyCommitment: formKeyCommitment(owner.publicKey),
          })
    )

    const form = await loadPublicForm("form-id", "schema-key")

    expect(form.acceptingResponses).toBe(false)
  })

  it("refuses a schema that commits to no key at all", async () => {
    // The beforeEach schema carries no commitment, as a form written before
    // the check existed would. Passing it would be a way around the check.
    await expect(
      loadPublicForm("form-id", "schema-key")
    ).rejects.toBeInstanceOf(FormKeyMismatchError)
  })

  it("refuses a served public key the schema did not commit to", async () => {
    await ensureSodiumReady()
    const owner = generateSealKeyPair()
    const swapped = generateSealKeyPair()
    mocks.apiFetch.mockResolvedValue({
      title_ciphertext: "encrypted-title",
      schema_ciphertext: "encrypted-schema",
      form_public_key: swapped.publicKey,
      accepting_responses: true,
    })
    mocks.decryptWithKey.mockImplementation((ciphertext: string) =>
      ciphertext === "encrypted-title"
        ? "A form"
        : JSON.stringify({
            questions: [],
            publicKeyCommitment: formKeyCommitment(owner.publicKey),
          })
    )

    await expect(
      loadPublicForm("form-id", "schema-key")
    ).rejects.toBeInstanceOf(FormKeyMismatchError)
  })

  it("accepts the committed key", async () => {
    await ensureSodiumReady()
    const owner = generateSealKeyPair()
    mocks.apiFetch.mockResolvedValue({
      title_ciphertext: "encrypted-title",
      schema_ciphertext: "encrypted-schema",
      form_public_key: owner.publicKey,
      accepting_responses: true,
    })
    mocks.decryptWithKey.mockImplementation((ciphertext: string) =>
      ciphertext === "encrypted-title"
        ? "A form"
        : JSON.stringify({
            questions: [],
            publicKeyCommitment: formKeyCommitment(owner.publicKey),
          })
    )

    const form = await loadPublicForm("form-id", "schema-key")
    expect(form.publicKey).toBe(owner.publicKey)
  })
})
