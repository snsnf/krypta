import { expect, test } from "@playwright/test"

// Rule 8 makes the cross-origin isolation headers mandatory on every
// response. The API sets its own; these come from next.config.ts.
test("pages carry the cross-origin isolation headers", async ({ request }) => {
  const response = await request.get("/")
  const headers = response.headers()
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin")
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin")
  expect(headers["cross-origin-embedder-policy"]).toBe("require-corp")
})
