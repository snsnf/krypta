import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-i18n", async () => vi.importActual("../lib/form-i18n"))
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/lib/question-rating", async () =>
  vi.importActual("../lib/question-rating")
)

import { RatingField } from "./rating-field"
import { FormLanguageContext } from "../lib/form-i18n"

describe("RatingField preview", () => {
  it("is hidden from assistive technology and cannot be focused", () => {
    const markup = renderToStaticMarkup(
      <RatingField
        question={{ id: "r", type: "rating", label: "x", required: true }}
        value={undefined}
        preview
      />
    )
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).not.toContain('role="radiogroup"')
    expect(markup).toContain('tabindex="-1"')
    expect(markup).not.toContain('required=""')
  })

  it("names each value in the form's language for an Arabic form", () => {
    const scale = renderToStaticMarkup(
      <FormLanguageContext value="ar">
        <RatingField
          question={{ id: "s", type: "rating", label: "x", rating: { style: "scale", min: 0, max: 10, minLabel: "ضعيف" } }}
          value={undefined}
        />
      </FormLanguageContext>
    )
    expect(scale).toContain('aria-label="0، ضعيف، على مقياس من 0 إلى 10"')
    expect(scale).toContain('aria-label="5، على مقياس من 0 إلى 10"')
    const stars = renderToStaticMarkup(
      <FormLanguageContext value="ar">
        <RatingField question={{ id: "r", type: "rating", label: "x" }} value={undefined} />
      </FormLanguageContext>
    )
    expect(stars).toContain('aria-label="التقييم 4 من 5"')
  })
})
