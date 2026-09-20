import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  DRAFT_MAX_AGE_MS,
  clearDraft,
  hasSubmitted,
  loadDraft,
  markSubmitted,
  saveDraft,
  sweepExpiredDrafts,
} from "./form-draft"

/**
 * The module reads `window.localStorage`, which this Node-only vitest does not
 * have. This is the smallest stand-in that still behaves like the real thing,
 * including throwing on demand: Safari's private mode throws from `setItem`
 * once the quota is reached, and a draft that cannot be written must never
 * take the form down with it.
 */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    throwOnSet: false,
    throwOnGet: false,
    getItem(key: string) {
      if (this.throwOnGet) throw new Error("denied")
      return map.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (this.throwOnSet) throw new Error("QuotaExceededError")
      map.set(key, value)
    },
    removeItem(key: string) {
      map.delete(key)
    },
    get length() {
      return map.size
    },
    key(index: number) {
      return [...map.keys()][index] ?? null
    },
  }
}

let storage: ReturnType<typeof fakeStorage>

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal("window", { localStorage: storage })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("saveDraft and loadDraft", () => {
  test("round-trips answers for one form", () => {
    saveDraft("form-1", { q1: "hello", q2: ["a", "b"] })
    expect(loadDraft("form-1")).toEqual({ q1: "hello", q2: ["a", "b"] })
  })

  test("keeps drafts for different forms apart", () => {
    saveDraft("form-1", { q1: "one" })
    saveDraft("form-2", { q1: "two" })
    expect(loadDraft("form-1")).toEqual({ q1: "one" })
    expect(loadDraft("form-2")).toEqual({ q1: "two" })
  })

  test("returns null when no draft was ever saved", () => {
    expect(loadDraft("form-1")).toBeNull()
  })

  test("saving an empty set of answers removes the draft", () => {
    saveDraft("form-1", { q1: "hello" })
    saveDraft("form-1", {})
    expect(loadDraft("form-1")).toBeNull()
    expect(storage.map.has("krypta:draft:form-1")).toBe(false)
  })

  test("a file answer survives, because the upload already happened", () => {
    const file = {
      attachmentId: "att-1",
      filename: "cv.pdf",
      mimeType: "application/pdf",
      size: 1024,
    }
    saveDraft("form-1", { q1: file })
    expect(loadDraft("form-1")).toEqual({ q1: file })
  })
})

describe("loadDraft rejects anything it cannot trust", () => {
  test("drops a draft older than the maximum age", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    saveDraft("form-1", { q1: "hello" })

    vi.setSystemTime(Date.now() + DRAFT_MAX_AGE_MS + 1)
    expect(loadDraft("form-1")).toBeNull()
    // Reading an expired draft also clears it, so an abandoned answer does
    // not sit on a shared machine forever waiting for a read that never comes.
    expect(storage.map.has("krypta:draft:form-1")).toBe(false)
  })

  test("keeps a draft that is not yet expired", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    saveDraft("form-1", { q1: "hello" })

    vi.setSystemTime(Date.now() + DRAFT_MAX_AGE_MS - 1000)
    expect(loadDraft("form-1")).toEqual({ q1: "hello" })
  })

  test("returns null for corrupt JSON", () => {
    storage.map.set("krypta:draft:form-1", "{not json")
    expect(loadDraft("form-1")).toBeNull()
  })

  test("returns null when the stored shape is wrong", () => {
    storage.map.set("krypta:draft:form-1", JSON.stringify(["not", "a record"]))
    expect(loadDraft("form-1")).toBeNull()
  })

  test("returns null when the timestamp is missing", () => {
    storage.map.set(
      "krypta:draft:form-1",
      JSON.stringify({ answers: { q1: "hello" } })
    )
    expect(loadDraft("form-1")).toBeNull()
  })

  test("drops answer values that are not a string, list or file", () => {
    storage.map.set(
      "krypta:draft:form-1",
      JSON.stringify({
        savedAt: Date.now(),
        answers: { good: "kept", bad: 42, alsoBad: null, worse: [1, 2] },
      })
    )
    expect(loadDraft("form-1")).toEqual({ good: "kept" })
  })

  test("returns null when every answer was rejected", () => {
    storage.map.set(
      "krypta:draft:form-1",
      JSON.stringify({ savedAt: Date.now(), answers: { bad: 42 } })
    )
    expect(loadDraft("form-1")).toBeNull()
  })

  test("survives storage that throws on read", () => {
    storage.throwOnGet = true
    expect(loadDraft("form-1")).toBeNull()
  })
})

describe("saveDraft never breaks the form", () => {
  test("swallows a storage that throws on write", () => {
    storage.throwOnSet = true
    expect(() => saveDraft("form-1", { q1: "hello" })).not.toThrow()
  })

  test("does nothing when there is no window at all", () => {
    vi.stubGlobal("window", undefined)
    expect(() => saveDraft("form-1", { q1: "hello" })).not.toThrow()
    expect(loadDraft("form-1")).toBeNull()
  })
})

describe("clearDraft", () => {
  test("removes the draft", () => {
    saveDraft("form-1", { q1: "hello" })
    clearDraft("form-1")
    expect(loadDraft("form-1")).toBeNull()
  })

  test("leaves other forms alone", () => {
    saveDraft("form-1", { q1: "one" })
    saveDraft("form-2", { q1: "two" })
    clearDraft("form-1")
    expect(loadDraft("form-2")).toEqual({ q1: "two" })
  })
})

describe("the submitted marker", () => {
  test("records and reads back a submission", () => {
    expect(hasSubmitted("form-1")).toBe(false)
    markSubmitted("form-1")
    expect(hasSubmitted("form-1")).toBe(true)
  })

  test("stays keyed as it was before this module owned it", () => {
    markSubmitted("form-1")
    expect(storage.map.get("krypta:submitted:form-1")).toBe("1")
  })

  test("is per form", () => {
    markSubmitted("form-1")
    expect(hasSubmitted("form-2")).toBe(false)
  })
})

describe("saveDraft reports whether anything is on the device", () => {
  test("true once the write lands, false when there is nothing to keep", () => {
    expect(saveDraft("form-1", { q1: "hello" })).toBe(true)
    expect(saveDraft("form-1", {})).toBe(false)
  })

  test("false when storage refuses the write, which is when the page must not claim otherwise", () => {
    storage.throwOnSet = true
    expect(saveDraft("form-1", { q1: "hello" })).toBe(false)
  })
})

describe("sweepExpiredDrafts", () => {
  test("ages out another form's draft that is never opened again", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    saveDraft("abandoned", { q1: "left on a shared machine" })
    vi.setSystemTime(Date.now() + DRAFT_MAX_AGE_MS - 1000)
    saveDraft("recent", { q1: "still in progress" })

    vi.setSystemTime(Date.now() + 2000)
    sweepExpiredDrafts()

    expect(storage.map.has("krypta:draft:abandoned")).toBe(false)
    expect(loadDraft("recent")).toEqual({ q1: "still in progress" })
  })

  test("removes unreadable entries under the draft prefix and nothing else", () => {
    storage.map.set("krypta:draft:broken", "{not json")
    storage.map.set("krypta:submitted:form-1", "1")
    storage.map.set("unrelated", "kept")

    sweepExpiredDrafts()

    expect(storage.map.has("krypta:draft:broken")).toBe(false)
    expect(storage.map.get("krypta:submitted:form-1")).toBe("1")
    expect(storage.map.get("unrelated")).toBe("kept")
  })

  test("does nothing when storage throws", () => {
    storage.throwOnGet = true
    storage.map.set("krypta:draft:form-1", "{}")
    expect(() => sweepExpiredDrafts()).not.toThrow()
  })
})
