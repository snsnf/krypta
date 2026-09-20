"use client"

import { decryptWithKey, deriveQuizKey, encryptWithKey } from "@krypta/crypto"
import {
  EMPTY_GRADES,
  parseAnswerKey,
  parseGrades,
  type AnswerKey,
  type Grades,
} from "./quiz"

/**
 * Both quiz blobs are encrypted under the quiz key, derived from the form
 * private key, and never under the form data key: that one is the key in the
 * form link, so every respondent holds it. `encryptWithKey` pads, so the
 * ciphertext length says nothing about how many answers or grades there are.
 */

export function sealAnswerKey(key: AnswerKey, formPrivateKey: string): string {
  return encryptWithKey(JSON.stringify(key), deriveQuizKey(formPrivateKey))
}

/**
 * The form's answer key, or null when it has none or it cannot be opened.
 * Unreadable is contained rather than thrown so one bad blob cannot take the
 * whole form down; the builder then shows quiz mode off, and the key is only
 * replaced if a member turns quiz mode on again.
 */
export function openAnswerKey(
  ciphertext: string | null | undefined,
  formPrivateKey: string
): AnswerKey | null {
  if (!ciphertext) return null
  try {
    return parseAnswerKey(
      JSON.parse(decryptWithKey(ciphertext, deriveQuizKey(formPrivateKey)))
    )
  } catch {
    return null
  }
}

export function sealGrades(grades: Grades, formPrivateKey: string): string {
  return encryptWithKey(JSON.stringify(grades), deriveQuizKey(formPrivateKey))
}

/**
 * The form's manual grades: empty when none were ever saved, null when they
 * exist and cannot be opened. The two must stay distinct. Treating unreadable
 * as empty would let the next click save an empty set over every grade.
 */
export function openGrades(
  ciphertext: string | null,
  formPrivateKey: string
): Grades | null {
  if (ciphertext === null) return EMPTY_GRADES
  try {
    return parseGrades(
      JSON.parse(decryptWithKey(ciphertext, deriveQuizKey(formPrivateKey)))
    )
  } catch {
    return null
  }
}
