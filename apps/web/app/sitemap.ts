import type { MetadataRoute } from "next"
import { legalIdentity } from "@/lib/legal"

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

/*
 * Bump this when the copy on an indexable page changes. A fixed date is
 * deliberate: `new Date()` here would tell every crawler the pages changed
 * today, every day, which is a signal that means nothing. A date that goes
 * stale only understates how fresh the pages are, which is the safe direction.
 */
const LAST_MODIFIED = new Date("2026-09-17")

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl(),
      lastModified: LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${siteUrl()}/security`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    // Listed only when this instance serves them. An instance that has named
    // no operator returns 404 for both, and a sitemap that points a crawler at
    // a 404 is worse than one that leaves the page out.
    ...(legalIdentity() === null
      ? []
      : [
          {
            url: `${siteUrl()}/privacy`,
            lastModified: LAST_MODIFIED,
            changeFrequency: "yearly" as const,
            priority: 0.3,
          },
          {
            url: `${siteUrl()}/terms`,
            lastModified: LAST_MODIFIED,
            changeFrequency: "yearly" as const,
            priority: 0.3,
          },
        ]),
    {
      url: `${siteUrl()}/signup`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${siteUrl()}/login`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ]
}
