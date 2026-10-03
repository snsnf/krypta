import type { AppLanguage } from "@/lib/app-locale"

/*
 * The long pages (/privacy, /terms, /security) as data, one document per
 * language, so a translation is a second object of the same shape rather than
 * a second copy of the layout. Inline markup is deliberately tiny:
 * `**bold**` and `[text](/path)`, rendered by components/prose-document.tsx.
 * `{entity}` and `{email}` are the operator's details, filled at request time.
 */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "limits"; items: { title: string; body: string }[] }

export interface Section {
  title: string
  blocks: Block[]
}

export interface ProseDoc {
  title: string
  description: string
  /** When the text last changed, in prose, written by hand. */
  updated?: string
  /** The opening paragraph, set larger than the rest. */
  lead: string
  /** Paragraphs between the lead and the first section. */
  intro: string[]
  sections: Section[]
}

export type LocalizedDoc = Record<AppLanguage, ProseDoc>
