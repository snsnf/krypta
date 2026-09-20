import { describe, expect, it, vi } from "vitest"
import { ApiClientError } from "./api"
import {
  createFormMutationQueue,
  serializeDraftForClipboard,
} from "./form-mutations"

describe("createFormMutationQueue", () => {
  it("serializes rapid patches and advances the expected version after each success", async () => {
    const requests: Array<{
      patch: Record<string, unknown>
      expectedVersion: number
    }> = []
    let releaseFirst: (() => void) | undefined
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const send = vi.fn(
      async (patch: Record<string, unknown>, expectedVersion: number) => {
        requests.push({ patch, expectedVersion })
        if (requests.length === 1) await firstRequest
        return { version: expectedVersion + 1 }
      }
    )
    const versionRef = { current: 7 }
    const queue = createFormMutationQueue(versionRef, send)

    const first = queue.enqueue({ accepting_responses: false })
    const second = queue.enqueue({ allow_response_editing: true })
    await Promise.resolve()

    expect(requests).toEqual([
      { patch: { accepting_responses: false }, expectedVersion: 7 },
    ])

    releaseFirst?.()
    await Promise.all([first, second])

    expect(requests).toEqual([
      { patch: { accepting_responses: false }, expectedVersion: 7 },
      { patch: { allow_response_editing: true }, expectedVersion: 8 },
    ])
    expect(queue.version()).toBe(9)
    expect(versionRef.current).toBe(9)
  })

  it("stops later mutations after a conflict and never retries the stale patch", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("conflict", "Conflict"))
    const versionRef = { current: 4 }
    const queue = createFormMutationQueue(versionRef, send)

    await expect(
      queue.enqueue({ title_ciphertext: "draft" })
    ).rejects.toMatchObject({ code: "conflict" })
    await expect(
      queue.enqueue({ accepting_responses: false })
    ).rejects.toMatchObject({ code: "conflict" })

    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.conflicted()).toBe(true)
    expect(queue.version()).toBe(4)
  })
})

describe("serializeDraftForClipboard", () => {
  it("copies only plaintext draft fields and excludes all form keys", () => {
    const clipboard = serializeDraftForClipboard({
      title: "Local title",
      questions: [{ id: "q1", type: "short_text", label: "Question" }],
      theme: { accentColor: "#123456" },
      settings: { allowMultipleResponses: true },
      formDataKey: "must-not-leak",
      formPrivateKey: "must-not-leak-either",
    })

    expect(JSON.parse(clipboard)).toEqual({
      title: "Local title",
      questions: [{ id: "q1", type: "short_text", label: "Question" }],
      theme: { accentColor: "#123456" },
      settings: { allowMultipleResponses: true },
    })
    expect(clipboard).not.toContain("must-not-leak")
  })
})
