import type { Question } from "@krypta/crypto"

/**
 * Splits questions into pages at each `pageBreakBefore: true` boundary.
 * A marker on the first question is a no-op: there is no page to break
 * before. No breaks anywhere means exactly one page, i.e. today's
 * single-page behavior.
 */
export function splitFormIntoPages(questions: Question[]): Question[][] {
  const pages: Question[][] = [[]]
  questions.forEach((question, index) => {
    if (index > 0 && question.pageBreakBefore) {
      pages.push([])
    }
    pages[pages.length - 1].push(question)
  })
  return pages
}
