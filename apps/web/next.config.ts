import type { NextConfig } from "next"

// The Content-Security-Policy is deliberately absent here and lives in
// middleware.ts instead: it needs a fresh nonce per request, which a static
// config header cannot provide. Setting it in both places would send two CSP
// headers, and the browser enforces the intersection, so the nonce policy would
// be silently narrowed by the static one.
/*
 * Hosts allowed to pull /_next/static and /_next/hmr in development. Next
 * blocks any origin but localhost by default, and the failure is quiet in a
 * way that wastes time: the server still returns the SSR HTML, so the page
 * renders and then nothing hydrates. Dynamic imports never resolve, scroll
 * reveals never fire, and the result reads as a broken page rather than as
 * blocked assets.
 *
 * Env-driven rather than a committed list, because the value is a machine's
 * current LAN address and changes with the network. Empty by default, and the
 * key has no effect on a production build.
 *
 *   ALLOWED_DEV_ORIGINS=192.168.1.50 bun run dev
 */
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

/*
 * Development only: when set, this server proxies /api/v1 to the API so that
 * one HTTPS tunnel in front of port 3000 serves both apps from one origin.
 * That is what lets login work from a phone: the session cookie is same-site
 * only, so a second tunnel for the API would never receive it. Unset (the
 * default) the browser talks to NEXT_PUBLIC_API_BASE directly, as always.
 * Never set in production, where Traefik does this routing.
 *
 *   DEV_API_PROXY_TARGET=http://localhost:8080
 */
const devApiProxyTarget = process.env.DEV_API_PROXY_TARGET

const nextConfig: NextConfig = {
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  ...(devApiProxyTarget
    ? {
        async rewrites() {
          return [
            {
              source: "/api/v1/:path*",
              destination: `${devApiProxyTarget}/api/v1/:path*`,
            },
          ]
        },
      }
    : {}),
  async headers() {
    return [
      {
        // Generated font files and stylesheets; names change only when the
        // Fontsource packages do, and a day of caching bounds the damage.
        source: "/fonts/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), camera=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          // The same isolation set the API sends. Nothing on a page loads a
          // cross-origin subresource, so require-corp costs nothing, and
          // same-origin opener policy keeps another tab from holding a
          // reference to a window that has an unlocked vault in memory.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ]
  },
}

export default nextConfig
