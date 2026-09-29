import { describe, expect, it } from "vitest"
import type { RatingSettings } from "@krypta/crypto"
import {
  parseRatingAnswer,
  ratingRange,
  ratingValues,
} from "./question-rating"

const withRating = (rating?: unknown) => ({
  rating: rating as RatingSettings | undefined,
})

describe("ratingRange", () => {
  it("defaults a missing setting to five stars", () => {
    expect(ratingRange(withRating())).toEqual({ style: "stars", min: 1, max: 5 })
  })

  it("forces stars to start at 1 and clamps their count to 3..10", () => {
    expect(ratingRange(withRating({ style: "stars", min: 0, max: 1000 }))).toEqual(
      { style: "stars", min: 1, max: 10 }
    )
    expect(ratingRange(withRating({ style: "stars", min: 1, max: 1 }))).toEqual({
      style: "stars",
      min: 1,
      max: 3,
    })
  })

  it("treats an unknown style as stars", () => {
    expect(ratingRange(withRating({ style: "hearts", max: 7 }))).toEqual({
      style: "stars",
      min: 1,
      max: 7,
    })
  })

  it("keeps a scale's 0 start, clamps its end to 2..10 and keeps labels", () => {
    expect(
      ratingRange(
        withRating({
          style: "scale",
          min: 0,
          max: 11,
          minLabel: "Not likely",
          maxLabel: "Very likely",
        })
      )
    ).toEqual({
      style: "scale",
      min: 0,
      max: 10,
      minLabel: "Not likely",
      maxLabel: "Very likely",
    })
  })

  it("drops blank labels and labels on stars", () => {
    expect(
      ratingRange(withRating({ style: "scale", min: 1, max: 5, minLabel: "  " }))
    ).toEqual({ style: "scale", min: 1, max: 5 })
    expect(
      ratingRange(withRating({ style: "stars", min: 1, max: 5, minLabel: "Low" }))
    ).toEqual({ style: "stars", min: 1, max: 5 })
  })

  it("falls back when max is not an integer", () => {
    expect(ratingRange(withRating({ style: "scale", min: 1, max: 4.5 }))).toEqual({
      style: "scale",
      min: 1,
      max: 5,
    })
  })
})

describe("ratingValues", () => {
  it("lists every value from min to max as strings", () => {
    expect(ratingValues(withRating({ style: "scale", min: 0, max: 3 }))).toEqual([
      "0",
      "1",
      "2",
      "3",
    ])
  })
})

describe("parseRatingAnswer", () => {
  const five = withRating({ style: "stars", min: 1, max: 5 })

  it("reads an in-range integer string", () => {
    expect(parseRatingAnswer(five, "4")).toBe(4)
  })

  it("rejects out-of-range, non-integer and non-string answers", () => {
    expect(parseRatingAnswer(five, "9")).toBeNull()
    expect(parseRatingAnswer(five, "0")).toBeNull()
    expect(parseRatingAnswer(five, "2.5")).toBeNull()
    expect(parseRatingAnswer(five, " 3")).toBeNull()
    expect(parseRatingAnswer(five, "")).toBeNull()
    expect(parseRatingAnswer(five, 3)).toBeNull()
    expect(parseRatingAnswer(five, ["3"])).toBeNull()
    expect(parseRatingAnswer(five, undefined)).toBeNull()
  })
})
