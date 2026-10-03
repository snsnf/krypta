import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/app-i18n", async () => vi.importActual("../../lib/app-i18n"))
vi.mock("@/lib/app-format", async () => vi.importActual("../../lib/app-format"))
vi.mock("@/lib/form-language", async () => vi.importActual("../../lib/form-language"))
vi.mock("@/lib/utils", () => ({ cn: (...v: unknown[]) => v.filter(Boolean).join(" ") }))
vi.mock("@/components/credential-input", async () => vi.importActual("../credential-input"))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogClose: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}))
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn() } }))
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }))
vi.mock("@/lib/auth-store", () => ({
  useAuthStore: { getState: () => ({ email: "admin@example.com" }) },
}))
vi.mock("@/lib/vault-access", () => ({ deriveVaultUnlockKey: vi.fn() }))
vi.mock("@/lib/admin", () => ({
  deleteAccount: vi.fn(),
  reactivateAccount: vi.fn(),
  suspendAccount: vi.fn(),
  transferAdminForm: vi.fn(),
}))

import {
  AccountActions,
  reconcileEligibleTransferSelection,
  resetDeleteProofAfterFailure,
} from "./account-actions"

const account = {
  id: "0198e904-aa65-7bd1-a2d2-b734286d8f70",
  createdAt: "2026-08-28T00:00:00Z",
  instanceAdmin: false,
  suspended: false,
  totpEnabled: true,
  maxForms: null,
  maxAttachmentBytes: null,
  maxResponses: null,
  formsUsed: 1,
  attachmentBytesUsed: 0,
}

describe("AccountActions", () => {
  it("renders transfer choices from the server-projected form and editor membership IDs", () => {
    const markup = renderToStaticMarkup(
      <AccountActions
        account={account}
        eligibleTransfers={[
          {
            formId: "0198e904-aa65-7bd1-a2d2-b734286d8f71",
            editorMemberIds: ["0198e904-aa65-7bd1-a2d2-b734286d8f72"],
          },
        ]}
        onChanged={vi.fn()}
      />
    )

    expect(markup).toContain("0198e904-aa65-7bd1-a2d2-b734286d8f71")
    expect(markup).toContain("0198e904-aa65-7bd1-a2d2-b734286d8f72")
    expect(markup).not.toContain('name="editorId"')
  })

  it("returns deletion to the password-proof step after every failed delete", () => {
    expect(resetDeleteProofAfterFailure()).toEqual({
      receipt: null,
      confirmation: "",
    })
  })

  it("replaces an obsolete transfer pair with an eligible refreshed pair", () => {
    expect(
      reconcileEligibleTransferSelection(
        [
          {
            formId: "0198e904-aa65-7bd1-a2d2-b734286d8f75",
            editorMemberIds: ["0198e904-aa65-7bd1-a2d2-b734286d8f76"],
          },
        ],
        {
          formId: "0198e904-aa65-7bd1-a2d2-b734286d8f71",
          editorMemberId: "0198e904-aa65-7bd1-a2d2-b734286d8f72",
        }
      )
    ).toEqual({
      formId: "0198e904-aa65-7bd1-a2d2-b734286d8f75",
      editorMemberId: "0198e904-aa65-7bd1-a2d2-b734286d8f76",
    })
  })
})
