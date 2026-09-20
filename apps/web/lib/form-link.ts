/**
 * One named value from a link fragment such as `#token=...&key=...`, decoded,
 * or null when it is absent.
 *
 * A value that is not valid percent-encoding is also null rather than a
 * thrown URIError. The fill and edit pages decode inside an effect nobody
 * awaits, so a throw there left the page on its loading spinner forever; a
 * value that cannot be decoded is exactly as unusable as a missing one, and
 * both pages already say "This link is incomplete" for that.
 *
 * `name` is always a literal chosen by the caller, never user input, so it is
 * safe to place in the pattern.
 */
export function readFragmentParam(hash: string, name: string): string | null {
  const match = new RegExp(`(?:^#|&)${name}=([^&]+)`).exec(hash)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}
