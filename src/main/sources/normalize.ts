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

const BRACKET_AT = String.raw`\s*[\[({]\s*at\s*[\])}]\s*`
const BRACKET_DOT = String.raw`\s*[\[({]\s*dot\s*[\])}]\s*`
const WORD_DOT = String.raw`(?:${BRACKET_DOT}|\s+dot\s+)`
const ANY_DOT = String.raw`(?:${BRACKET_DOT}|\s+dot\s+|\.)`
const LOCAL = String.raw`([A-Za-z0-9._%+-]+)`
const label = String.raw`[A-Za-z0-9-]+`
// "x [at] y.com", "x(at)y [dot] com": a bracketed at may pair with any dot form.
const BRACKETED = new RegExp(`${LOCAL}${BRACKET_AT}(${label}(?:${ANY_DOT}${label})+)`, 'gi')
// "x at y dot com": a bare word "at" is only trusted with word-form dots, never a literal ".",
// otherwise "contact us at acme.com" would turn into the invented address us@acme.com.
const BARE = new RegExp(String.raw`${LOCAL}\s+at\s+(${label}(?:${WORD_DOT}${label})+)`, 'gi')
const PLAUSIBLE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/i
const DOT_SPLIT = new RegExp(ANY_DOT, 'gi')

// Rewrites "x [at] y [dot] com", "x(at)y.com" and "x at y dot com" to x@y.com.
// A match is only rewritten when the result is a plausible address, so prose stays intact.
export function deobfuscateEmails(text: string): string {
  const fix = (match: string, local: string, domain: string): string => {
    const addr = `${local}@${domain.replace(DOT_SPLIT, '.')}`
    return PLAUSIBLE.test(addr) ? addr : match
  }
  return text.replace(BRACKETED, fix).replace(BARE, fix)
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g

export function extractEmails(text: string): string[] {
  const found = deobfuscateEmails(text).match(EMAIL) ?? []
  return [...new Set(found.map((e) => e.toLowerCase()))]
}
