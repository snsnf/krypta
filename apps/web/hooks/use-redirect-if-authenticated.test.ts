import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  ensureAccountSharingKey: vi.fn(),
  replace: vi.fn(),
}))

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react")
  return {
    ...actual,
    useCallback: (callback: () => void) => callback,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useRef: <T>(initial: T) => ({ current: initial }),
  }
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))

vi.mock("../lib/api", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("../lib/account-sharing-key", () => ({
  ensureAccountSharingKey: mocks.ensureAccountSharingKey,
}))
vi.mock("../lib/auth-store", () => ({
  useAuthStore: (selector: (state: { accountKey: null }) => unknown) =>
    selector({ accountKey: null }),
}))

import { useRedirectIfAuthenticated } from "./use-redirect-if-authenticated"

describe("useRedirectIfAuthenticated ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("lets an interactive login own navigation when its submit starts first", async () => {
    let resolveMe!: () => void
    mocks.apiFetch.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveMe = resolve
      })
    )

    const beginInteractiveAuth = useRedirectIfAuthenticated()
    beginInteractiveAuth()
    resolveMe()
    await Promise.resolve()

    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("replaces the auth page for a pre-existing session", async () => {
    mocks.apiFetch.mockResolvedValueOnce({})

    useRedirectIfAuthenticated()
    await vi.waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/dashboard")
    })
  })

  it("uses the captured allowlisted destination for a pre-existing session", async () => {
    mocks.apiFetch.mockResolvedValueOnce({})

    useRedirectIfAuthenticated("/invitations/accept")
    await vi.waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/invitations/accept")
    })
  })
})
