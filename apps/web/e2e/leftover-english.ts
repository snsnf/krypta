import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"

/*
 * Scans what a page shows for English that was missed, in an Arabic browser.
 * A translated string is checked by the catalogue tests; this is the guard
 * against the one nobody wrapped in t().
 */

// Words that are the same in both languages: the brand, formats, the literal
// the delete box asks for, and a language written in its own language.
const ALLOWED = /\b(krypta|CSV|DELETE|QR|hex|URL|KEM|English|docker compose)\b/g

export async function leftoverEnglish(
  page: Page,
  also?: RegExp
): Promise<string[]> {
  const texts = await page.evaluate(() => {
    const out: string[] = []
    const skip = (node: Element) =>
      node.closest(
        "nextjs-portal, [role='combobox'], [aria-hidden='true'], script, style"
      ) !== null
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    )
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement
      if (parent && !skip(parent)) out.push(n.textContent ?? "")
    }
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (skip(el)) continue
      for (const attr of ["aria-label", "placeholder", "title", "alt"]) {
        const value = el.getAttribute(attr)
        if (value) out.push(value)
      }
    }
    return out
  })
  return texts
    .map((text) => {
      const plain = text.replace(/\S+@\S+/g, "").replace(ALLOWED, "")
      return also ? plain.replace(also, "") : plain
    })
    .flatMap((text) => text.match(/[A-Za-z]{3,}[A-Za-z' ]*/g) ?? [])
    .map((run) => run.trim())
    .filter((run) => run.length > 0)
}

/** `also` names terms this one page is allowed to keep in Latin script. */
export async function expectNoEnglish(
  page: Page,
  where: string,
  also?: RegExp
) {
  // Let streamed content and animations settle before reading the page.
  await page.waitForTimeout(400)
  expect(await leftoverEnglish(page, also), `English left on ${where}`).toEqual(
    []
  )
}
