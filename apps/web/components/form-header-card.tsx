"use client"

import { useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useFormT } from "@/lib/form-i18n"

interface FormHeaderCardProps {
  /** Object URL for the decrypted header image, or null when there is none. */
  headerImageUrl?: string | null
  title: string
  onTitleChange?: (title: string) => void
  titleInputClassName?: string
}

function HeaderImage({ src }: { src: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const t = useFormT()

  return (
    <div className="relative aspect-[4/1] overflow-hidden bg-muted">
      {status === "loading" && (
        <Skeleton className="absolute inset-0 size-full rounded-none" />
      )}
      {status !== "error" && (
        // The src is an object URL for bytes decrypted in the page, which next/image cannot optimise.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className={cn(
            "h-full w-full object-cover",
            status === "loading" && "opacity-0"
          )}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
        />
      )}
      {status === "error" && (
        <p
          role="status"
          className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-muted-foreground"
        >
          {t("headerImageFailed")}
        </p>
      )}
    </div>
  )
}

export function FormHeaderCard({
  title,
  onTitleChange,
  titleInputClassName,
  headerImageUrl = null,
}: FormHeaderCardProps) {
  const t = useFormT()
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/*
       * The caller passes a resolved object URL rather than the card fetching
       * anything: the bytes arrive encrypted and are opened with the schema
       * key, which the card has no business holding.
       */}
      {headerImageUrl ? (
        <HeaderImage key={headerImageUrl} src={headerImageUrl} />
      ) : (
        <div className="form-theme-accent-bg h-1" />
      )}
      <div className="p-5">
        {onTitleChange ? (
          <input
            dir="auto"
            placeholder={t("untitled")}
            aria-label={t("formTitle")}
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            className={cn(
              "form-theme-header w-full border-0 border-b border-transparent bg-transparent px-0 py-1 font-medium transition-colors duration-150 ease-out outline-none placeholder:text-muted-foreground/60 focus:border-border",
              titleInputClassName
            )}
          />
        ) : (
          <h2 dir="auto" className="form-theme-header font-medium">
            {title || t("untitled")}
          </h2>
        )}
      </div>
    </div>
  )
}
