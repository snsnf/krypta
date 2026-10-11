/** One family served from this origin, as listed in lib/font-catalog.json. */
export interface FontCatalogEntry {
  /** Fontsource id, also the path segment under /fonts/. */
  id: string
  family: string
  category: string
  /** Variant names as the picker shows them: "regular", "italic", "700", "700italic". */
  variants: string[]
}

export interface FontCatalogPayload {
  fonts: FontCatalogEntry[]
}
