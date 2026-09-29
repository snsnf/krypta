import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/lib/question-rating", async () =>
  vi.importActual("../lib/question-rating")
)

import { RatingField } from "./rating-field"

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
})
