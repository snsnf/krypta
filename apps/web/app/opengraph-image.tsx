import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ImageResponse } from "next/og"

export const alt = "krypta: forms only you can read."
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

/**
 * Read the mark from the same file the app ships rather than re-typing its
 * path data, so the share card cannot drift from the logo. The source SVG sets
 * no fill, so its shapes inherit the white we set on the root element.
 */
function markDataUri() {
  const svg = readFileSync(
    join(process.cwd(), "public/logo/krypta-icon.svg"),
    "utf8"
  ).replace("<svg", '<svg fill="#ffffff"')
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

/**
 * The same faces the app itself sets: Outfit for the readable half, Geist Mono
 * for the unreadable half, which is meant to be ciphertext and so has to be
 * monospaced.
 *
 * Read from the static Fontsource packages rather than the `next/font` copies
 * the app uses, because this renderer accepts WOFF and not woff2, and only
 * the static packages ship WOFF.
 *
 * Each face is loaded on its own. Read them as one block and a single missing
 * file takes the others down with it, which would silently render the whole
 * card in the fallback serif rather than lose one texture.
 */
type Face = {
  name: string
  data: Buffer
  style: "normal"
  weight: 400 | 600
}

function face(
  pkg: string,
  file: string,
  name: string,
  weight: 400 | 600
): Face | null {
  try {
    return {
      name,
      data: readFileSync(
        join(process.cwd(), `node_modules/@fontsource/${pkg}/files/${file}`)
      ),
      style: "normal",
      weight,
    }
  } catch {
    return null
  }
}

function loadFaces(): Face[] {
  return [
    face("outfit", "outfit-latin-400-normal.woff", "Outfit", 400),
    face("outfit", "outfit-latin-600-normal.woff", "Outfit", 600),
    face("geist-mono", "geist-mono-latin-400-normal.woff", "Geist Mono", 400),
    face("schoolbell", "schoolbell-latin-400-normal.woff", "Schoolbell", 400),
  ].filter((loaded): loaded is Face => loaded !== null)
}

/*
 * Fixed rather than generated. A card that changed every render would defeat
 * caching and make two screenshots of the same commit disagree, and nothing
 * here needs to be unpredictable: it only has to be unreadable.
 *
 * 104 characters a line, which is longer than it looks like it needs to be.
 * Geist Mono advances 0.6em, so at 19px with 0.08em of tracking a line covers
 * about 12.9px a character, and the texture spans the 1200 of the card plus
 * 30 of bleed each side. The 64-character lines this started with reached
 * 827px and stopped in clear space two thirds across, which reads as the
 * field ending rather than continuing past the frame. Shortening these, or
 * changing the size or tracking above without redoing that arithmetic, brings
 * the bare right-hand edge straight back.
 */
const CIPHERTEXT = [
  "K24T3JnDm6bW0zoUqKW0vHjlXHGNM3CV1Lq2mS9PmowfrRjOqifgEjKMIPpmKHYQaQD6RgjPKQC5jniKwBIDB3KwguDBaHn5z2UoT5cP",
  "HtbzUtcCPb8d3wZyoCNXN5AaXuosXXhgnpfGEAXd2chUMdbM5w8YkOm5TlzRIMd5yWktsLpuyVU5WX2OKT7fxttRWOHEZ1kcE72ZmEB2",
  "CzQ0jCugdODO5CxWxNvkqjNyijJPE8DcRUUShQdhlSUmXGVbRhMGFOcGqQGnKRq4oP8paK7P4xaO61Bh3DoPRQDRBpnuqgi8P83tCJAR",
  "k1qh4nO2eJhXzHLKyWW5nHP8irod2dL9Es0oK3bXw8WMxgPzneWdKYnxQXSx89RpZkgeqv3d0k0wJHrgb1kSJWS3hFId5eJZQd8sPWrH",
  "At2mRMgXlfyxtrH4khOd9YxELkoqUIfqrRWUdBmWittQsgM8gBxaB5jfJmp0VZ3v5bHM71OMrzmjrYNBFONNvbwoGwQwybOPcFKafouY",
  "xzExPEvtTREtGzTFGnUvKXPbiJMYE2KiwIy996w20UXJx13qf4TjDG1KJFRHcGrxnQZiUtzbxXKioN2msEb0mo350CVq7jYlKUCqop15",
  "jroQ9cnMMamcLic2bGzTk0XZdpwL8nqQsxWXhStKNYbtt473qwvaGQ2n5ggQaLdFz0dmAcoEY1WWovL8fcoCBsRHSBHwOAMXIIezVVLa",
  "hXdBlPJAbwkERm3BKOx490ZO2KccixOkVN2o2Io3H4WLhVXL2ZY6aHIHbaBGig36lIesgcrMYbep4pudL7nEJNxDb6fJAkrdV2zi71ya",
  "lxSstBfeTofizjlNP6U4YtcNnGFQ5YJvaJ3omvixPbcHU9YpGzYMt0BaSZ8IWOOrlzRUhjsBLtNv6b0TDFwO4DuVBRWQAu4Zj4kS4iro",
  "k46tDU9uLadMX3jXOuYSafI6VrYwiceJRXxNpA9A2t1UZDo4jXg0uX04sr31Stnp28lCBnYR1CDJGpnBt5TL6nqIVBLfY7CEG8hOcxpb",
  "fXc2hAcyQn9xGT6vVwU0d82G1jdaXIGiHI4x65A6XoLldlS4sMy6EK3AQP2yQYDIn03k5ehks1zYC8Zsfk4aPSKsxxTg4YFx27TxMUhU",
  "sCtuD1NdqcjKx2DLN8866rAPQwK9R8pgPTl6zV3ZrolxUwFtVt66l0Q9vxHy3rbxitix7pmzOEBqwUrVN32LDDuWg6wkuatofYNqWdKF",
]

/*
 * One image serves the landing page and every form link, so nothing on it may
 * name a form: a title lives in ciphertext the server cannot read. The card
 * says that instead of claiming it. Everything behind the mark is unreadable;
 * the one legible thing is who this is. It has to survive being scaled into a
 * chat thumbnail, which is why the readable part is three elements and the
 * texture is allowed to collapse into noise.
 */
export default async function OpengraphImage() {
  const faces = loadFaces()
  const brandFace = faces.some((f) => f.name === "Outfit")
  const monoFace = faces.some((f) => f.name === "Geist Mono")
  // The tagline is the one handwritten thing on the card, against a ground of
  // machine ciphertext. That contrast is the product in one image: what a
  // person writes on one side, what the server is left holding on the other.
  // It is also why the handwriting stays on the sentence and never reaches the
  // wordmark, which has to read as a name rather than as a note.
  const writtenFace = faces.some((f) => f.name === "Schoolbell")

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#22432f",
        backgroundImage:
          "radial-gradient(135% 145% at 22% 6%, #35634a 0%, #2b5239 52%, #22432f 100%)",
        fontFamily: brandFace ? "Outfit" : "sans-serif",
        overflow: "hidden",
      }}
    >
      {/*
       * Bled off all four edges, never fitted to the frame, and the line
       * spacing is what carries it to the bottom one. A block that starts and
       * stops inside the card reads as a screenshot of some text, sliced down
       * the middle of a character at whichever edge it happened to reach, and
       * a block that stops short leaves a bare strip that reads as the texture
       * having failed. Running past every edge reads as a field that
       * continues, which is also the honest picture: the ciphertext does not
       * end where the card does.
       *
       * Small and faint on purpose. Larger, the glyphs were legible enough to
       * invite reading and then refuse it. Texture is the job.
       *
       * The opacity cannot be tuned apart from the ground under it. A single
       * faint white over the steep gradient this used to have was invisible on
       * the dark corner and plain on the light one, so the field looked like
       * it stopped halfway across the card. Flattening the ground is what
       * fixed that; raising the opacity alone would only have made the bright
       * half louder.
       */}
      <div
        style={{
          position: "absolute",
          top: -26,
          left: -30,
          right: -30,
          display: "flex",
          flexDirection: "column",
          fontFamily: monoFace ? "Geist Mono" : "monospace",
          fontSize: 19,
          lineHeight: 2.95,
          letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.058)",
          whiteSpace: "nowrap",
        }}
      >
        {CIPHERTEXT.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>

      {/* Quiet ground under the lockup, so the texture never fights it. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          backgroundImage:
            "radial-gradient(56% 66% at 50% 50%, rgba(34,67,47,0.9) 0%, rgba(34,67,47,0.66) 52%, rgba(34,67,47,0) 100%)",
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 46 }}>
          <img src={markDataUri()} alt="" width={140} height={197} />
          <div
            style={{
              fontSize: 124,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              lineHeight: 1,
              color: "#ffffff",
            }}
          >
            krypta
          </div>
        </div>

        <div
          style={{
            // Schoolbell sits small on its body, so it needs more points
            // than the grotesque did to read at the same size on a timeline.
            fontFamily: writtenFace ? "Schoolbell" : undefined,
            fontSize: writtenFace ? 54 : 42,
            fontWeight: 400,
            lineHeight: 1.2,
            marginTop: writtenFace ? 38 : 44,
            color: "rgba(255,255,255,0.9)",
          }}
        >
          Forms only you can read.
        </div>
      </div>
    </div>,
    { ...size, ...(faces.length > 0 ? { fonts: faces } : {}) }
  )
}
