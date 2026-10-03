import Link from "next/link"
import type { ReactNode } from "react"
import {
  ProseLead,
  ProseList,
  ProsePage,
  ProseSection,
  ProseText,
} from "@/components/prose-page"
import type { Block, ProseDoc } from "@/lib/legal-content/types"

const LINK_CLASS =
  "text-foreground underline underline-offset-4 transition-opacity duration-150 ease-out hover:opacity-70"

/**
 * Fills `{entity}` and `{email}` and turns the two inline marks the documents
 * use into elements: `**bold**` and `[text](/path)`. Nothing else is
 * interpreted, so a document cannot inject markup.
 */
export function renderInline(
  text: string,
  vars: Record<string, string>
): ReactNode[] {
  const filled = text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : whole
  )
  const parts = filled.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(\/[^)\s]*\))/g)
  return parts.map((part, index) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part)
    if (bold) {
      return (
        <strong key={index} className="font-medium text-foreground">
          {bold[1]}
        </strong>
      )
    }
    const link = /^\[([^\]]+)\]\((\/[^)\s]*)\)$/.exec(part)
    if (link) {
      return (
        <Link key={index} href={link[2]} className={LINK_CLASS}>
          {link[1]}
        </Link>
      )
    }
    return part
  })
}

function BlockView({
  block,
  vars,
}: {
  block: Block
  vars: Record<string, string>
}) {
  if (block.kind === "text") {
    return <ProseText>{renderInline(block.text, vars)}</ProseText>
  }
  if (block.kind === "list") {
    return <ProseList items={block.items.map((item) => item)} />
  }
  return (
    <div className="mt-8 flex flex-col gap-8">
      {block.items.map((limit) => (
        <div key={limit.title}>
          <h3 className="font-heading text-lg font-semibold tracking-[-0.01em]">
            {limit.title}
          </h3>
          <p className="mt-3 leading-relaxed text-muted-foreground">
            {limit.body}
          </p>
        </div>
      ))}
    </div>
  )
}

/** One of the long text pages, from its document. */
export function ProseDocument({
  doc,
  vars = {},
  updatedLabel,
}: {
  doc: ProseDoc
  vars?: Record<string, string>
  updatedLabel: string
}) {
  return (
    <ProsePage
      title={doc.title}
      updated={doc.updated}
      updatedLabel={updatedLabel}
    >
      <ProseLead>{renderInline(doc.lead, vars)}</ProseLead>
      {doc.intro.map((text) => (
        <ProseText key={text}>{renderInline(text, vars)}</ProseText>
      ))}
      {doc.sections.map((section) => (
        <ProseSection key={section.title} title={section.title}>
          {section.blocks.map((block, index) => (
            <BlockView key={index} block={block} vars={vars} />
          ))}
        </ProseSection>
      ))}
    </ProsePage>
  )
}
