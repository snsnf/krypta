import type { Question } from "@krypta/crypto"

/**
 * Move a question to an absolute index. Out-of-range targets and unknown ids
 * are no-ops rather than errors: both are reachable from a drag that ends
 * outside the list, and neither is worth failing a render over.
 *
 * An absolute index rather than a delta because drag lands on an arbitrary
 * position; the keyboard path passes `currentIndex ± 1`.
 */
export function moveQuestion(
  questions: Question[],
  id: string,
  toIndex: number
): Question[] {
  const from = questions.findIndex((question) => question.id === id)
  if (from === -1 || toIndex < 0 || toIndex >= questions.length) {
    return questions
  }
  if (from === toIndex) return questions

  const next = [...questions]
  const [moved] = next.splice(from, 1)
  next.splice(toIndex, 0, moved)
  return next
}

/**
 * Copy a question immediately after itself, carrying every field but the id.
 *
 * Landing directly after the original is what keeps a copied `condition`
 * valid: its source is still earlier. `newId` is a parameter rather than
 * generated here so this stays pure and its test can assert an exact array.
 */
export function duplicateQuestion(
  questions: Question[],
  id: string,
  newId: string
): Question[] {
  const index = questions.findIndex((question) => question.id === id)
  if (index === -1) return questions

  const next = [...questions]
  next.splice(index + 1, 0, { ...questions[index], id: newId })
  return next
}
