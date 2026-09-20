/**
 * Search across a form's responses.
 *
 * This runs entirely in the browser, over responses that have already been
 * decrypted into memory, and it has to stay that way. The server stores
 * `responses.ciphertext` and holds no key, so it cannot filter; the only ways
 * it ever could are the browser sending it the query, or the browser sending
 * it a searchable index of what the answers say. Both hand it the content this
 * product exists to keep from it. So there is no query parameter here and no
 * endpoint to add one to, and a future "search is slow on large forms" is
 * answered by doing less work in this file, never by moving it.
 *
 * What is searched is what the owner can already see. `formatAnswer` builds the
 * same string the response table puts in a cell and the CSV export puts in a
 * field, so a written-in "Other" answer is matched on the text the respondent
 * typed rather than on its U+0000 marker, and an uploaded file is matched on
 * its filename. A file's bytes are not searched: they are sealed to the form
 * private key and fetched one at a time on demand, so they are not in memory to
 * search, and downloading every attachment to grep it is not a search feature.
 *
 * Only questions the schema still holds are searched, which is the same rule
 * the table follows when it gives a deleted question no column. An answer to a
 * question the form no longer asks is not something the owner is looking at.
 */
import type { Question } from "@krypta/crypto"
import { type AnswerValue, formatAnswer } from "./form-answers"

/** The part of a decrypted response this module needs. */
export interface SearchableResponse {
  answers: Record<string, AnswerValue>
}

export interface MatchedResponse<T> {
  response: T
  /**
   * Where this response sits in the unfiltered list, counting from 1.
   *
   * The table numbers its rows, and that number has to keep meaning the same
   * thing while a search narrows what is on screen. Numbering the filtered
   * rows instead would rename response 7 to response 2 for as long as a query
   * happened to be typed, so "the third response" would name a different
   * response to two people looking at the same form.
   */
  position: number
}

/**
 * Folds away the differences a person does not mean to type.
 *
 * Case first, because nobody searching for a name is asking about its
 * capitalisation. Then combining marks, so "jose" finds "José": a respondent
 * types their own name with the accents and the owner searching for it very
 * often does not, and a search that misses on that is read as a search that is
 * broken. NFD splits an accented character into a base plus its mark so the
 * mark can be dropped; the base is what stays.
 */
export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/**
 * The words a query is asking for.
 *
 * A query is split on whitespace and every term has to match, rather than the
 * whole query being one string to find. Someone typing two words means a
 * response with both in it, and the terms are very often in two different
 * answers (a first name in one question, a city in another), which a single
 * substring search over the joined text would only find if they happened to be
 * typed in the same order the questions are in.
 */
export function searchTerms(query: string): string[] {
  return normalizeForSearch(query)
    .split(/\s+/)
    .filter((term) => term !== "")
}

/**
 * Everything one response offers a search, as a single normalized string.
 *
 * Answers are joined with a newline, which no term can contain, so a match
 * cannot straddle two answers and report a response that reads correctly only
 * because two unrelated fields sit next to each other.
 */
export function responseSearchText(
  questions: Question[],
  answers: Record<string, AnswerValue>
): string {
  return normalizeForSearch(
    questions.map((question) => formatAnswer(answers[question.id])).join("\n")
  )
}

/**
 * The responses a query selects, each with its position in the full list.
 *
 * An empty query selects everything, so the caller needs no separate "is a
 * search active" branch to render the unfiltered list.
 *
 * Matching is substring rather than whole word: "ana" finds "Ana" and also
 * "Joanna". That direction is the safe one for a reader who is looking for
 * something they know is there, since the failure of a word-boundary match is
 * a response that exists and cannot be found, which reads as data loss.
 */
export function filterResponses<T extends SearchableResponse>(
  questions: Question[],
  responses: T[],
  query: string
): MatchedResponse<T>[] {
  const terms = searchTerms(query)
  const all = responses.map((response, index) => ({
    response,
    position: index + 1,
  }))
  if (terms.length === 0) return all

  return all.filter(({ response }) => {
    const text = responseSearchText(questions, response.answers)
    return terms.every((term) => text.includes(term))
  })
}
