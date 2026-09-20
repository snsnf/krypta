/**
 * What a respondent's browser sends when it submits or edits a response.
 *
 * Submission and editing build the same payload, and they used to build it
 * separately in two pages. One definition here means the filter, the seal and
 * the size check cannot drift apart between them.
 */
import { sealBox, type Question } from "@krypta/crypto"
import { isFileAnswer, type AnswerValue } from "./form-answers"
import { visibleQuestions } from "./form-visibility"

/**
 * The largest sealed response this client will send. The API refuses a body
 * over `MAX_RESPONSE_BODY_BYTES` (512 KiB, in `apps/api/src/forms/routes.rs`)
 * before it reaches the handler, and that refusal is a bare 413 this client
 * cannot word for a person. Checking here first, with room left for the JSON
 * around the ciphertext and the attachment ids, lets the page say what went
 * wrong instead.
 */
export const MAX_RESPONSE_CIPHERTEXT_BYTES = 500 * 1024

export class ResponseTooLargeError extends Error {
  constructor() {
    super("response too large")
  }
}

/**
 * The attachment ids a set of answers references. The server cannot read them
 * from the ciphertext, so they travel beside it: on submission and edit so the
 * uploads are not reclaimed as abandoned, and on deletion so they are removed.
 */
export function attachmentIdsOf(
  answers: Record<string, AnswerValue | undefined>
): string[] {
  return Object.values(answers)
    .filter(isFileAnswer)
    .map((answer) => answer.attachmentId)
}

export function buildResponsePayload(
  questions: Question[],
  answers: Record<string, AnswerValue | undefined>,
  publicKey: string
): { ciphertext: string; attachment_ids: string[] } {
  // A response records what was actually asked. An answer to a question the
  // respondent branched away from is not part of it: keeping one would corrupt
  // the owner's table and the summary. Local state keeps it so toggling a
  // branch back and forth does not destroy work; only the submitted payload
  // is filtered.
  const submitted = Object.fromEntries(
    visibleQuestions(questions, answers)
      .map((question) => [question.id, answers[question.id]] as const)
      .filter(([, value]) => value !== undefined)
  )
  const ciphertext = sealBox(JSON.stringify(submitted), publicKey)
  if (ciphertext.length > MAX_RESPONSE_CIPHERTEXT_BYTES) {
    throw new ResponseTooLargeError()
  }
  return { ciphertext, attachment_ids: attachmentIdsOf(submitted) }
}
