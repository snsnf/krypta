const URL_CANDIDATE_PATTERN = /(?:^|[\s"'<(])(https?:\/\/[^\s<>"']+)/g
// The token, then the form and its key fingerprint when the owner's browser
// sent one.
const EXACT_TOKEN_FRAGMENT_PATTERN =
  /^#token=[A-Za-z0-9_-]+(?:&form=[0-9a-f-]{36}&pk=[A-Za-z0-9_-]+)?$/

export function invitationLinkFromContent(content: string): string | null {
  for (const match of content.matchAll(URL_CANDIDATE_PATTERN)) {
    const candidate = match[1]
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.pathname !== "/invitations/accept" ||
      url.search !== "" ||
      !EXACT_TOKEN_FRAGMENT_PATTERN.test(url.hash)
    ) {
      continue
    }

    const entries = [...new URLSearchParams(url.hash.slice(1)).entries()]
    if (
      (entries.length === 1 || entries.length === 3) &&
      entries[0][0] === "token" &&
      entries[0][1].length > 0
    ) {
      return candidate
    }
  }
  return null
}
