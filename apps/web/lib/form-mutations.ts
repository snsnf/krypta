import { ApiClientError } from "./api"

type FormPatch = Record<string, unknown>
type MutationSender = (
  patch: FormPatch,
  expectedVersion: number
) => Promise<{ version: number }>

export interface FormMutationQueue {
  enqueue: (patch: FormPatch) => Promise<number>
  conflicted: () => boolean
  version: () => number
}

interface VersionRef {
  current: number
}

export function createFormMutationQueue(
  versionRef: VersionRef,
  send: MutationSender
): FormMutationQueue {
  let conflict: ApiClientError | null = null
  let tail = Promise.resolve()

  function enqueue(patch: FormPatch): Promise<number> {
    const operation = tail.then(async () => {
      if (conflict !== null) throw conflict
      try {
        const result = await send(patch, versionRef.current)
        versionRef.current = result.version
        return versionRef.current
      } catch (error) {
        if (error instanceof ApiClientError && error.code === "conflict") {
          conflict = error
        }
        throw error
      }
    })
    tail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  return {
    enqueue,
    conflicted: () => conflict !== null,
    version: () => versionRef.current,
  }
}

interface ClipboardDraft {
  title: unknown
  questions: unknown
  theme: unknown
  settings: unknown
  [key: string]: unknown
}

export function serializeDraftForClipboard(draft: ClipboardDraft): string {
  return JSON.stringify({
    title: draft.title,
    questions: draft.questions,
    theme: draft.theme,
    settings: draft.settings,
  })
}
