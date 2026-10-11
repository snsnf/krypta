import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"

/*
 * Scans what a page shows for English that was missed, in an Arabic browser.
 * A translated string is checked by the catalogue tests; this is the guard
 * against the one nobody wrapped in t().
 */

// Words that are the same in both languages: the brands, formats, the literal
// the delete box asks for, and a language written in its own language.
const ALLOWED =
  /\b(krypta|GitHub|CSV|DELETE|QR|hex|URL|KEM|English|docker compose)\b/g

export async function leftoverEnglish(
  page: Page,
  also?: RegExp
): Promise<string[]> {
  const texts = await page.evaluate(() => {
    const out: string[] = []
    // User-written text (a form title, a question, an answer) carries
    // dir="auto" and is never translated, so it is not English left over even
    // on an account whose forms are named in English. It is also quoted inside
    // labels such as "Actions for <title>", which is why it is collected and
    // cut out of every string rather than only skipped where it appears.
    const userText = Array.from(document.body.querySelectorAll("[dir='auto']"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => text.length > 0)
      .sort((a, b) => b.length - a.length)
    const withoutUserText = (text: string) =>
      userText.reduce((rest, user) => rest.split(user).join(""), text)
    const skip = (node: Element) =>
      node.closest(
        "nextjs-portal, [role='combobox'], [aria-hidden='true'], [dir='auto'], script, style"
      ) !== null
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    )
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement
      if (parent && !skip(parent))
        out.push(withoutUserText(n.textContent ?? ""))
    }
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (skip(el)) continue
      for (const attr of ["aria-label", "placeholder", "title", "alt"]) {
        const value = el.getAttribute(attr)
        if (value) out.push(withoutUserText(value))
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
