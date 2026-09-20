"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  CheckmarkCircle02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"
import {
  encryptWithKey,
  formKeyCommitment,
  generateSealKeyPair,
  generateSymmetricKey,
  wrapKey,
  type FormSchema,
  type FormSettings,
  type FormTheme,
  type Question,
} from "@krypta/crypto"
import { ApiClientError, apiFetch } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { ensureSodiumReady } from "@/lib/sodium-ready"
import { useEnsureUnlocked } from "@/hooks/use-ensure-unlocked"
import { Button } from "@/components/ui/button"
import { AppHeader } from "@/components/app-header"
import { PreviewButton } from "@/components/preview-button"
import { FormBuilder } from "@/components/form-builder"
import { FormSettingsPanel } from "@/components/settings/form-settings-panel"
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { DEFAULT_FORM_THEME } from "@/lib/form-theme"
import { DEFAULT_FORM_SETTINGS } from "@/lib/form-settings"
import { reconcileAnswerKey, type AnswerKey } from "@/lib/quiz"
import { sealAnswerKey } from "@/lib/quiz-sealing"

/*
 * A draft has the same three tabs as a published form, so a creator can set
 * everything up before the first publish. Nothing leaves the browser until
 * Publish: every setting below is held in this page's state, and the one
 * create request carries all of it, so a form never exists on the server with
 * settings it was not meant to have.
 */
export default function NewFormPage() {
  useEnsureUnlocked()
  const router = useRouter()
  const accountKey = useAuthStore((s) => s.accountKey)
  const [tab, setTab] = useState("questions")
  const [title, setTitle] = useState("")
  const [questions, setQuestions] = useState<Question[]>([
    { id: crypto.randomUUID(), type: "short_text", label: "" },
  ])
  const [theme, setTheme] = useState<FormTheme>(DEFAULT_FORM_THEME)
  const [answerKey, setAnswerKey] = useState<AnswerKey | null>(null)
  const [settings, setSettings] = useState<FormSettings>(DEFAULT_FORM_SETTINGS)
  // The column defaults a form created without them gets.
  const [allowResponseEditing, setAllowResponseEditing] = useState(false)
  const [acceptingResponses, setAcceptingResponses] = useState(true)
  const [notifyOnResponse, setNotifyOnResponse] = useState(true)
  const [closesAt, setClosesAt] = useState<string | null>(null)
  const [maxResponses, setMaxResponses] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  // Off keeps the key rather than dropping it, so switching back on loses
  // nothing the creator had marked.
  function handleQuizEnabledChange(enabled: boolean) {
    setAnswerKey((current) =>
      current ? { ...current, enabled } : { enabled, questions: {} }
    )
  }

  async function handleSave() {
    if (!accountKey) {
      window.location.href = "/unlock"
      return
    }
    setSaving(true)
    try {
      await ensureSodiumReady()

      const formDataKey = generateSymmetricKey()
      const { publicKey, privateKey } = generateSealKeyPair()
      // Binds the key respondents seal to into the schema the link's key
      // authenticates, so a key swapped in the database is refused.
      const schema: FormSchema = {
        questions,
        theme,
        settings,
        publicKeyCommitment: formKeyCommitment(publicKey),
      }

      const titleCiphertext = encryptWithKey(title, formDataKey)
      const schemaCiphertext = encryptWithKey(
        JSON.stringify(schema),
        formDataKey
      )
      const wrappedFormDataKey = wrapKey(formDataKey, accountKey)
      const wrappedFormPrivateKey = wrapKey(privateKey, accountKey)

      const { id } = await apiFetch<{ id: string }>("/forms", {
        method: "POST",
        body: JSON.stringify({
          title_ciphertext: titleCiphertext,
          schema_ciphertext: schemaCiphertext,
          form_public_key: publicKey,
          wrapped_form_private_key: wrappedFormPrivateKey,
          wrapped_form_data_key: wrappedFormDataKey,
          // Sealed under the key derived from the private key just generated,
          // never under the form data key that goes into the link.
          answer_key_ciphertext: answerKey
            ? sealAnswerKey(
                reconcileAnswerKey(questions, answerKey),
                privateKey
              )
            : undefined,
          // The same plaintext settings a published form's Settings tab
          // writes. The confirmation message and one-response-per-person are
          // not here: they sit in `settings`, inside the encrypted schema.
          allow_response_editing: allowResponseEditing,
          accepting_responses: acceptingResponses,
          closes_at: closesAt,
          max_responses: maxResponses,
          notify_on_response: notifyOnResponse,
        }),
      })

      // The form data key travels in the URL fragment (not the query string) because fragments are
      // never sent to the server, which keeps the secret key out of access logs, proxy logs, and
      // Referer headers. Client-side navigation (not window.location.href) is used because a hard
      // reload would wipe the in-memory Master Key.
      router.push(
        `/dashboard/${id}?created=1#key=${encodeURIComponent(formDataKey)}`
      )
    } catch (error) {
      setSaving(false)
      toast.add({
        title: "Could not publish the form",
        description:
          error instanceof ApiClientError && error.code === "rate_limited"
            ? "This account is at its limit of open forms. Close another form, then publish this one."
            : "Something went wrong. Try again.",
        type: "error",
      })
    }
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
      <div className="flex h-svh flex-col overflow-hidden">
        <div className="shrink-0">
          <AppHeader
            formName={title}
            actions={
              <>
                {tab === "questions" && (
                  <PreviewButton onClick={() => setPreviewOpen(true)} />
                )}
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || !title}
                  className="transition-transform duration-150 ease-out active:scale-[0.97]"
                >
                  <HugeiconsIcon
                    icon={saving ? Loading03Icon : CheckmarkCircle02Icon}
                    size={16}
                    className={saving ? "animate-spin" : undefined}
                    data-icon="inline-start"
                  />
                  {saving ? (
                    /* Reserves the resting label so the button keeps its width.
                       See the same overlay on the builder's save button. */
                    <span className="grid *:col-start-1 *:row-start-1">
                      <span className="invisible">
                        <span className="sm:hidden">Publish</span>
                        <span className="hidden sm:inline">Publish form</span>
                      </span>
                      <span>Saving...</span>
                    </span>
                  ) : (
                    <>
                      <span className="sm:hidden">Publish</span>
                      <span className="hidden sm:inline">Publish form</span>
                    </>
                  )}
                </Button>
              </>
            }
          />
          <div className="bg-background/85 backdrop-blur-sm">
            <div className="mx-auto w-full max-w-7xl px-4">
              <TabsList className="justify-center">
                <TabsTrigger value="questions">Questions</TabsTrigger>
                <TabsTrigger value="responses">Responses</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
                <TabsIndicator />
              </TabsList>
            </div>
          </div>
        </div>
        <TabsContent
          value="questions"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <FormBuilder
            eyebrowLabel="New form"
            title={title}
            onTitleChange={setTitle}
            questions={questions}
            onQuestionsChange={setQuestions}
            theme={theme}
            onThemeChange={setTheme}
            answerKey={answerKey}
            onAnswerKeyChange={setAnswerKey}
            previewOpen={previewOpen}
            onPreviewOpenChange={setPreviewOpen}
          />
        </TabsContent>
        <TabsContent
          value="responses"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-3xl flex-1 p-4">
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in">
              <p className="text-sm font-medium">No responses yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                This form isn&apos;t published, so nobody can answer it.
                Publish it to get a link to share.
              </p>
            </div>
          </div>
        </TabsContent>
        <TabsContent
          value="settings"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <FormSettingsPanel
            settings={settings}
            onSettingsChange={setSettings}
            allowResponseEditing={allowResponseEditing}
            onAllowResponseEditingChange={setAllowResponseEditing}
            acceptingResponses={acceptingResponses}
            onAcceptingResponsesChange={setAcceptingResponses}
            notifyOnResponse={notifyOnResponse}
            onNotifyOnResponseChange={setNotifyOnResponse}
            closesAt={closesAt}
            onClosesAtChange={setClosesAt}
            maxResponses={maxResponses}
            onMaxResponsesChange={setMaxResponses}
            quizEnabled={answerKey?.enabled === true}
            onQuizEnabledChange={handleQuizEnabledChange}
            canEdit
            // Nothing exists to delete before the first publish, so the
            // danger zone, which only an owner sees, stays hidden.
            isOwner={false}
            onDelete={async () => {}}
          />
        </TabsContent>
      </div>
    </Tabs>
  )
}
