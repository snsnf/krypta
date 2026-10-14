import { describe, expect, it, vi } from "vitest"
import type { Question } from "@krypta/crypto"

const seal = vi.hoisted(() => ({ length: 10 }))

vi.mock("@krypta/crypto", async () => ({
  ...(await vi.importActual<object>("@krypta/crypto")),
  sealBox: (plaintext: string) =>
    `sealed:${plaintext}`.padEnd(seal.length, "x"),
}))

import {
  attachmentIdsForDeletion,
  attachmentIdsOf,
  buildResponsePayload,
  MAX_RESPONSE_CIPHERTEXT_BYTES,
  ResponseTooLargeError,
} from "./response-payload"

const file = {
  attachmentId: "a1",
  filename: "cv.pdf",
  mimeType: "application/pdf",
  size: 3,
}

const questions = [
  { id: "q1", type: "short_text", label: "Name" },
  { id: "q2", type: "file_upload", label: "CV" },
] as Question[]

describe("attachmentIdsOf", () => {
  it("returns the id of every file answer and nothing else", () => {
    expect(attachmentIdsOf({ q1: "Ada", q2: file, q3: ["a", "b"] })).toEqual([
      "a1",
    ])
  })
})

describe("attachmentIdsForDeletion", () => {
  it("keeps well-formed ids once and drops what a respondent made up", () => {
    const id = "0198e904-aa65-7bd1-a2d2-b734286d8f72"
    expect(
      attachmentIdsForDeletion({
        q1: { ...file, attachmentId: id },
        q2: { ...file, attachmentId: id },
        q3: { ...file, attachmentId: "../../auth/me" },
        q4: { ...file, attachmentId: 5 as unknown as string },
      })
    ).toEqual([id])
  })
})

describe("buildResponsePayload", () => {
  it("sends the referenced attachment ids beside the ciphertext", () => {
    seal.length = 10
    const payload = buildResponsePayload(
      questions,
      { q1: "Ada", q2: file },
      "public-key"
    )
    expect(payload.attachment_ids).toEqual(["a1"])
    expect(payload.ciphertext.startsWith("sealed:")).toBe(true)
  })

  it("refuses a sealed response the server would reject as too large", () => {
    seal.length = MAX_RESPONSE_CIPHERTEXT_BYTES + 1
    expect(() =>
      buildResponsePayload(questions, { q1: "Ada" }, "public-key")
    ).toThrow(ResponseTooLargeError)
  })
})
