import { describe, expect, it, vi } from "vitest"
import { ApiClientError } from "./api"
import {
  acceptanceViewState,
  currentInvitationViewState,
  invitationErrorViewState,
  forgetInvitationKey,
  recallInvitationKey,
  rememberInvitationKey,
  takeInvitationLink,
} from "./invitation-flow"

describe("takeInvitationLink", () => {
  it("removes the complete fragment before returning the token and key", () => {
    const events: string[] = []
    const replace = vi.fn(() => events.push("cleared"))

    const link = takeInvitationLink(
      "#token=opaque%2Bvalue&form=0198e904-aa65-4bd1-a2d2-b734286d8f72&pk=key-fingerprint",
      replace
    )
    events.push("returned")

    expect(link).toEqual({
      token: "opaque+value",
      key: { formId: "0198e904-aa65-4bd1-a2d2-b734286d8f72", keyFingerprint: "key-fingerprint" },
    })
    expect(events).toEqual(["cleared", "returned"])
    expect(replace).toHaveBeenCalledWith(null, "", "/invitations/accept")
  })

  it("opens a link sent before invitations carried a fingerprint", () => {
    expect(takeInvitationLink("#token=opaque", vi.fn())).toEqual({
      token: "opaque",
      key: null,
    })
  })

  it("clears but rejects fragments with extra, duplicate, or empty fields", () => {
    for (const fragment of [
      "#other=value&token=opaque",
      "#token=one&token=two",
      "#token=opaque&form=0198e904-aa65-4bd1-a2d2-b734286d8f72&pk=one&pk=two",
      "#token=opaque&form=0198e904-aa65-4bd1-a2d2-b734286d8f72&pk=",
      "#token=opaque&pk=key-fingerprint",
      "#token=opaque&form=0198e904-aa65-4bd1-a2d2-b734286d8f72",
      "#token=opaque&form=not-a-form&pk=key-fingerprint",
      "#form=0198e904-aa65-4bd1-a2d2-b734286d8f72&pk=key-fingerprint",
      "#token=",
      "#opaque",
    ]) {
      const replace = vi.fn()
      expect(takeInvitationLink(fragment, replace)).toBeNull()
      expect(replace).toHaveBeenCalledOnce()
    }
  })

  it("does not touch history when there is no fragment", () => {
    const replace = vi.fn()
    expect(takeInvitationLink("", replace)).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe("the invitation key across sign-in", () => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>()
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      get length() {
        return values.size
      },
    }
  }

  const key = { formId: "0198e904-aa65-4bd1-a2d2-b734286d8f72", keyFingerprint: "second" }

  it("keeps the latest link's key and forgets it when asked", () => {
    const storage = memoryStorage()
    rememberInvitationKey(storage, { ...key, keyFingerprint: "first" })
    rememberInvitationKey(storage, key)
    expect(recallInvitationKey(storage)).toEqual(key)
    forgetInvitationKey(storage)
    expect(recallInvitationKey(storage)).toBeNull()
  })

  it("drops an earlier key when a link without one is opened", () => {
    const storage = memoryStorage()
    rememberInvitationKey(storage, key)
    rememberInvitationKey(storage, null)
    expect(recallInvitationKey(storage)).toBeNull()
  })

  it("recalls nothing from a stored value that is not a key", () => {
    const storage = memoryStorage()
    storage.setItem("krypta:invitation-key", '{"formId":"x","keyFingerprint":"y"}')
    expect(recallInvitationKey(storage)).toBeNull()
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
