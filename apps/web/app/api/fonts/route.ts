import { fontCatalog } from "@/lib/fonts"

/** The self-hosted font catalogue. Static data, cached hard. */
export function GET() {
  return Response.json(fontCatalog, {
    headers: {
      "Cache-Control":
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
    },
  })
}
