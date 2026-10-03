"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  Briefcase01Icon,
  Calendar03Icon,
  Message01Icon,
  PlusSignIcon,
  ShieldUserIcon,
  StarIcon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { useAppLanguage, useAppT } from "@/lib/app-i18n"
import {
  FORM_TEMPLATES,
  templateCard,
  type FormTemplate,
} from "@/lib/form-templates"

// Presentation only, so it lives here and lib/form-templates.ts stays free of
// UI imports.
const TEMPLATE_ICONS: Record<string, typeof StarIcon> = {
  "event-feedback": StarIcon,
  rsvp: Calendar03Icon,
  "job-application": Briefcase01Icon,
  contact: Message01Icon,
  "anonymous-report": ShieldUserIcon,
}

const CARD_CLASSES =
  "flex h-full w-full flex-col items-start gap-2 rounded-lg border bg-card p-4 text-start transition-colors duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/50"

export function TemplateGallery({
  onPick,
}: {
  /** A template, or null for a blank form. */
  onPick: (template: FormTemplate | null) => void
}) {
  const t = useAppT()
  const language = useAppLanguage()
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
        {t("templates.title")}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("templates.subtitle")}
      </p>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li>
          <button
            type="button"
            onClick={() => onPick(null)}
            className={cn(CARD_CLASSES, "border-dashed border-border")}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={20} aria-hidden="true" />
            <span className="font-medium">{t("templates.blank")}</span>
            <span className="text-sm text-muted-foreground">
              {t("templates.blankDescription")}
            </span>
          </button>
        </li>
        {FORM_TEMPLATES.map((template) => {
          const card = templateCard(template, language)
          return (
            <li key={template.id}>
              <button
                type="button"
                onClick={() => onPick(template)}
                className={cn(CARD_CLASSES, "border-border")}
              >
                <HugeiconsIcon
                  icon={TEMPLATE_ICONS[template.id] ?? StarIcon}
                  size={20}
                  aria-hidden="true"
                />
                <span className="font-medium">{card.name}</span>
                <span className="text-sm text-muted-foreground">
                  {card.description}
                </span>
                <span className="mt-auto pt-1 text-xs text-muted-foreground">
                  {t("templates.questionCount", {
                    count: template.questions.length,
                  })}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
