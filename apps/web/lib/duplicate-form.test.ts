import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  decryptBytesWithKey,
  encryptBytesWithKey,
  generateSymmetricKey,
} from "@krypta/crypto"
import { ensureSodiumReady } from "./sodium-ready"
import type { AccountSharingMaterial } from "./account-sharing-key"

const loadFormDefinition = vi.fn()
const createForm = vi.fn()
const apiFetch = vi.fn()
const apiDownloadBytes = vi.fn()
const apiUploadBytes = vi.fn()

vi.mock("./form-workspace", () => ({
  loadFormDefinition: (...a: unknown[]) => loadFormDefinition(...a),
}))
vi.mock("./create-form", () => ({ createForm: (...a: unknown[]) => createForm(...a) }))
vi.mock("./api", () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiDownloadBytes: (...a: unknown[]) => apiDownloadBytes(...a),
  apiUploadBytes: (...a: unknown[]) => apiUploadBytes(...a),
}))

import { duplicateForm } from "./duplicate-form"

const sharing = {} as AccountSharingMaterial
let originalKey = ""
let copyKey = ""

function definition(overrides: Record<string, unknown> = {}) {
  return {
    role: "owner",
    version: 7,
    formDataKey: originalKey,
    formPrivateKey: "private",
    title: "Team survey",
    questions: [{ id: "q1", type: "short_text", label: "Name" }],
    theme: { preset: "forest" },
    settings: { allowMultipleResponses: true, confirmationMessage: "Ta" },
    allowResponseEditing: true,
    acceptingResponses: false,
    closesAt: "2020-01-01T00:00:00Z",
    maxResponses: 50,
    notifyOnResponse: false,
    hasHeaderImage: false,
    answerKey: { enabled: true, questions: {} },
    ...overrides,
  }
}

describe("duplicateForm", () => {
  beforeAll(async () => {
    await ensureSodiumReady()
    originalKey = generateSymmetricKey()
    copyKey = generateSymmetricKey()
  })
  beforeEach(() => {
    for (const fn of [loadFormDefinition, createForm, apiFetch, apiDownloadBytes, apiUploadBytes]) fn.mockReset()
    createForm.mockResolvedValue({ id: "copy", formDataKey: copyKey })
    apiUploadBytes.mockResolvedValue({ attachment_id: "att-1" })
    apiFetch.mockResolvedValue({ version: 2 })
  })

  it("creates an open copy with the same content under a new title", async () => {
    loadFormDefinition.mockResolvedValue(definition())
    const result = await duplicateForm("orig", "account", sharing)
    expect(result).toEqual({ id: "copy", formDataKey: copyKey, headerCopied: true })
    const input = createForm.mock.calls[0][0]
    expect(input).toMatchObject({
      accountKey: "account",
      title: "Copy of Team survey",
      questions: [{ id: "q1", type: "short_text", label: "Name" }],
      theme: { preset: "forest" },
      settings: { allowMultipleResponses: true, confirmationMessage: "Ta" },
      answerKey: { enabled: true, questions: {} },
      allowResponseEditing: true,
      notifyOnResponse: false,
      maxResponses: 50,
      acceptingResponses: true,
      closesAt: null,
    })
    expect(apiDownloadBytes).not.toHaveBeenCalled()
  })

  it("re-encrypts the header image under the copy's key and attaches it at version 1", async () => {
    loadFormDefinition.mockResolvedValue(definition({ hasHeaderImage: true }))
    const image = new Uint8Array([1, 2, 3, 4])
    apiDownloadBytes.mockResolvedValue(encryptBytesWithKey(image, originalKey))

    const result = await duplicateForm("orig", "account", sharing)

    expect(apiDownloadBytes).toHaveBeenCalledWith("/forms/orig/header-image")
    const [uploadPath, uploaded] = apiUploadBytes.mock.calls[0] as [string, Uint8Array]
    expect(uploadPath).toBe("/forms/copy/attachments")
    expect(Array.from(decryptBytesWithKey(uploaded, copyKey))).toEqual([1, 2, 3, 4])
    expect(() => decryptBytesWithKey(uploaded, originalKey)).toThrow()
    const [patchPath, init] = apiFetch.mock.calls[0] as [string, { method: string; body: string }]
    expect(patchPath).toBe("/forms/copy")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({ header_attachment_id: "att-1", expected_version: 1 })
    expect(result.headerCopied).toBe(true)
  })

  it("keeps the copy when the header image cannot be copied", async () => {
    loadFormDefinition.mockResolvedValue(definition({ hasHeaderImage: true }))
    apiDownloadBytes.mockRejectedValue(new Error("gone"))
    const result = await duplicateForm("orig", "account", sharing)
    expect(result).toEqual({ id: "copy", formDataKey: copyKey, headerCopied: false })
  })

  it("refuses a viewer before creating anything", async () => {
    loadFormDefinition.mockResolvedValue(definition({ role: "viewer" }))
    await expect(duplicateForm("orig", "account", sharing)).rejects.toThrow()
    expect(createForm).not.toHaveBeenCalled()
  })
})
