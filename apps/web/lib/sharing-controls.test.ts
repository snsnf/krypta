import { describe, expect, it, vi } from "vitest"
import {
  memberControls,
  transferOwnership,
  type SharingMutationFetch,
} from "./sharing-controls"

describe("memberControls", () => {
  it("keeps every mutation off the current Owner row", () => {
    expect(memberControls({ role: "owner", state: "active" })).toEqual({
      canChangeRole: false,
      canRemove: false,
      canTransfer: false,
    })
  })

  it("allows role, removal, and transfer only for active collaborators", () => {
    expect(memberControls({ role: "editor", state: "active" })).toEqual({
      canChangeRole: true,
      canRemove: true,
      canTransfer: true,
    })
    expect(memberControls({ role: "viewer", state: "active" })).toEqual({
      canChangeRole: true,
      canRemove: true,
      canTransfer: true,
    })
  })

  it("allows only removal while a collaborator awaits keys", () => {
    expect(memberControls({ role: "viewer", state: "awaiting_keys" })).toEqual({
      canChangeRole: false,
      canRemove: true,
      canTransfer: false,
    })
  })
})

describe("transferOwnership", () => {
  it("calls the ownership callback immediately after the successful mutation", async () => {
    const order: string[] = []
    const apiFetch = vi.fn(async <T>(path: string, init?: RequestInit) => {
      order.push("request")
      expect(path).toBe(
        "/forms/018f0000-0000-7000-8000-000000000001/transfer-ownership"
      )
      expect(init).toEqual({
        method: "POST",
        body: JSON.stringify({
          member_id: "018f0000-0000-7000-8000-000000000002",
        }),
      })
      return {} as T
    }) as SharingMutationFetch
    const onOwnershipTransferred = vi.fn(() => order.push("callback"))

    await transferOwnership(
      "018f0000-0000-7000-8000-000000000001",
      "018f0000-0000-7000-8000-000000000002",
      onOwnershipTransferred,
      apiFetch
    )

    expect(order).toEqual(["request", "callback"])
    expect(onOwnershipTransferred).toHaveBeenCalledOnce()
  })

  it("does not remove Owner controls when transfer fails", async () => {
    const apiFetch = vi.fn(async () => {
      throw new Error("request failed")
    }) as SharingMutationFetch
    const onOwnershipTransferred = vi.fn()

    await expect(
      transferOwnership(
        "018f0000-0000-7000-8000-000000000001",
        "018f0000-0000-7000-8000-000000000002",
        onOwnershipTransferred,
        apiFetch
      )
    ).rejects.toThrow()

    expect(onOwnershipTransferred).not.toHaveBeenCalled()
  })
})
