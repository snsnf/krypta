"use client"

import { useEffect, useState } from "react"
import { decryptBytesWithKey } from "@krypta/crypto"
import { apiDownloadBytes } from "@/lib/api"

/**
 * Resolves a form's header image to an object URL the page can render.
 *
 * The bytes arrive encrypted and are opened here with the schema key, which
 * only ever travels in the link fragment, so the server serving them cannot
 * read them any more than it can read the questions.
 *
 * A failure returns null rather than surfacing an error: a missing header is a
 * cosmetic loss, and a respondent should still get the form.
 */
export function useHeaderImage(
  formId: string | null,
  schemaKey: string | null,
  present: boolean
): string | null {
  /*
   * Keyed by what it was resolved from, and read back through that key, so the
   * effect never has to clear state on the way in. Clearing synchronously in an
   * effect body is a lint error here (cascading renders), and keying also stops
   * one form's image showing for a moment on another.
   */
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(
    null
  )
  const key = formId && schemaKey && present ? `${formId}:${schemaKey}` : null

  useEffect(() => {
    if (!key || !formId || !schemaKey) return
    let cancelled = false
    let objectUrl: string | null = null

    void (async () => {
      try {
        const sealed = await apiDownloadBytes(`/forms/${formId}/header-image`)
        const bytes = decryptBytesWithKey(sealed, schemaKey)
        // A fresh copy: the decrypted view may be backed by a larger buffer,
        // and Blob would otherwise carry the whole thing.
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          objectUrl = null
          return
        }
        setResolved({ key, url: objectUrl })
      } catch {
        // A missing header is cosmetic: leave it unresolved.
      }
    })()

    return () => {
      cancelled = true
      // Revoked on the way out, or every theme change while editing leaks a
      // blob for the lifetime of the document.
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [key, formId, schemaKey])

  return resolved !== null && resolved.key === key ? resolved.url : null
}
