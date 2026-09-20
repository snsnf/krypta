import { describe, expect, it, vi } from "vitest"
import { ApiClientError } from "./api"
import {
  acceptanceViewState,
  currentInvitationViewState,
  invitationErrorViewState,
  takeInvitationToken,
} from "./invitation-flow"

describe("takeInvitationToken", () => {
  it("removes the complete fragment before returning its only token", () => {
    const events: string[] = []
    const replace = vi.fn(() => events.push("cleared"))

    const token = takeInvitationToken("#token=opaque%2Bvalue", replace)
    events.push("returned")

    expect(token).toBe("opaque+value")
    expect(events).toEqual(["cleared", "returned"])
    expect(replace).toHaveBeenCalledWith(null, "", "/invitations/accept")
  })

  it("clears but rejects fragments with extra, duplicate, or empty fields", () => {
    for (const fragment of [
      "#other=value&token=opaque",
      "#token=one&token=two",
      "#token=",
      "#opaque",
    ]) {
      const replace = vi.fn()
      expect(takeInvitationToken(fragment, replace)).toBeNull()
      expect(replace).toHaveBeenCalledOnce()
    }
  })

  it("does not touch history when there is no fragment", () => {
    const replace = vi.fn()
    expect(takeInvitationToken("", replace)).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe("invitation view-state mapping", () => {
  it("maps a valid current invitation to a masked ready state", () => {
    expect(
      currentInvitationViewState({
        role: "viewer",
        status: "pending",
        masked_email: "i***@example.com",
        grant_ready: false,
      })
    ).toEqual({
      kind: "ready",
      role: "viewer",
      maskedEmail: "i***@example.com",
    })
  })

  it("fails closed for malformed current invitation data", () => {
    expect(currentInvitationViewState({ role: "owner" })).toEqual({
      kind: "invalid",
    })
  })

  it("maps active and awaiting acceptance results", () => {
    expect(
      acceptanceViewState({
        form_id: "01993db5-c478-7e5b-959f-49cdf4df2f2b",
        membership_state: "active",
      })
    ).toEqual({
      kind: "active",
      formId: "01993db5-c478-7e5b-959f-49cdf4df2f2b",
    })
    expect(
      acceptanceViewState({
        form_id: "01993db5-c478-7e5b-959f-49cdf4df2f2b",
        membership_state: "awaiting_keys",
      })
    ).toEqual({ kind: "awaiting_keys" })
  })

  it("accepts a v4 form id, which is the shape a form actually has", () => {
    // Form ids are UUIDv4 because they appear in public links. This assertion
    // used to be the opposite, requiring v7, and that is exactly how the bug
    // shipped: the server made the caller an editor, the browser rejected the
    // id it had just been handed, and the page said the invitation was
    // expired. A green unit suite hid it because the test agreed with the bug.
    expect(
      acceptanceViewState({
        form_id: "01993db5-c478-4e5b-959f-49cdf4df2f2b",
        membership_state: "active",
      })
    ).toEqual({
      kind: "active",
      formId: "01993db5-c478-4e5b-959f-49cdf4df2f2b",
    })
  })

  it("rejects a destination that is not a UUID at all", () => {
    // The check exists to stop a value being interpolated into a dashboard
    // URL, so what it must catch is a non-id, not a version it did not expect.
    for (const formId of [
      "javascript:alert(1)",
      "../../dashboard",
      "01993db5-c478-4e5b-959f",
      "01993db5c4784e5b959f49cdf4df2f2b",
    ]) {
      expect(
        acceptanceViewState({ form_id: formId, membership_state: "active" })
      ).toEqual({ kind: "invalid" })
    }
  })

  it("maps signed-out and wrong-account errors without exposing details", () => {
    expect(
      invitationErrorViewState(new ApiClientError("unauthorized", "secret"))
    ).toEqual({ kind: "signed_out" })
    expect(
      invitationErrorViewState(new ApiClientError("wrong_account", "secret"))
    ).toEqual({ kind: "wrong_account" })
    expect(
      invitationErrorViewState(new ApiClientError("not_found", "secret"))
    ).toEqual({ kind: "invalid" })
  })
})
