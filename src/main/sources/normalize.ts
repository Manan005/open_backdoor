// Stable dedupe key: the bare host, or "name:" + alphanumerics of the name when no website.
export function domainKey(website: string | null, name: string): string {
  if (website) {
    const host = website
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[/?#]/)[0]
      .replace(/^[^@]*@/, '')
      .replace(/:\d*$/, '')
      .toLowerCase()
      .replace(/\.+$/, '')
      .replace(/^www\./, '')
    if (host) return host
  }
  return 'name:' + name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

const AT = String.raw`(?:\s*[\[({]\s*at\s*[\])}]\s*|\s+at\s+)`
const DOT = String.raw`(?:\s*[\[({]\s*dot\s*[\])}]\s*|\s+dot\s+|\.)`
const OBFUSCATED = new RegExp(
  String.raw`([A-Za-z0-9._%+-]+)${AT}([A-Za-z0-9-]+(?:${DOT}[A-Za-z0-9-]+)+)`,
  'gi'
)
const PLAUSIBLE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/i
const DOT_SPLIT = new RegExp(DOT, 'gi')

// Rewrites "x [at] y [dot] com", "x(at)y.com" and "x at y dot com" to x@y.com.
// A match is only rewritten when the result is a plausible address, so prose stays intact.
export function deobfuscateEmails(text: string): string {
  return text.replace(OBFUSCATED, (match, local: string, domain: string) => {
    const addr = `${local}@${domain.replace(DOT_SPLIT, '.')}`
    return PLAUSIBLE.test(addr) ? addr : match
  })
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g

export function extractEmails(text: string): string[] {
  const found = deobfuscateEmails(text).match(EMAIL) ?? []
  return [...new Set(found.map((e) => e.toLowerCase()))]
}
