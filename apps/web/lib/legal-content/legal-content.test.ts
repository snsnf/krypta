import { describe, expect, it } from "vitest"
import { PRIVACY } from "./privacy"
import { SECURITY } from "./security"
import { TERMS } from "./terms"
import type { Block, LocalizedDoc } from "./types"

/*
 * The two languages of a page must say the same things in the same order.
 * These cannot prove the Arabic is right (a person reads that), but they catch
 * a paragraph dropped from one language, a list that lost an entry, or an
 * operator placeholder that only one of them carries.
 */
const shape = (block: Block) =>
  block.kind === "text"
    ? "text"
    : `${block.kind}:${block.kind === "list" ? block.items.length : block.items.length}`

const marks = (text: string) =>
  [...text.matchAll(/\{\w+\}|\*\*|\]\(\/[^)]*\)/g)].map((m) => m[0]).sort()

function everyText(doc: LocalizedDoc["en"]): string[] {
  return [
    doc.lead,
    ...doc.intro,
    ...doc.sections.flatMap((section) =>
      section.blocks.flatMap((block) =>
        block.kind === "text"
          ? [block.text]
          : block.kind === "list"
            ? block.items
            : block.items.flatMap((item) => [item.title, item.body])
      )
    ),
  ]
}

describe.each([
  ["privacy", PRIVACY],
  ["terms", TERMS],
  ["security", SECURITY],
])("the %s document", (_name, doc) => {
  it("has the same sections, blocks and list lengths in both languages", () => {
    expect(doc.ar.sections.map((s) => s.blocks.map(shape))).toEqual(
      doc.en.sections.map((s) => s.blocks.map(shape))
    )
    expect(doc.ar.intro.length).toBe(doc.en.intro.length)
  })

  it("carries the same placeholders and links in every paragraph", () => {
    const en = everyText(doc.en)
    const ar = everyText(doc.ar)
    expect(ar.length).toBe(en.length)
    en.forEach((text, index) => {
      // The Arabic lead adds the note that the English text prevails.
      expect(marks(ar[index]), text.slice(0, 40)).toEqual(marks(text))
    })
  })

  it("is written in Arabic, with no dash and no stray English paragraph", () => {
    for (const text of everyText(doc.ar)) {
      expect(text).toMatch(/[؀-ۿ]/)
      expect(text).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
