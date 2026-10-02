"use client"

import { Input } from "@/components/ui/input"
import { useAppLanguage } from "@/lib/app-i18n"
import { formDirection } from "@/lib/form-language"
import { cn } from "@/lib/utils"

/*
 * Email addresses, passwords and one-time or recovery codes are Latin data, so
 * they stay left to right even on an Arabic page. In a right-to-left page the
 * text is aligned to the end so the field still sits against the reading edge,
 * with Arabic placeholders at that edge too.
 */
export function CredentialInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  const rtl = formDirection(useAppLanguage()) === "rtl"
  return <Input dir="ltr" className={cn(rtl && "text-end", className)} {...props} />
}
