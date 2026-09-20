import { isValidElement, type ReactNode, type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({ default: "a" }))
vi.mock("./ui/button", () => ({ Button: "button" }))

import { InvitationCard } from "./invitation-card"

function collectElements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(collectElements)
  if (!isValidElement(node)) return []
  const props = node.props as { children?: ReactNode }
  return [node, ...collectElements(props.children)]
}

describe("InvitationCard wrong-account failure", () => {
  it("keeps retry enabled and announces a generic switch failure", () => {
    const tree = InvitationCard({
      view: { kind: "wrong_account" },
      switchingAccount: false,
      switchAccountError: "Could not switch accounts. Try again.",
      onAccept: vi.fn(),
      onDecline: vi.fn(),
      onSwitchAccount: vi.fn(),
    })
    const elements = collectElements(tree)

    const liveRegion = elements.find(
      (element) =>
        (element.props as { "aria-live"?: string })["aria-live"] === "polite"
    )
    expect(liveRegion?.props).toMatchObject({
      children: "Could not switch accounts. Try again.",
    })

    const retry = elements.find(
      (element) =>
        (element.props as { children?: ReactNode }).children ===
        "Sign out and switch account"
    )
    expect(retry?.props).toMatchObject({ disabled: false })
  })
})
