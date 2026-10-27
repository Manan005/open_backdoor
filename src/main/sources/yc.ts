import type { Candidate } from '../../shared/types'
import { countryFromText } from '../screening/timezones'
import type { Source } from './types'

const URL = 'https://yc-oss.github.io/api/companies/hiring.json'
const CACHE_KEY = 'yc.cache'
const RECENT_BATCHES = 8
const SEASONS = ['Winter', 'Spring', 'Summer', 'Fall']

interface YcCompany {
  name?: string
  website?: string
  one_liner?: string
  all_locations?: string
  regions?: string[]
  batch?: string
  status?: string
  isHiring?: boolean
  stage?: string
  url?: string
}

interface YcCache { date: string; json: string }

// "Summer 2025" to a sortable number (Winter < Spring < Summer < Fall); null for "Unspecified" etc.
function batchRank(batch: string | undefined): number | null {
  const m = /^(Winter|Spring|Summer|Fall) (\d{4})$/.exec(batch ?? '')
  return m ? Number(m[2]) * 4 + SEASONS.indexOf(m[1]) : null
}

async function loadCompanies(ctx: Parameters<Source['fetchCandidates']>[0]): Promise<YcCompany[]> {
  const today = ctx.now.toISOString().slice(0, 10)
  const cached = ctx.meta.get<YcCache>(CACHE_KEY)
  if (cached?.date === today) return JSON.parse(cached.json) as YcCompany[]
  const res = await ctx.fetch(URL)
  if (res.status < 200 || res.status >= 300) throw new Error(`${URL} answered ${res.status}`)
  const companies = JSON.parse(res.text) as YcCompany[]
  ctx.meta.set(CACHE_KEY, { date: today, json: res.text } satisfies YcCache)
  return companies
}

export const ycSource: Source = {
  id: 'yc',
  label: 'Y Combinator: hiring',
  async fetchCandidates(ctx) {
    const companies = await loadCompanies(ctx)
    const ranks = [...new Set(companies.map((c) => batchRank(c.batch)).filter((r): r is number => r !== null))]
      .sort((a, b) => b - a)
      .slice(0, RECENT_BATCHES)
    const recent = new Set(ranks)

    const out: Candidate[] = []
    for (const c of companies) {
      const rank = batchRank(c.batch)
      if (c.status !== 'Active' || !c.name || rank === null || !recent.has(rank)) continue
      // "San Francisco, CA, USA; Remote": only the first location describes where the company is.
      const first = (c.all_locations ?? '').split(';')[0].trim()
      out.push({
        name: c.name,
        website: c.website?.trim() || null,
        description: c.one_liner ?? '',
        signals: [
          { kind: 'hiring', detail: `YC ${c.batch}, hiring`, date: null, sourceId: 'yc', url: c.url ?? '' }
        ],
        country: countryFromText(first),
        city: first.split(',')[0].trim() || null,
        remote: (c.regions ?? []).includes('Remote'),
        stage: null,
        emails: []
      })
    }
    return out
  }
}
