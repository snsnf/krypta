// Turns the Fontsource packages listed in fonts/families.json into the font
// catalogue the picker reads, one stylesheet per family, and the woff2 files
// behind them, all served from this origin under /fonts/.
//
// A respondent's browser must never contact a third party to render a form,
// so the catalogue and the files are static output of this script, generated
// before `next build` and `next dev` (the prebuild and predev scripts).
//
// Outputs:
//   lib/font-catalog.json   committed; the picker's list and the source of ids
//   public/fonts/<id>.css   generated, git-ignored; @font-face rules
//   public/fonts/<id>/      generated, git-ignored; the woff2 files
//   public/fonts/LICENSES.txt  every family's license and attribution
//
// Adding a family: add its Fontsource id to fonts/families.json and the
// matching package to package.json (@fontsource-variable/<id> when Fontsource
// marks it variable, @fontsource/<id> otherwise), then run `bun run fonts:build`.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const outDir = join(root, "public", "fonts")

interface Metadata {
  id: string
  family: string
  category: string
  weights: number[]
  styles: string[]
  license?: { type?: string; attribution?: string; url?: string }
}

interface CatalogEntry {
  id: string
  family: string
  category: string
  /** Variant names as the picker shows them: "regular", "italic", "700", "700italic". */
  variants: string[]
}

function locate(id: string): { dir: string; variable: boolean } {
  for (const scope of ["@fontsource-variable", "@fontsource"]) {
    const dir = join(root, "node_modules", scope, id)
    if (existsSync(join(dir, "metadata.json"))) {
      return { dir, variable: scope === "@fontsource-variable" }
    }
  }
  throw new Error(
    `fonts: no Fontsource package installed for "${id}". Add @fontsource-variable/${id} or @fontsource/${id} to package.json.`
  )
}

function stylesheetsFor(
  dir: string,
  variable: boolean,
  metadata: Metadata
): string[] {
  const italic = metadata.styles.includes("italic")
  const candidates: string[] = []
  if (variable) {
    // The weight axis when the font has one; otherwise the fixed instance.
    const axis = existsSync(join(dir, "wght.css")) ? "wght" : "standard"
    candidates.push(`${axis}.css`)
    if (italic) candidates.push(`${axis}-italic.css`)
  } else {
    for (const weight of metadata.weights) {
      candidates.push(`${weight}.css`)
      if (italic) candidates.push(`${weight}-italic.css`)
    }
  }
  return candidates.filter((name) => existsSync(join(dir, name)))
}

function variantName(weight: number, style: string): string {
  const suffix = style === "italic" ? "italic" : ""
  if (weight === 400) return suffix || "regular"
  return `${weight}${suffix}`
}

const ids: string[] = JSON.parse(
  readFileSync(join(root, "fonts", "families.json"), "utf8")
)
const seen = new Set<string>()
for (const id of ids) {
  if (seen.has(id)) throw new Error(`fonts: "${id}" is listed twice`)
  seen.add(id)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const catalog: CatalogEntry[] = []
const licenses: string[] = []
let fileCount = 0
let byteCount = 0

for (const id of ids) {
  const { dir, variable } = locate(id)
  const metadata = JSON.parse(
    readFileSync(join(dir, "metadata.json"), "utf8")
  ) as Metadata
  const sheets = stylesheetsFor(dir, variable, metadata)
  if (sheets.length === 0)
    throw new Error(`fonts: no stylesheet found for ${id}`)

  let css = ""
  for (const sheet of sheets)
    css += readFileSync(join(dir, sheet), "utf8") + "\n"
  // Variable packages name the face "<Family> Variable"; themes store the
  // plain family, and the two must agree for the font to apply.
  css = css.replaceAll(`'${metadata.family} Variable'`, `'${metadata.family}'`)
  // woff2 only. Every browser this app supports has it, and the woff
  // fallback would double the files copied.
  css = css.replaceAll(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, "")
  css = css.replaceAll("url(./files/", `url(/fonts/${id}/`)

  mkdirSync(join(outDir, id), { recursive: true })
  const referenced = new Set(
    [...css.matchAll(new RegExp(`/fonts/${id}/([^)]+\\.woff2)`, "g"))].map(
      (match) => match[1]
    )
  )
  for (const file of referenced) {
    const source = join(dir, "files", file)
    copyFileSync(source, join(outDir, id, file))
    fileCount += 1
    byteCount += readFileSync(source).byteLength
  }
  writeFileSync(join(outDir, `${id}.css`), css)

  // Listed from the faces this stylesheet actually declares, not from the
  // package's weights times its styles: a static package can list a weight
  // and an italic style without shipping that weight in italic, and a variant
  // the picker offers must have a file behind it.
  const served = [
    ...css.matchAll(/@font-face\s*{([^}]*)}/g),
  ].map((face) => {
    const style = /font-style:\s*(italic|normal)/.exec(face[1])?.[1] ?? "normal"
    const [low, high] = (/font-weight:\s*([\d ]+);/.exec(face[1])?.[1] ?? "400")
      .trim()
      .split(/\s+/)
      .map(Number)
    return { style, low, high: high ?? low }
  })
  const variants: string[] = []
  for (const weight of metadata.weights) {
    for (const style of metadata.styles) {
      const shipped = served.some(
        (face) => face.style === style && weight >= face.low && weight <= face.high
      )
      if (shipped) variants.push(variantName(weight, style))
    }
  }
  catalog.push({
    id,
    family: metadata.family,
    category: metadata.category,
    variants,
  })
  licenses.push(
    `${metadata.family} (${id}): ${metadata.license?.type ?? "see package"}\n  ${metadata.license?.attribution ?? ""}`.trimEnd()
  )
}

catalog.sort((a, b) => a.family.localeCompare(b.family))
writeFileSync(
  join(root, "lib", "font-catalog.json"),
  JSON.stringify({ fonts: catalog }, null, 2) + "\n"
)
writeFileSync(
  join(outDir, "LICENSES.txt"),
  "Fonts served from this site, their licenses and attributions.\nBuilt from Fontsource packages of the Google Fonts collection.\n\n" +
    licenses.join("\n\n") +
    "\n"
)

console.log(
  `fonts: ${catalog.length} families, ${fileCount} files, ${(byteCount / 1024 / 1024).toFixed(1)} MB -> public/fonts`
)
