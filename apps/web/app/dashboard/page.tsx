"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { encryptWithKey } from "@krypta/crypto"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons"
import { ApiClientError, apiFetch } from "@/lib/api"
import {
  ensureAccountSharingKey,
  type AccountSharingMaterial,
} from "@/lib/account-sharing-key"
import { useAuthStore } from "@/lib/auth-store"
import { useAppT } from "@/lib/app-i18n"
import {
  decryptFormList,
  groupDashboardForms,
  type DashboardFormListItem,
  type FormListWireItem,
} from "@/lib/dashboard-forms"
import { provisionPendingMembers } from "@/lib/provisioning"
import { useEnsureUnlocked } from "@/hooks/use-ensure-unlocked"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppHeader } from "@/components/app-header"
import { WorkspaceUnavailable } from "@/components/workspace-unavailable"
import { FORMS_LIST_UNREACHABLE } from "@/lib/form-load-failure"
import { FullPageSpinner } from "@/components/spinner"

interface DashboardLoadResult {
  activeForms: DashboardFormListItem[]
  archivedForms: DashboardFormListItem[]
  provisioningHadFailures: boolean
}

interface DashboardLoadAttempt {
  userId: string
  accountKey: string
  promise: Promise<DashboardLoadResult>
}

interface DashboardViewState {
  userId: string
  accountKey: string
  activeForms: DashboardFormListItem[]
  archivedForms: DashboardFormListItem[]
  failed: boolean
  provisioningWarning: boolean
}

async function loadDashboard(
  userId: string,
  accountKey: string
): Promise<DashboardLoadResult> {
  const sharingMaterial: AccountSharingMaterial = await ensureAccountSharingKey(
    { expectedUserId: userId, accountKey }
  )
  let provisioningHadFailures = false

  try {
    await provisionPendingMembers(accountKey, sharingMaterial, () => {
      provisioningHadFailures = true
    })
  } catch {
    provisioningHadFailures = true
  }

  const [{ forms: activeRaw }, { forms: archivedRaw }] = await Promise.all([
    apiFetch<{ forms: FormListWireItem[] }>("/forms"),
    apiFetch<{ forms: FormListWireItem[] }>("/forms?archived=1"),
  ])
  return {
    activeForms: decryptFormList(activeRaw, accountKey, sharingMaterial),
    archivedForms: decryptFormList(archivedRaw, accountKey, sharingMaterial),
    provisioningHadFailures,
  }
}

export default function DashboardPage() {
  useEnsureUnlocked()
  const t = useAppT()
  const userId = useAuthStore((state) => state.userId)
  const accountKey = useAuthStore((state) => state.accountKey)
  const loadAttempt = useRef<DashboardLoadAttempt | null>(null)
  const [view, setView] = useState<DashboardViewState | null>(null)
  const [viewMode, setViewMode] = useState<"active" | "archived">("active")
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] =
    useState<DashboardFormListItem | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renamePending, setRenamePending] = useState(false)

  useEffect(() => {
    if (userId === null || accountKey === null) {
      loadAttempt.current = null
      return
    }

    if (
      loadAttempt.current === null ||
      loadAttempt.current.userId !== userId ||
      loadAttempt.current.accountKey !== accountKey
    ) {
      loadAttempt.current = {
        userId,
        accountKey,
        promise: loadDashboard(userId, accountKey),
      }
    }

    const attempt = loadAttempt.current
    let cancelled = false
    void attempt.promise.then(
      (result) => {
        const currentAuth = useAuthStore.getState()
        if (
          cancelled ||
          currentAuth.userId !== attempt.userId ||
          currentAuth.accountKey !== attempt.accountKey
        ) {
          return
        }
        setView({
          userId: attempt.userId,
          accountKey: attempt.accountKey,
          activeForms: result.activeForms,
          archivedForms: result.archivedForms,
          failed: false,
          provisioningWarning: result.provisioningHadFailures,
        })
      },
      () => {
        const currentAuth = useAuthStore.getState()
        if (
          cancelled ||
          currentAuth.userId !== attempt.userId ||
          currentAuth.accountKey !== attempt.accountKey
        ) {
          return
        }
        setView({
          userId: attempt.userId,
          accountKey: attempt.accountKey,
          activeForms: [],
          archivedForms: [],
          failed: true,
          provisioningWarning: false,
        })
      }
    )

    return () => {
      cancelled = true
    }
  }, [accountKey, userId])

  async function handleArchiveToggle(
    form: DashboardFormListItem,
    archive: boolean
  ) {
    setView((prev) => {
      if (prev === null) return prev
      return archive
        ? {
            ...prev,
            activeForms: prev.activeForms.filter((f) => f.id !== form.id),
            archivedForms: [form, ...prev.archivedForms],
          }
        : {
            ...prev,
            archivedForms: prev.archivedForms.filter((f) => f.id !== form.id),
            activeForms: [form, ...prev.activeForms],
          }
    })
    try {
      await apiFetch(`/forms/${form.id}/members/me`, {
        method: "PATCH",
        body: JSON.stringify({ archived: archive }),
      })
    } catch {
      setView((prev) => {
        if (prev === null) return prev
        return archive
          ? {
              ...prev,
              activeForms: [form, ...prev.activeForms],
              archivedForms: prev.archivedForms.filter((f) => f.id !== form.id),
            }
          : {
              ...prev,
              archivedForms: [form, ...prev.archivedForms],
              activeForms: prev.activeForms.filter((f) => f.id !== form.id),
            }
      })
    }
  }

  function handleRenameOpen(form: DashboardFormListItem) {
    setRenameTarget(form)
    setRenameTitle(form.title)
    setRenameError(null)
    setRenameOpen(true)
  }

  function handleRenameOpenChange(open: boolean) {
    setRenameOpen(open)
    if (!open) {
      setRenameTarget(null)
      setRenameError(null)
    }
  }

  async function handleRenameSubmit() {
    if (renameTarget === null || renameTarget.formDataKey === null) return
    const trimmedTitle = renameTitle.trim()
    if (trimmedTitle.length === 0) {
      setRenameError(t("dashboard.titleEmpty"))
      return
    }
    /*
     * `== null`, not `=== null`, and the loose comparison is the point. The
     * type says `number | null`, but the value comes off the wire: an API that
     * predates `list_forms` returning `version` omits the key entirely, so it
     * arrives as `undefined` and slips past a strict null check. It would then
     * be dropped by `JSON.stringify`, and the PATCH would go out with no
     * `expected_version` at all, which the server requires.
     *
     * Refusing here turns that into an honest error instead of a confusing
     * rejection, and it is what keeps "deploy the API before the web app" a
     * recommendation rather than something this page depends on.
     */
    if (renameTarget.version == null) {
      setRenameError(t("dashboard.genericError"))
      return
    }

    setRenamePending(true)
    setRenameError(null)
    try {
      /*
       * The version comes from the list this title was read from, never from a
       * fresh read taken here. Re-reading it immediately before the write is
       * the obvious implementation and it is wrong: it would pick up whatever
       * version a rename by someone else had just produced, so the write would
       * succeed and overwrite them, and `expected_version` could never fire.
       *
       * The title is encrypted here with the form data key this browser
       * already holds. The server stores the ciphertext and the version and
       * reads neither the old title nor the new one.
       */
      const { version } = await apiFetch<{ version: number }>(
        `/forms/${renameTarget.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            title_ciphertext: encryptWithKey(
              trimmedTitle,
              renameTarget.formDataKey
            ),
            expected_version: renameTarget.version,
          }),
        }
      )
      const targetId = renameTarget.id
      setView((prev) => {
        if (prev === null) return prev
        // The new version is kept with the new title, so renaming the same
        // form twice without reloading sends the version the second edit was
        // actually made against.
        const applyRename = (forms: DashboardFormListItem[]) =>
          forms.map((f) =>
            f.id === targetId ? { ...f, title: trimmedTitle, version } : f
          )
        return {
          ...prev,
          activeForms: applyRename(prev.activeForms),
          archivedForms: applyRename(prev.archivedForms),
        }
      })
      setRenameOpen(false)
      setRenameTarget(null)
    } catch (error) {
      setRenameError(
        error instanceof ApiClientError && error.code === "conflict"
          ? t("dashboard.renameConflict")
          : t("dashboard.genericError")
      )
    } finally {
      setRenamePending(false)
    }
  }

  const loadedForCurrentVault =
    userId !== null &&
    accountKey !== null &&
    view?.userId === userId &&
    view.accountKey === accountKey

  if (!loadedForCurrentVault) return <FullPageSpinner />
  if (view.failed)
    return (
      <WorkspaceUnavailable
        failure={FORMS_LIST_UNREACHABLE}
        showDashboardLink={false}
      />
    )

  const { activeForms, archivedForms, provisioningWarning } = view
  const forms = viewMode === "active" ? activeForms : archivedForms
  const { owned, shared } = groupDashboardForms(forms)
  const groups = [
    {
      heading: t("dashboard.myForms"),
      headingId: "my-forms-heading",
      forms: owned,
    },
    {
      heading: t("dashboard.sharedWithMe"),
      headingId: "shared-forms-heading",
      forms: shared,
    },
  ]

  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader />
      <main className="mx-auto mt-8 w-full max-w-3xl flex-1 p-4">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
              {t("dashboard.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("dashboard.subtitle")}
            </p>
          </div>
          <Button
            render={<Link href="/dashboard/new" />}
            nativeButton={false}
            className="transition-none hover:bg-primary active:translate-y-0 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-primary/80"
          >
            <HugeiconsIcon
              icon={PlusSignIcon}
              size={16}
              data-icon="inline-start"
            />
            {t("dashboard.newForm")}
          </Button>
        </div>

        {provisioningWarning ? (
          <p
            role="status"
            className="mb-6 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
          >
            {t("dashboard.provisioningWarning")}
          </p>
        ) : null}

        <div className="mb-4 flex gap-2">
          <Button
            type="button"
            variant={viewMode === "active" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("active")}
          >
            {t("dashboard.active")}
          </Button>
          <Button
            type="button"
            variant={viewMode === "archived" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("archived")}
          >
            {t("dashboard.archived")}
          </Button>
        </div>

        {forms.length === 0 ? (
          viewMode === "active" ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {t("dashboard.empty")}
              </p>
              <Link
                href="/dashboard/new"
                className="mt-1.5 inline-block text-sm text-foreground underline underline-offset-4"
              >
                {t("dashboard.createFirst")}
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {t("dashboard.noArchived")}
              </p>
            </div>
          )
        ) : (
          <div className="space-y-8">
            {groups.map((group) =>
              group.forms.length > 0 ? (
                <section key={group.heading} aria-labelledby={group.headingId}>
                  <h2
                    id={group.headingId}
                    className="mb-2 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase"
                  >
                    {group.heading}
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {group.forms.map((form) => {
                      const isReady = form.accessState === "ready"
                      const rowClassName = isReady
                        ? "flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary/40 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted"
                        : "flex min-h-11 items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"

                      return (
                        <li key={form.id}>
                          <div className={rowClassName}>
                            {isReady ? (
                              <Link
                                href={`/dashboard/${form.id}`}
                                className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                              >
                                <span
                                  dir="auto"
                                  className="min-w-0 truncate text-sm font-medium"
                                >
                                  {form.title}
                                </span>
                                <span className="shrink-0 rounded-md border border-border bg-background px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-muted-foreground">
                                  {t(`roles.${form.role}`)}
                                </span>
                              </Link>
                            ) : (
                              <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span
                                  dir="auto"
                                  className="min-w-0 text-sm text-muted-foreground"
                                >
                                  {form.title}
                                </span>
                                <span className="shrink-0 rounded-md border border-border bg-background px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-muted-foreground">
                                  {t(`roles.${form.role}`)}
                                </span>
                              </div>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="text-muted-foreground"
                                  />
                                }
                                aria-label={t("dashboard.actionsFor", {
                                  title: form.title,
                                })}
                              >
                                <HugeiconsIcon
                                  icon={MoreVerticalIcon}
                                  size={16}
                                />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {(form.role === "owner" ||
                                  form.role === "editor") &&
                                form.accessState === "ready" ? (
                                  <DropdownMenuItem
                                    onClick={() => handleRenameOpen(form)}
                                  >
                                    <HugeiconsIcon
                                      icon={PencilEdit02Icon}
                                      size={16}
                                    />
                                    {t("common.rename")}
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuItem
                                  onClick={() =>
                                    handleArchiveToggle(
                                      form,
                                      viewMode !== "archived"
                                    )
                                  }
                                >
                                  <HugeiconsIcon
                                    icon={
                                      viewMode === "archived"
                                        ? ArchiveRestoreIcon
                                        : ArchiveIcon
                                    }
                                    size={16}
                                  />
                                  {viewMode === "archived"
                                    ? t("common.restore")
                                    : t("common.archive")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ) : null
            )}
          </div>
        )}
      </main>

      <Dialog open={renameOpen} onOpenChange={handleRenameOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dashboard.renameTitle")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void handleRenameSubmit()
            }}
            className="grid gap-3"
          >
            <label className="grid gap-1.5 text-sm font-medium">
              {t("dashboard.titleLabel")}
              <Input
                autoFocus
                dir="auto"
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
                disabled={renamePending}
              />
            </label>
            {renameError ? (
              <p className="text-sm text-destructive">{renameError}</p>
            ) : null}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" size="sm" />}>
                {t("common.cancel")}
              </DialogClose>
              <Button
                type="submit"
                size="sm"
                disabled={renamePending || renameTitle.trim().length === 0}
              >
                {renamePending ? t("common.saving") : t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
