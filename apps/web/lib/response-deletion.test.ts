import { describe, expect, it } from "vitest"
import { ApiClientError } from "./api"
import { deleteResponsesInTurn } from "./response-deletion"

const rows = (...ids: string[]) => ids.map((id) => ({ id }))

describe("deleteResponsesInTurn", () => {
  it("deletes every response, one request at a time and in order", async () => {
    const calls: string[] = []
    let inFlight = 0
    const result = await deleteResponsesInTurn(
      rows("a", "b", "c"),
      async ({ id }) => {
        inFlight += 1
        expect(inFlight).toBe(1)
        calls.push(id)
        await Promise.resolve()
        inFlight -= 1
      }
    )
    expect(calls).toEqual(["a", "b", "c"])
    expect(result).toEqual({ deleted: ["a", "b", "c"], failed: 0 })
  })

  it("counts a response the server no longer has as deleted", async () => {
    const result = await deleteResponsesInTurn(rows("a"), async () => {
      throw new ApiClientError("not_found", "Not found")
    })
    expect(result).toEqual({ deleted: ["a"], failed: 0 })
  })

  it("counts a rejected attachment reference as a failure, not as gone", async () => {
    const result = await deleteResponsesInTurn(rows("a"), async () => {
      throw new ApiClientError("bad_request", "Invalid attachment reference.")
    })
    expect(result).toEqual({ deleted: [], failed: 1 })
  })

  it("keeps going after a failure", async () => {
    const result = await deleteResponsesInTurn(
      rows("a", "b", "c"),
      async ({ id }) => {
        if (id === "b") throw new Error("network down")
      }
    )
    expect(result).toEqual({ deleted: ["a", "c"], failed: 1 })
  })
})
