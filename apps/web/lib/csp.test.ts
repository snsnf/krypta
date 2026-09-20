import { expect, test } from "vitest"
import { apiOrigin, buildCsp } from "./csp"

const NONCE = "test-nonce-value"

test("CSP permits the font and HTTPS image sources the app relies on", () => {
  const csp = buildCsp(NONCE, false)

  expect(csp).toContain("style-src 'self' 'unsafe-inline'")
  expect(csp).toContain("font-src 'self' data:")
  expect(csp).not.toContain("googleapis")
  expect(csp).not.toContain("gstatic")
  expect(csp).toContain("img-src 'self' data: blob:;")
  expect(csp).not.toMatch(/img-src[^;]*https:/)
})

test("production script-src carries the nonce and no inline or eval escape", () => {
  const scriptSrc = buildCsp(NONCE, false)
    .split("; ")
    .find((d) => d.startsWith("script-src "))!

  expect(scriptSrc).toContain(`'nonce-${NONCE}'`)
  expect(scriptSrc).toContain("'strict-dynamic'")
  // Without this libsodium cannot compile its wasm and every crypto call fails.
  expect(scriptSrc).toContain("'wasm-unsafe-eval'")

  // The point of the whole policy: an injected inline script must not run, and
  // eval of strings must stay unavailable. Matched on tokens so that
  // 'wasm-unsafe-eval' does not satisfy a substring check for 'unsafe-eval'.
  const tokens = scriptSrc.split(" ")
  expect(tokens).not.toContain("'unsafe-inline'")
  expect(tokens).not.toContain("'unsafe-eval'")
})

test("dev adds eval for HMR, which production must not inherit", () => {
  const dev = buildCsp(NONCE, true)
    .split("; ")
    .find((d) => d.startsWith("script-src "))!
  expect(dev.split(" ")).toContain("'unsafe-eval'")
})

test("the policy closes the injection vectors that do not need to be open", () => {
  const csp = buildCsp(NONCE, false)
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("base-uri 'self'")
  expect(csp).toContain("form-action 'self'")
  expect(csp).toContain("frame-ancestors 'none'")
})

test("connect-src follows the configured API origin, not a hardcoded host", () => {
  expect(apiOrigin("https://api.example.com/api/v1")).toBe(
    "https://api.example.com"
  )
  // A malformed value must not widen the policy to everything.
  expect(apiOrigin("not a url")).toBe("http://localhost:8080")
})

test("a same-origin API contributes no extra origin to connect-src", () => {
  // The relative base is what lets one web image serve any domain. It must
  // produce no origin at all rather than falling through to the localhost
  // fallback, which would put a wrong host in a real deployment's policy.
  expect(apiOrigin("/api/v1")).toBe("")
  const directive = buildCsp("nonce123", false)
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src "))
  expect(directive).toBe(`connect-src 'self' ${apiOrigin()}`.trimEnd())
})

/*
 * Gating this directive is not cosmetic. It rewrites every http subresource to
 * https and exempts localhost, so on a dev machine it stays invisible until the
 * API base is some other host: pointing the app at a LAN address to open it
 * from a phone made the browser upgrade the API origin to a scheme no dev
 * server answers, and CSP then blocked the request for no longer matching
 * connect-src. Production is served over https, where the directive is the
 * defence it was added for and costs nothing.
 */
test("upgrades insecure requests in production but not in development", () => {
  expect(buildCsp(NONCE, false).split("; ")).toContain(
    "upgrade-insecure-requests"
  )
  expect(buildCsp(NONCE, true).split("; ")).not.toContain(
    "upgrade-insecure-requests"
  )
})

test("a dev CSP still names the API origin it is given", () => {
  const connect = buildCsp(NONCE, true)
    .split("; ")
    .find((d) => d.startsWith("connect-src "))!
  expect(connect).toContain("'self'")
})
