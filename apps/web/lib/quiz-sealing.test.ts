import { beforeAll, describe, expect, test } from "vitest"
import {
  decryptWithKey,
  encryptWithKey,
  generateSealKeyPair,
  generateSymmetricKey,
} from "@krypta/crypto"
import { ensureSodiumReady } from "./sodium-ready"
import { EMPTY_GRADES, setMark, type AnswerKey } from "./quiz"
import {
  openAnswerKey,
  openGrades,
  sealAnswerKey,
  sealGrades,
} from "./quiz-sealing"

const key: AnswerKey = {
  enabled: true,
  questions: { q1: { points: 2, correct: ["Paris"] } },
}

describe("quiz sealing", () => {
  beforeAll(async () => {
    await ensureSodiumReady()
  })

  test("a member's private key opens what it sealed", () => {
    const { privateKey } = generateSealKeyPair()
    expect(openAnswerKey(sealAnswerKey(key, privateKey), privateKey)).toEqual(
      key
    )
    const grades = setMark(EMPTY_GRADES, "r1", "q1", true)
    expect(openGrades(sealGrades(grades, privateKey), privateKey)).toEqual(
      grades
    )
  })

  // The whole reason for the quiz key: the key in the form link, which every
  // respondent holds, must not open the answers.
  test("the link key cannot open the answer key", () => {
    const { privateKey } = generateSealKeyPair()
    const linkKey = generateSymmetricKey()
    expect(() =>
      decryptWithKey(sealAnswerKey(key, privateKey), linkKey)
    ).toThrow()
    // Nor is an answer key encrypted under the link key accepted.
    const underLinkKey = encryptWithKey(JSON.stringify(key), linkKey)
    expect(openAnswerKey(underLinkKey, privateKey)).toBeNull()
  })

  test("another form's key opens nothing", () => {
    const mine = generateSealKeyPair().privateKey
    const theirs = generateSealKeyPair().privateKey
    expect(openAnswerKey(sealAnswerKey(key, mine), theirs)).toBeNull()
    expect(openGrades(sealGrades(EMPTY_GRADES, mine), theirs)).toBeNull()
  })

  test("absent is not unreadable", () => {
    const { privateKey } = generateSealKeyPair()
    expect(openAnswerKey(null, privateKey)).toBeNull()
    expect(openGrades(null, privateKey)).toEqual(EMPTY_GRADES)
  })
})
