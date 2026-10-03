"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { getFontCssUrl } from "@/lib/form-theme"
import type { FontCatalogEntry } from "@/lib/fonts"
import { loadFontCatalog } from "@/lib/font-catalog-client"
import { cn } from "@/lib/utils"
import { useAppT } from "@/lib/app-i18n"

interface FontPickerProps {
  value: string
  onChange: (family: string) => void
  ariaLabel: string
}

type FontStatus = "idle" | "loading" | "ready" | "error"

export function FontPicker({ value, onChange, ariaLabel }: FontPickerProps) {
  const t = useAppT()

  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<FontStatus>("idle")
  const [fonts, setFonts] = useState<FontCatalogEntry[]>([])
  const [search, setSearch] = useState("")
  const [requestedFonts, setRequestedFonts] = useState<Set<string>>(
    () => new Set()
  )
  const hasFetched = useRef(false)
  const previewLinks = useRef(new Map<string, HTMLLinkElement>())

  const loadFonts = useCallback(async () => {
    setStatus("loading")
    try {
      setFonts([...(await loadFontCatalog())])
      setStatus("ready")
    } catch {
      setStatus("error")
    }
  }, [])

  useEffect(() => {
    const links = previewLinks.current
    return () => {
      for (const link of links.values()) link.remove()
    }
  }, [])

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen && !hasFetched.current) {
      hasFetched.current = true
      void loadFonts()
    }
  }

  function retry() {
    setStatus("idle")
    void loadFonts()
  }

  function requestFontPreview(family: string) {
    if (previewLinks.current.has(family)) return
    const href = getFontCssUrl(family, fonts)
    if (!href) return
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = href
    link.dataset.formFontPreview = family
    previewLinks.current.set(family, link)
    document.head.appendChild(link)
    setRequestedFonts((current) => new Set(current).add(family))
  }

  const query = search.trim().toLocaleLowerCase()
  const matches = fonts
    .filter((font) => font.family.toLocaleLowerCase().includes(query))
    .slice(0, 100)

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "w-full justify-between font-normal"
        )}
      >
        <span className="truncate">{value}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={16}
          className="text-muted-foreground"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("appearance.searchFonts")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-72">
            {status === "loading" && (
              <div
                className="space-y-2 p-2"
                aria-label={t("appearance.loadingFonts")}
              >
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} className="h-7 w-full" />
                ))}
              </div>
            )}
            {status === "error" && (
              <div className="space-y-3 p-3 text-center text-sm">
                <p>{t("appearance.fontsFailed")}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={retry}
                >
                  {t("appearance.retry")}
                </Button>
              </div>
            )}
            {status === "ready" && (
              <>
                <CommandEmpty>{t("appearance.noFonts")}</CommandEmpty>
                <CommandGroup>
                  {matches.map((font) => (
                    <CommandItem
                      key={font.family}
                      value={font.family}
                      data-checked={font.family === value}
                      onPointerEnter={() => requestFontPreview(font.family)}
                      onFocus={() => requestFontPreview(font.family)}
                      onSelect={() => {
                        requestFontPreview(font.family)
                        onChange(font.family)
                        setOpen(false)
                      }}
                    >
                      <span
                        style={
                          requestedFonts.has(font.family)
                            ? { fontFamily: `'${font.family}'` }
                            : undefined
                        }
                      >
                        {font.family}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
