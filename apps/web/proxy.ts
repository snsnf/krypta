import { NextResponse, type NextRequest } from "next/server"

import { buildCsp } from "@/lib/csp"

/**
 * Per-request nonce CSP.
 *
 * Next reads the nonce out of the Content-Security-Policy header set on the
 * *request* and stamps it onto the scripts it emits, so the header has to be set
 * in both directions: on the request for Next, and on the response for the
 * browser. The layout also forwards the nonce to next-themes, whose
 * flash-prevention script is inline and would otherwise be blocked.
 */
export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID()
  const csp = buildCsp(nonce)

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  // The layout resolves the app language per route (an untranslated page must
  // not take the browser's preference), and a layout cannot see the path itself.
  requestHeaders.set("x-pathname", request.nextUrl.pathname)
  requestHeaders.set("content-security-policy", csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("content-security-policy", csp)
  return response
}

export const config = {
  // Documents only. Static assets and images are served without a CSP because
  // the policy governs what a document may load, not the assets themselves.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|opengraph-image).*)",
  ],
}
