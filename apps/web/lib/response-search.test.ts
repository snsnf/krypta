import { describe, expect, test } from "vitest"
import type { Question } from "@krypta/crypto"
import type { AnswerValue } from "./form-answers"
import { encodeOtherAnswer } from "./form-other"
import {
  filterResponses,
  normalizeForSearch,
  responseSearchText,
  searchTerms,
} from "./response-search"

function q(id: string, type: Question["type"] = "short_text"): Question {
  return { id, type, label: id }
}

function response(answers: Record<string, AnswerValue>) {
  return { id: `r-${JSON.stringify(answers)}`, answers }
}

describe("normalizeForSearch", () => {
  test("folds the Arabic letters people type interchangeably", () => {
    const same = (a: string, b: string) =>
      expect(normalizeForSearch(a)).toBe(normalizeForSearch(b))
    // Alef with hamza above, below, and madda, all typed as a bare alef.
    same("أحمد", "احمد")
    same("إسلام", "اسلام")
    same("آمنة", "امنه")
    // Taa marbuta written as haa, and alef maqsura written as yaa.
    same("مدرسة", "مدرسه")
    same("مستشفى", "مستشفي")
    // Harakat are dropped with the other combining marks.
    same("مُحَمَّد", "محمد")
  })

  test("folds case", () => {
    expect(normalizeForSearch("Lisboa")).toBe("lisboa")
  })

  test("folds accents so an unaccented query finds an accented answer", () => {
    expect(normalizeForSearch("José")).toBe("jose")
    expect(normalizeForSearch("Ångström")).toBe("angstrom")
  })
})

describe("searchTerms", () => {
  test("splits on whitespace and drops the padding", () => {
    expect(searchTerms("  ana   lisboa ")).toEqual(["ana", "lisboa"])
  })

  test("a blank query asks for nothing", () => {
    expect(searchTerms("")).toEqual([])
    expect(searchTerms("   ")).toEqual([])
  })
})

describe("responseSearchText", () => {
  const questions = [
    q("name"),
    q("cities", "checkboxes"),
    q("cv", "file_upload"),
  ]

  test("reads a written-in Other answer as what the respondent typed", () => {
    const text = responseSearchText(questions, {
      cities: [encodeOtherAnswer("Faro")],
    })
    expect(text).toContain("faro")
    // The marker must never reach the haystack, or a search for the text a
    // respondent actually typed would have to include a character nobody can
    // type.
    // Built rather than written as an escape: prettier rewrites "\u0000" in
    // source into a raw NUL byte, which is invisible in a diff and in a grep.
    expect(text).not.toContain(String.fromCharCode(0))
    expect(text).not.toContain("other:")
  })

  test("reads an uploaded file as its filename", () => {
    const text = responseSearchText(questions, {
      cv: {
        attachmentId: "a1",
        filename: "Resume-2026.pdf",
        mimeType: "application/pdf",
        size: 10,
      },
    })
    expect(text).toContain("resume-2026.pdf")
    // The attachment id is machine detail the owner never sees in the table,
    // so matching it would make a search hit a row with nothing visible in it.
    expect(text).not.toContain("a1")
  })

  test("ignores answers to questions the schema no longer holds", () => {
    const text = responseSearchText([q("name")], {
      name: "Ana",
      deleted: "Porto",
    })
    expect(text).toContain("ana")
    expect(text).not.toContain("porto")
  })
})

describe("filterResponses", () => {
  const questions = [q("name"), q("city")]
  const responses = [
    response({ name: "Ana", city: "Lisboa" }),
    response({ name: "Bruno", city: "Porto" }),
    response({ name: "Carla", city: "Lisboa" }),
  ]

  test("a blank query returns everything, numbered from one", () => {
    expect(filterResponses(questions, responses, "  ")).toEqual([
      { response: responses[0], position: 1 },
      { response: responses[1], position: 2 },
      { response: responses[2], position: 3 },
    ])
  })

  test("keeps the position a response has in the full list", () => {
    const matches = filterResponses(questions, responses, "carla")
    expect(matches).toHaveLength(1)
    expect(matches[0].position).toBe(3)
  })

  test("every term has to match, and they may be in different answers", () => {
    expect(filterResponses(questions, responses, "ana lisboa")).toHaveLength(1)
    expect(filterResponses(questions, responses, "ana porto")).toHaveLength(0)
  })

  test("matches across answers but never across the boundary between them", () => {
    // "Ana" and "Lisboa" are adjacent answers. A query for text that only
    // exists by reading the end of one into the start of the next must not
    // match, or a response reads as containing something nobody wrote.
    expect(filterResponses(questions, responses, "analisboa")).toHaveLength(0)
  })

  test("matches a substring rather than a whole word", () => {
    expect(filterResponses(questions, responses, "isbo")).toHaveLength(2)
  })

  test("ignores case and accents in both directions", () => {
    const accented = [response({ name: "José", city: "Évora" })]
    expect(filterResponses(questions, accented, "jose")).toHaveLength(1)
    expect(filterResponses(questions, accented, "ÉVORA")).toHaveLength(1)
  })

  test("a query nothing matches returns nothing", () => {
    expect(filterResponses(questions, responses, "madrid")).toEqual([])
  })

  test("an unanswered question is not a match for an empty-looking query", () => {
    const sparse = [response({ name: "Ana" })]
    expect(filterResponses(questions, sparse, "ana")).toHaveLength(1)
  })
})
