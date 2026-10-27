import { XMLParser } from 'fast-xml-parser'
import type { Candidate } from '../../shared/types'
import { isCompanyHost } from './hnHiring'
import { domainKey } from './normalize'
import type { Source, SourceContext } from './types'

const GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql'
const FEED_URL = 'https://www.producthunt.com/feed'
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000

interface Launch { name: string; tagline: string; website: string | null; url: string; date: string | null }

function toCandidate(l: Launch): Candidate {
  return {
    name: l.name,
    website: l.website,
    description: l.tagline,
    signals: [
      { kind: 'launched', detail: `launched on Product Hunt: ${l.tagline}`, date: l.date, sourceId: 'producthunt', url: l.url }
    ],
    country: null,
    city: null,
    remote: null,
    stage: null,
    emails: []
  }
}

// Product Hunt's own pages and redirects are never the company's site.
function isCompanyWebsite(website: string): boolean {
  try {
    const host = new URL(website).hostname.toLowerCase()
    return isCompanyHost(host) && host !== 'producthunt.com' && !host.endsWith('.producthunt.com')
  } catch {
    return false
  }
}

async function viaGraphql(ctx: SourceContext, token: string): Promise<Candidate[]> {
  const after = new Date(ctx.now.getTime() - WINDOW_MS).toISOString()
  const query =
    `{ posts(order: NEWEST, postedAfter: "${after}", first: 50) { edges { node { name tagline website url createdAt } } } }`
  const res = await ctx.fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query })
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`Product Hunt answered ${res.status}`)
  const body = JSON.parse(res.text) as {
    data?: { posts?: { edges?: { node: { name?: string; tagline?: string; website?: string | null; url?: string; createdAt?: string } }[] } }
  }
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const { node } of body.data?.posts?.edges ?? []) {
    const website = node.website?.trim() || null
    if (!node.name || !website || !isCompanyWebsite(website)) continue
    const key = domainKey(website, node.name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(
      toCandidate({ name: node.name, tagline: node.tagline ?? '', website, url: node.url ?? '', date: node.createdAt ?? null })
    )
  }
  return out
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true })
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const decode = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_m, n: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[n] ?? _m)

// The Atom feed has no company website (only Product Hunt links), so these candidates are name-only.
async function viaFeed(ctx: SourceContext): Promise<Candidate[]> {
  const res = await ctx.fetch(FEED_URL)
  if (res.status < 200 || res.status >= 300) throw new Error(`${FEED_URL} answered ${res.status}`)
  const doc = parser.parse(res.text) as { feed?: { entry?: unknown } }
  const raw = doc.feed?.entry
  const entries = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[]
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const name = text(e.title).trim()
    const link = (e.link as Record<string, unknown> | undefined)?.['@_href']
    const published = new Date(text(e.published))
    if (!name || typeof link !== 'string' || Number.isNaN(published.getTime())) continue
    if (ctx.now.getTime() - published.getTime() > WINDOW_MS) continue
    // <content type="html"> parses to { '#text', '@_type' } because attributes are kept.
    const content = text(typeof e.content === 'object' ? (e.content as Record<string, unknown> | null)?.['#text'] : e.content)
    const tagline = decode(/<p>([\s\S]*?)<\/p>/i.exec(content)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const key = domainKey(null, name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(toCandidate({ name, tagline, website: null, url: link, date: published.toISOString() }))
  }
  return out
}

export const productHuntSource: Source = {
  id: 'producthunt',
  label: 'Product Hunt',
  async fetchCandidates(ctx) {
    const token = ctx.secrets.get('producthunt.token')
    return token ? viaGraphql(ctx, token) : viaFeed(ctx)
  }
}
