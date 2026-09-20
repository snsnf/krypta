import { describe, expect, it } from "vitest"
import { invitationLinkFromContent } from "./invitation-link"

describe("invitationLinkFromContent", () => {
  it("returns an exact fragment-only invitation URL", () => {
    expect(
      invitationLinkFromContent(
        'Open <a href="https://app.example/invitations/accept#token=abc_DEF-123">invitation</a>'
      )
    ).toBe("https://app.example/invitations/accept#token=abc_DEF-123")
  })

  it.each([
    "prefixhttps://app.example/invitations/accept#token=abc",
    "7https://app.example/invitations/accept#token=abc",
    "_https://app.example/invitations/accept#token=abc",
    ".https://app.example/invitations/accept#token=abc",
    "/https://app.example/invitations/accept#token=abc",
    "@https://app.example/invitations/accept#token=abc",
  ])("rejects a URL attached to a non-boundary prefix: %s", (content) => {
    expect(invitationLinkFromContent(content)).toBeNull()
  })

  it.each([
    "https://app.example/invitations/accept#token=abc",
    "Open https://app.example/invitations/accept#token=abc",
    'href="https://app.example/invitations/accept#token=abc',
    "href='https://app.example/invitations/accept#token=abc",
    "<https://app.example/invitations/accept#token=abc",
    "(https://app.example/invitations/accept#token=abc",
  ])("accepts a URL at a genuine left boundary: %s", (content) => {
    expect(invitationLinkFromContent(content)).toBe(
      "https://app.example/invitations/accept#token=abc"
    )
  })

  it.each([
    "https://app.example/prefix/invitations/accept#token=abc",
    "https://app.example/invitations/accept?next=x#token=abc",
    "https://app.example/invitations/accept#token=abc&extra=value",
    "https://app.example/invitations/accept#token=one&token=two",
    "https://app.example/invitations/accept#token=",
    "https://app.example/invitations/accept#token=abc%ZZ",
    "https://app.example/invitations/accept#other=abc",
  ])("rejects non-exact candidate %s", (candidate) => {
    expect(invitationLinkFromContent(candidate)).toBeNull()
  })
})
