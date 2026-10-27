import type { Candidate } from '../../shared/types'
import { extractEmails } from './normalize'
import type { Source } from './types'

const SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5'

interface Hit { objectID: string; title?: string; created_at?: string }
interface Comment { id: number; text?: string | null; created_at?: string | null }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (dec) return String.fromCodePoint(parseInt(dec, 10))
    return ENTITIES[String(name).toLowerCase()] ?? m
  })
}

// HN comment HTML to plain text: links become their href, <p> becomes a newline.
function toPlain(html: string): string {
  const withLinks = html.replace(/<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, (_m, href: string) => ` ${decodeEntities(href)} `)
  return decodeEntities(withLinks.replace(/<p>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i

async function getJson<T>(ctx: Parameters<Source['fetchCandidates']>[0], url: string): Promise<T> {
  const res = await ctx.fetch(url)
  if (res.status < 200 || res.status >= 300) throw new Error(`${url} answered ${res.status}`)
  return JSON.parse(res.text) as T
}

function parseComment(c: Comment): Candidate | null {
  if (!c.text) return null
  const plain = toPlain(c.text).trim()
  const nl = plain.indexOf('\n')
  const firstLine = (nl < 0 ? plain : plain.slice(0, nl)).trim()
  if (!firstLine.includes('|')) return null
  const segments = firstLine.split('|').map((s) => s.trim())
  const name = segments[0].replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim()
  if (!name) return null
  const url = `https://news.ycombinator.com/item?id=${c.id}`
  const roles = segments.slice(1).find((s) => s && !/remote/i.test(s))
  const website = plain.match(URL_RE)?.[0].replace(/[.,;:]+$/, '') ?? null
  const rest = (nl < 0 ? '' : plain.slice(nl + 1)).replace(/\s+/g, ' ').trim()
  return {
    name,
    website,
    description: (rest || firstLine).slice(0, 500),
    signals: [
      { kind: 'hiring', detail: roles ? `hiring: ${roles}` : 'hiring', date: c.created_at ?? null, sourceId: 'hn', url }
    ],
    country: null,
    city: null,
    remote: segments.some((s) => /remote/i.test(s)) ? true : null,
    stage: null,
    emails: extractEmails(plain).map((email) => ({ email, url }))
  }
}

export const hnHiringSource: Source = {
  id: 'hn',
  label: 'Hacker News: Who is hiring',
  async fetchCandidates(ctx) {
    const { hits } = await getJson<{ hits: Hit[] }>(ctx, SEARCH_URL)
    const thread = hits
      .filter((h) => h.title?.startsWith('Ask HN: Who is hiring'))
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0]
    if (!thread) return []
    const item = await getJson<{ children?: Comment[] }>(ctx, `https://hn.algolia.com/api/v1/items/${thread.objectID}`)
    return (item.children ?? []).flatMap((c) => {
      const cand = parseComment(c)
      return cand ? [cand] : []
    })
  }
}
