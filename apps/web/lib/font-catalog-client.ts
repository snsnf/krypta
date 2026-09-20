import type { FontCatalogEntry, FontCatalogPayload } from "./fonts"

let pending: Promise<readonly FontCatalogEntry[]> | null = null

/**
 * The font catalogue from `/api/fonts`, fetched once per page and shared by
 * every component that needs it (the font picker, the variant list and the
 * themed surface). Kept out of the bundle because it lists every family, and
 * a failed request is forgotten so the next caller can try again.
 */
export function loadFontCatalog(): Promise<readonly FontCatalogEntry[]> {
  pending ??= fetch("/api/fonts")
    .then(async (response) => {
      if (!response.ok) throw new Error("Font catalogue request failed")
      const payload = (await response.json()) as FontCatalogPayload
      if (!Array.isArray(payload.fonts)) {
        throw new Error("Font catalogue payload is invalid")
      }
      return payload.fonts
    })
    .catch((error: unknown) => {
      pending = null
      throw error
    })
  return pending
}
