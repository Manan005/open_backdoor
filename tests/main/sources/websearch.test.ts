import { describe, expect, it } from 'vitest'
import type { Fetcher, SourceContext } from '../../../src/main/sources/types'
import { buildQueries, createSearchProvider, webSearchSource } from '../../../src/main/sources/webSearch'
import { createFakeLlm } from '../llm/fakeLlm'
import type { Profile, SecretKey, Settings } from '../../../src/shared/types'

interface Call { url: string; init?: Parameters<Fetcher>[1] }

// Answers every search-API call with the same body; throws on any other URL (e.g. a result page).
function searchFetch(apiPrefix: string, body: unknown): Fetcher & { calls: Call[] } {
  const calls: Call[] = []
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init })
    if (!url.startsWith(apiPrefix)) throw new Error(`unexpected fetch of ${url}`)
    return { status: 200, text: JSON.stringify(body), url }
  }
  return Object.assign(f, { calls })
}

const profile = (over: Partial<Profile> = {}): Profile =>
  ({
    homeCountry: 'IN',
    preferences: { roles: ['backend engineer', 'ml engineer', 'third'], locations: ['Pune'] },
    ...over
  }) as Profile

function ctx(fetch: Fetcher, replies: string[], over: { provider?: Settings['searchProvider']; key?: string | null; profile?: Profile } = {}): SourceContext {
  const key = over.key === undefined ? 'sk-secret' : over.key
  return {
    fetch,
    llm: createFakeLlm(replies),
    profile: over.profile ?? profile(),
    now: new Date('2026-10-27T12:00:00Z'),
    secrets: { get: (k: SecretKey) => (k === 'search.apiKey' ? key : null) } as SourceContext['secrets'],
    settings: { searchProvider: over.provider === undefined ? 'tavily' : over.provider } as Settings,
    meta: {} as SourceContext['meta']
  }
}

describe('buildQueries', () => {
  it('uses roles[0..1] and the region name, capped at 6', () => {
    expect(buildQueries(profile())).toEqual([
      'backend engineer startup raised seed OR series A India',
      'startup hiring backend engineer India',
      'site:wellfound.com backend engineer startup',
      'site:crunchbase.com seed round India',
      'ml engineer startup raised seed OR series A India',
      'startup hiring ml engineer India'
    ])
  })

  it('falls back to the first preferred location, a generic role and remote', () => {
    const p = profile({ homeCountry: null, preferences: { roles: [], locations: [] } as unknown as Profile['preferences'] })
    expect(buildQueries(p)).toEqual([
      'software engineer startup raised seed OR series A',
      'startup hiring software engineer remote',
      'site:wellfound.com software engineer startup',
      'site:crunchbase.com seed round'
    ])
    const q = buildQueries(profile({ homeCountry: null, preferences: { roles: ['dev'], locations: ['Berlin'] } as unknown as Profile['preferences'] }))
    expect(q[1]).toBe('startup hiring dev Berlin')
  })

  it('maps US to United States', () => {
    expect(buildQueries(profile({ homeCountry: 'US' }))[3]).toBe('site:crunchbase.com seed round United States')
  })
})

describe('search providers', () => {
  it('tavily posts the query and maps results', async () => {
    const f = searchFetch('https://api.tavily.com/search', {
      results: [{ title: 'T', url: 'https://x.com/a', content: 'C', published_date: '2026-10-25' }]
    })
    const out = await createSearchProvider('tavily', 'k', f).search('q', { days: 7, max: 10 })
    expect(out).toEqual([{ title: 'T', url: 'https://x.com/a', snippet: 'C', publishedAt: '2026-10-25' }])
    expect(JSON.parse(f.calls[0].init!.body!)).toEqual({ query: 'q', max_results: 10, days: 7, topic: 'news' })
  })

  it('brave sends the token header and maps results', async () => {
    const f = searchFetch('https://api.search.brave.com/res/v1/web/search?q=a%20b&freshness=pw&count=10', {
      web: { results: [{ title: 'T', url: 'https://x.com/a', description: 'D' }] }
    })
    const out = await createSearchProvider('brave', 'k', f).search('a b', { days: 7, max: 10 })
    expect(out).toEqual([{ title: 'T', url: 'https://x.com/a', snippet: 'D', publishedAt: null }])
    expect(f.calls[0].init!.headers!['X-Subscription-Token']).toBe('k')
  })

  it('exa posts with x-api-key and a start date', async () => {
    const f = searchFetch('https://api.exa.ai/search', {
      results: [{ title: 'T', url: 'https://x.com/a', text: 'D', publishedDate: '2026-10-24' }]
    })
    const out = await createSearchProvider('exa', 'k', f).search('q', { days: 7, max: 5 })
    expect(out[0]).toEqual({ title: 'T', url: 'https://x.com/a', snippet: 'D', publishedAt: '2026-10-24' })
    const body = JSON.parse(f.calls[0].init!.body!)
    expect(body).toMatchObject({ query: 'q', numResults: 5 })
    expect(Date.parse(body.startPublishedDate)).not.toBeNaN()
    expect(f.calls[0].init!.headers!['x-api-key']).toBe('k')
  })

  it('a rejected key is reported without leaking it', async () => {
    const f: Fetcher = async (url) => ({ status: 401, text: '', url })
    await expect(createSearchProvider('brave', 'sk-secret', f).search('q', { days: 7, max: 1 })).rejects.toThrow(
      /Brave search key was rejected/
    )
  })
})

describe('web search source', () => {
  it('web search source returns [] without provider', async () => {
    const f = searchFetch('https://never', {})
    expect(await webSearchSource.fetchCandidates(ctx(f, [], { provider: null }))).toEqual([])
    expect(await webSearchSource.fetchCandidates(ctx(f, [], { key: null }))).toEqual([])
    expect(f.calls).toEqual([])
  })

  it('wellfound result is used as signal url but never fetched', async () => {
    const f = searchFetch('https://api.tavily.com/search', {
      results: [
        { title: 'Acme - Wellfound', url: 'https://wellfound.com/company/acme', content: 'Acme hiring engineers', published_date: '2026-10-26' },
        { title: 'Zed raises seed', url: 'https://techsite.com/zed', content: 'Zed raised $3M seed', published_date: null }
      ]
    })
    const llm = JSON.stringify({
      companies: [
        { resultIndex: 0, companyName: 'Acme', website: 'https://wellfound.com/company/acme', signalKind: 'hiring', detail: 'hiring engineers', country: 'India' },
        { resultIndex: 1, companyName: 'Zed', website: 'zed.dev', signalKind: 'raised', detail: '$3M seed', country: 'us' },
        { resultIndex: 9, companyName: 'Ghost', website: null, signalKind: 'raised', detail: 'x', country: null }
      ]
    })
    const out = await webSearchSource.fetchCandidates(ctx(f, [llm]))
    // only the provider API was called, once per query
    expect(f.calls.every((c) => c.url === 'https://api.tavily.com/search')).toBe(true)
    expect(f.calls).toHaveLength(6)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      name: 'Acme',
      website: null,
      country: 'IN',
      signals: [{ kind: 'hiring', sourceId: 'websearch', url: 'https://wellfound.com/company/acme', date: '2026-10-26' }]
    })
    expect(out[1]).toMatchObject({ name: 'Zed', website: 'https://zed.dev/', country: 'US' })
  })

  it('throws when every query fails', async () => {
    const bad: Fetcher = async (url) => ({ status: 500, text: '', url })
    await expect(webSearchSource.fetchCandidates(ctx(bad, []))).rejects.toThrow(/Tavily search answered 500/)
  })
})
