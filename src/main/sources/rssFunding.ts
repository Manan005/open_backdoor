import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'
import type { Candidate, SourceId, Stage } from '../../shared/types'
import { generateStructured } from '../llm/llm'
import type { Source, SourceContext } from './types'

export const FUNDING_FEEDS: { id: SourceId; url: string }[] = [
  { id: 'techcrunch', url: 'https://techcrunch.com/category/venture/feed/' },
  { id: 'inc42', url: 'https://inc42.com/buzz/feed/' },
  { id: 'entrackr', url: 'https://entrackr.com/rss' },
  { id: 'yourstory', url: 'https://yourstory.com/feed' }
]

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const STAGES = ['pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'later', 'unknown'] as const

const batchSchema = z.object({
  items: z.array(
    z.object({
      itemIndex: z.number(),
      isFundingNews: z.boolean(),
      companyName: z.string(),
      website: z.string().nullable(),
      round: z.enum(STAGES).nullable(),
      amount: z.string().nullable(),
      country: z.string().nullable()
    })
  )
})

interface FeedItem { title: string; description: string; link: string; date: Date }

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true })

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const stripHtml = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function parseItems(xml: string, now: Date): FeedItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: unknown } } }
  const raw = doc.rss?.channel?.item
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: FeedItem[] = []
  for (const r of list as Record<string, unknown>[]) {
    const date = new Date(text(r.pubDate) || text(r['dc:date']))
    const link = text(r.link)
    const title = stripHtml(text(r.title))
    if (!title || !link || Number.isNaN(date.getTime())) continue
    if (now.getTime() - date.getTime() > WINDOW_MS) continue
    out.push({ title, link, date, description: stripHtml(text(r.description)).slice(0, 400) })
  }
  return out
}

async function candidatesForFeed(
  feed: { id: SourceId; url: string },
  ctx: SourceContext
): Promise<Candidate[]> {
  const res = await ctx.fetch(feed.url)
  if (res.status < 200 || res.status >= 300) throw new Error(`${feed.url} answered ${res.status}`)
  const items = parseItems(res.text, ctx.now)
  if (items.length === 0) return []

  const listing = items.map((it, i) => `[${i}] ${it.title}\n${it.description}`).join('\n\n')
  const reply = await generateStructured(ctx.llm, batchSchema, {
    system:
      'You read startup news headlines and decide which ones report a company raising money. ' +
      'Reply with JSON only.',
    prompt:
      'For each numbered item return itemIndex, isFundingNews (true only if a startup announced a funding round), ' +
      'companyName (the company that raised), website (its site if the text states it, else null), ' +
      'round (one of pre-seed, seed, series-a, series-b, series-c, later, unknown; null if not stated), ' +
      'amount (as written, e.g. "$5M", else null) and country (ISO 3166 alpha-2 code if clear, else null). ' +
      'Put the results in an "items" array.\n\n' +
      listing
  })

  const out: Candidate[] = []
  const seen = new Set<number>()
  for (const r of reply.items) {
    const item = items[r.itemIndex]
    const name = r.companyName.trim()
    if (!r.isFundingNews || !item || !name || seen.has(r.itemIndex)) continue
    seen.add(r.itemIndex)
    const detail = ['raised', r.amount?.trim(), r.round && r.round !== 'unknown' ? r.round : null]
      .filter(Boolean)
      .join(' ')
    out.push({
      name,
      website: r.website?.trim() || null,
      description: item.title,
      signals: [{ kind: 'raised', detail, date: item.date.toISOString(), sourceId: feed.id, url: item.link }],
      country: r.country && /^[A-Za-z]{2}$/.test(r.country.trim()) ? r.country.trim().toUpperCase() : null,
      city: null,
      remote: null,
      stage: (r.round as Stage | null) ?? null,
      emails: []
    })
  }
  return out
}

export const rssFundingSource: Source = {
  id: 'rssFunding',
  label: 'Funding news',
  async fetchCandidates(ctx) {
    const all: Candidate[] = []
    // Sequential: keeps LLM call order deterministic and the load on the feeds gentle.
    for (const feed of FUNDING_FEEDS) {
      try {
        all.push(...(await candidatesForFeed(feed, ctx)))
      } catch {
        // a failing feed is skipped, not fatal
      }
    }
    return all
  }
}
