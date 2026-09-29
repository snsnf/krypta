import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  decryptWithKey,
  formKeyCommitment,
  generateSymmetricKey,
  type FormSchema,
} from "@krypta/crypto"
import { ensureSodiumReady } from "./sodium-ready"

const apiFetch = vi.fn()
vi.mock("./api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

import { createForm, type CreateFormInput } from "./create-form"
import { DEFAULT_FORM_THEME } from "./form-theme"

function input(overrides: Partial<CreateFormInput> = {}): CreateFormInput {
  return {
    accountKey: generateSymmetricKey(),
    title: "Survey",
    questions: [{ id: "q1", type: "short_text", label: "Name" }],
    theme: DEFAULT_FORM_THEME,
    settings: { allowMultipleResponses: true },
    answerKey: null,
    allowResponseEditing: false,
    acceptingResponses: true,
    closesAt: null,
    maxResponses: null,
    notifyOnResponse: true,
    ...overrides,
  }
}

function postedBody(): Record<string, unknown> {
  const [path, init] = apiFetch.mock.calls[0] as [string, { method: string; body: string }]
  expect(path).toBe("/forms")
  expect(init.method).toBe("POST")
  return JSON.parse(init.body)
}

describe("createForm", () => {
  beforeAll(async () => {
    await ensureSodiumReady()
  })
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValue({ id: "new-form" })
  })

  it("posts a schema that decrypts under the returned key and commits to the posted key", async () => {
    const result = await createForm(input())
    expect(result.id).toBe("new-form")
    const body = postedBody()
    const schema = JSON.parse(
      decryptWithKey(body.schema_ciphertext as string, result.formDataKey)
    ) as FormSchema
    expect(schema.questions).toEqual([{ id: "q1", type: "short_text", label: "Name" }])
    expect(schema.publicKeyCommitment).toBe(
      formKeyCommitment(body.form_public_key as string)
    )
    expect(decryptWithKey(body.title_ciphertext as string, result.formDataKey)).toBe(
      "Survey"
    )
  })

  it("forwards the plaintext columns", async () => {
    await createForm(
      input({ allowResponseEditing: true, closesAt: "2030-01-01T00:00:00Z", maxResponses: 5, notifyOnResponse: false, acceptingResponses: false })
    )
    const body = postedBody()
    expect(body).toMatchObject({
      allow_response_editing: true,
      accepting_responses: false,
      closes_at: "2030-01-01T00:00:00Z",
      max_responses: 5,
      notify_on_response: false,
    })
  })

  it("seals an answer key only when there is one", async () => {
    await createForm(input())
    expect(postedBody().answer_key_ciphertext).toBeUndefined()
    apiFetch.mockClear()
    await createForm(input({ answerKey: { enabled: true, questions: {} } }))
    expect(typeof postedBody().answer_key_ciphertext).toBe("string")
  })

  it("mints fresh keys on every call", async () => {
    const first = await createForm(input())
    const second = await createForm(input())
    expect(first.formDataKey).not.toBe(second.formDataKey)
  })
})
