/**
 * Content-Security-Policy construction, kept out of proxy.ts so it can be
 * unit tested in both dev and production modes without standing up a request.
 */

/**
 * The origin the browser will call for the API, or an empty string when there
 * is no separate one to name.
 *
 * Production serves the API under `/api` on the same hostname, so the base is
 * the relative `/api/v1` and `connect-src 'self'` already covers it. That
 * relative form is what makes one web image usable on any domain: an absolute
 * base is compiled into the browser bundle, so a prebuilt image would send
 * every self-hoster's browser to whichever host built it.
 *
 * Development runs the two on different ports, so the base is absolute there
 * and its origin has to be named. A relative base must return "" rather than
 * fall through to the catch: `new URL()` throws on a path, and quietly
 * substituting localhost would put a wrong origin in a real deployment's
 * policy.
 */
export function apiOrigin(
  base = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080/api/v1"
): string {
  if (base.startsWith("/")) return ""
  try {
    return new URL(base).origin
  } catch {
    return "http://localhost:8080"
  }
}

export function buildCsp(
  nonce: string,
  isDev = process.env.NODE_ENV !== "production"
): string {
  // libsodium compiles WebAssembly, so wasm-unsafe-eval is not optional: without
  // it every derive/seal call fails and the app cannot function. It permits wasm
  // compilation only, not eval() of strings.
  //
  // strict-dynamic lets the scripts Next injects at runtime inherit trust from
  // the nonced bootstrap, which is what makes dropping 'unsafe-inline' viable.
  // Browsers honouring strict-dynamic ignore the 'self' fallback beside it.
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    "'wasm-unsafe-eval'",
    // Dev only: the HMR client and React refresh runtime need eval.
    isDev ? "'unsafe-eval'" : null,
  ]
    .filter(Boolean)
    .join(" ")

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Next and next/font inject inline <style>, which cannot reliably carry a
    // nonce. Inline style is a far smaller risk than inline script: it cannot
    // read the master key or make requests.
    "style-src 'self' 'unsafe-inline'",
    // Every font, including a form's chosen family, is served from this
    // origin (see scripts/build-fonts.ts), so no font host is listed.
    "font-src 'self' data:",
    // blob: is for a form's header image, which arrives encrypted and is
    // decrypted in the page before it can be shown, so it is rendered from an
    // object URL rather than fetched by the browser directly. No remote host
    // is allowed: an image from one would tell that host who opened the page.
    "img-src 'self' data: blob:",
    `connect-src 'self' ${apiOrigin()}`.trimEnd(),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    /*
     * Production only. This rewrites every http subresource to https, and it
     * exempts localhost, so on a dev machine it is invisible right up until
     * the API base is anything else: point it at a LAN address to open the app
     * from a phone and the browser silently upgrades the API origin to a
     * scheme no dev server answers, then blocks the request for no longer
     * matching connect-src. The failure reads as a CSP bug in the app rather
     * than as a scheme rewrite, which is what makes it worth gating.
     *
     * Production is served over https, where the directive costs nothing and
     * is the defence it was added for.
     */
    isDev ? null : "upgrade-insecure-requests",
  ]
    .filter(Boolean)
    .join("; ")
}
