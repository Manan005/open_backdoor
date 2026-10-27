import { z } from 'zod'
import type { Contact, ContactKind, FoundEmail } from '../../shared/types'
import type { Fetcher } from '../net/http'
import { deobfuscateEmails, extractEmails } from '../sources/normalize'
import { generateStructured, LlmOutputError, LlmUnavailableError, type LlmClient } from '../llm/llm'

export const GENERIC_LOCALPARTS = [
  'info',
  'support',
  'sales',
  'hello',
  'contact',
  'noreply',
  'no-reply',
  'admin',
  'help',
  'press',
  'media',
  'marketing',
  'billing',
  'privacy',
  'legal',
  'security',
  'team',
  'office',
  'partners'
]
export const HIRING_LOCALPARTS = [
  'jobs',
  'careers',
  'hiring',
  'talent',
  'recruiting',
  'recruitment',
  'hr',
  'work',
  'joinus',
  'join',
  'apply'
]
// Plain-word de-obfuscation ("we are at acme dot com") can yield these as a local part;
// such an address is only trusted when it appears literally in the page.
export const COMMON_WORD_LOCALPARTS = [
  'are',
  'is',
  'we',
  'us',
  'me',
  'you',
  'them',
  'it',
  'he',
  'she',
  'they',
  'am',
  'be',
  'was',
  'were',
  'our',
  'your'
]

const PAGE_PATHS = [
  '/',
  '/about',
  '/about-us',
  '/team',
  '/company',
  '/careers',
  '/jobs',
  '/contact'
]
const PAGE_TIMEOUT_MS = 10_000
const WINDOW = 300

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, '')

// Same-host company pages, in path order. Any error (including a blocked host) skips that page.
export async function fetchCompanyPages(
  fetch: Fetcher,
  website: string
): Promise<{ url: string; html: string }[]> {
  let base: URL
  try {
    base = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`)
  } catch {
    return []
  }
  const host = bareHost(base.hostname)
  const results = await Promise.all(
    PAGE_PATHS.map(async (path) => {
      try {
        const res = await fetch(new URL(path, base.origin).toString(), {
          timeoutMs: PAGE_TIMEOUT_MS
        })
        if (res.status < 200 || res.status >= 300) return null
        if (bareHost(new URL(res.url).hostname) !== host) return null
        return { url: res.url, html: res.text }
      } catch {
        return null
      }
    })
  )
  const seen = new Set<string>()
  const pages: { url: string; html: string }[] = []
  for (const r of results) {
    if (!r || seen.has(r.url)) continue
    seen.add(r.url)
    pages.push(r)
  }
  return pages
}

// mailto: targets are decoded and surfaced as text so they get the same context window as visible addresses.
function mailtoTarget(raw: string): string {
  let v = raw.replace(/&amp;/gi, '&').split('?')[0]
  try {
    v = decodeURIComponent(v)
  } catch {
    /* keep the raw value */
  }
  return v.replace(/,/g, ' ')
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<a\b[^>]*?href\s*=\s*["']?\s*mailto:([^"'>\s]+)[^>]*>/gi,
      (_m, v: string) => ` ${mailtoTarget(v)} `
    )
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*64;|&commat;/gi, '@')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
}

// Local part lowercased, ignoring a +tag suffix.
const localOf = (email: string): string =>
  email.slice(0, email.lastIndexOf('@')).toLowerCase().split('+')[0]
const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

interface Found {
  email: string
  sourceUrl: string
  context: string
  fromSource: boolean
}

const linkSchema = z.object({
  people: z.array(
    z.object({ email: z.string(), name: z.string().nullable(), role: z.string().nullable() })
  )
})

// Only addresses published in the given pages or source emails are ever returned; nothing is guessed.
export async function findContacts(
  llm: LlmClient,
  input: {
    companyDomain: string | null
    sourceEmails: FoundEmail[]
    pages: { url: string; html: string }[]
  }
): Promise<Contact[]> {
  const found = new Map<string, Found>()
  const add = (f: Found): void => {
    const prev = found.get(f.email)
    if (!prev) found.set(f.email, f)
    else if (f.fromSource) prev.fromSource = true // also published by the source: keep the first sourceUrl
  }

  for (const page of input.pages) {
    const raw = htmlToText(page.html)
    const rawLower = raw.toLowerCase()
    const text = deobfuscateEmails(raw)
    const lowerText = text.toLowerCase()
    for (const email of extractEmails(raw)) {
      if (COMMON_WORD_LOCALPARTS.includes(localOf(email)) && !rawLower.includes(email)) continue
      const idx = lowerText.indexOf(email)
      const context =
        idx >= 0 ? text.slice(Math.max(0, idx - WINDOW), idx + email.length + WINDOW) : ''
      add({ email, sourceUrl: page.url, context, fromSource: false })
    }
  }
  for (const s of input.sourceEmails) {
    for (const email of extractEmails(s.email))
      add({ email, sourceUrl: s.url, context: '', fromSource: true })
  }

  const cd = input.companyDomain?.toLowerCase().replace(/^www\./, '') ?? null
  const kept = [...found.values()].filter((f) => {
    const d = domainOf(f.email)
    const onDomain = cd !== null && (d === cd || d.endsWith('.' + cd))
    if (!onDomain && !f.fromSource) return false
    return !GENERIC_LOCALPARTS.includes(localOf(f.email))
  })
  if (kept.length === 0) return []

  const kindOf = (email: string): ContactKind =>
    HIRING_LOCALPARTS.includes(localOf(email)) ? 'hiring_inbox' : 'person'
  const people = kept.filter((f) => kindOf(f.email) === 'person')

  const links = new Map<string, { name: string | null; role: string | null }>()
  if (people.length > 0) {
    const prompt =
      'For each email address below, say whose address it is and their role, using only the surrounding page text. ' +
      'Use null when the text does not say. Do not add addresses that are not listed.\n\n' +
      people.map((p) => `Address: ${p.email}\nText: ${p.context || '(none)'}`).join('\n\n')
    try {
      const res = await generateStructured(llm, linkSchema, {
        system:
          'You link published email addresses to the person named near them. Reply only with JSON.',
        prompt
      })
      for (const p of res.people) {
        const email = p.email.trim().toLowerCase()
        // an address the model returns that was not found in the text is discarded
        if (people.some((x) => x.email === email))
          links.set(email, { name: p.name || null, role: p.role || null })
      }
    } catch (e) {
      // unlinked contacts are still valid; only the name and role are lost
      if (!(e instanceof LlmOutputError || e instanceof LlmUnavailableError)) throw e
    }
  }

  const rank: Record<ContactKind, number> = { founder: 0, person: 1, hiring_inbox: 2 }
  return kept
    .map((f): Contact => {
      const kind = kindOf(f.email)
      const link = kind === 'person' ? links.get(f.email) : undefined
      const role = link?.role ?? null
      return {
        email: f.email,
        name: link?.name ?? null,
        role,
        kind:
          kind === 'person' && role && /founder|ceo|cto|co-founder/i.test(role) ? 'founder' : kind,
        sourceUrl: f.sourceUrl
      }
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind])
}
