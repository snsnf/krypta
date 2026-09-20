import type { MetadataRoute } from "next"

/*
 * Read at request time, not build time.
 *
 * SITE_URL carries no NEXT_PUBLIC_ prefix on purpose: nothing in the browser
 * bundle needs it, and a NEXT_PUBLIC_ value is compiled in, which would bake
 * whichever hostname built the image into every copy of it. Server-side reads
 * of process.env happen at runtime, so one published image serves any domain.
 *
 * `force-dynamic` is the other half. This route is otherwise prerendered at
 * build, which would freeze the build machine's value into the output and
 * defeat the runtime read. Rendering it per request costs almost nothing for
 * a file this small.
 */
export const dynamic = "force-dynamic"

function siteUrl(): string {
  return process.env.SITE_URL ?? "http://localhost:3000"
}

/**
 * Only the landing page, the text pages and the two entry pages are for
 * search engines. Every other route is either behind a session or a public
 * form, and a form URL in a search result would announce that the form exists
 * and hand out its link.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/security", "/privacy", "/terms", "/login", "/signup"],
      disallow: [
        "/dashboard",
        "/admin",
        "/f/",
        "/unlock",
        "/recover",
        "/invitations",
        "/api/",
      ],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  }
}
