"use client"

import dynamic from "next/dynamic"

// Recharts is substantial and only the Responses tab needs it, so it is
// loaded on demand rather than added to the dashboard's initial bundle.
export const ResponseSummaryLazy = dynamic(
  () =>
    import("@/components/responses/response-summary").then(
      (mod) => mod.ResponseSummary
    ),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-4">
        <div className="h-40 rounded-lg border border-border bg-card" />
        <div className="h-40 rounded-lg border border-border bg-card" />
      </div>
    ),
  }
)
