import { describe, expect, it } from "vitest"
import { readFragmentParam } from "./form-link"

describe("readFragmentParam", () => {
  it("reads a value from a form link", () => {
    expect(readFragmentParam("#key=abc", "key")).toBe("abc")
  })

  it("reads each value from an edit link, in either order, decoded", () => {
    expect(readFragmentParam("#token=t%2B1&key=k", "token")).toBe("t+1")
    expect(readFragmentParam("#token=t%2B1&key=k", "key")).toBe("k")
    expect(readFragmentParam("#key=k&token=t", "token")).toBe("t")
  })

  it("is null when the value is missing", () => {
    expect(readFragmentParam("", "key")).toBeNull()
    expect(readFragmentParam("#token=t", "key")).toBeNull()
  })

  it("does not match a longer name that ends in the one asked for", () => {
    expect(readFragmentParam("#monkey=x", "key")).toBeNull()
  })

  it("is null, not a throw, when the value is not valid percent-encoding", () => {
    expect(readFragmentParam("#key=%E0%A4%A", "key")).toBeNull()
  })
})
