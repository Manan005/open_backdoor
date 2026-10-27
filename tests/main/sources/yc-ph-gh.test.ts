import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { githubSource } from '../../../src/main/sources/github'
import { productHuntSource } from '../../../src/main/sources/productHunt'
import { ycSource } from '../../../src/main/sources/yc'
import type { Fetcher, SourceContext } from '../../../src/main/sources/types'
import { createFakeLlm } from '../llm/fakeLlm'
import type { Profile, SecretKey, Settings } from '../../../src/shared/types'

const fx = (p: string): string => readFileSync(join(__dirname, '../../fixtures', p), 'utf8')
const NOW = new Date('2026-10-27T12:00:00Z')

const YC_URL = 'https://yc-oss.github.io/api/companies/hiring.json'
const PH_GQL = 'https://api.producthunt.com/v2/api/graphql'
const PH_FEED = 'https://www.producthunt.com/feed'
const GH_SEARCH = 'https://api.github.com/search/repositories?q=created:>2026-09-27+stars:>200&sort=stars&per_page=30'

interface Call { url: string; init?: Parameters<Fetcher>[1] }

function fakeFetch(routes: Record<string, string>): Fetcher & { calls: Call[] } {
  const calls: Call[] = []
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init })
    const text = routes[url]
    if (text === undefined) throw new Error(`no route for ${url}`)
    return { status: 200, text, url }
  }
  return Object.assign(f, { calls })
}

function fakeMeta(): SourceContext['meta'] {
  const m = new Map<string, unknown>()
  return { get: (k: string) => (m.has(k) ? m.get(k) : null), set: (k: string, v: unknown) => void m.set(k, v) } as SourceContext['meta']
}

function ctx(fetch: Fetcher, secrets: Partial<Record<SecretKey, string>> = {}, meta = fakeMeta()): SourceContext {
  return {
    fetch,
    llm: createFakeLlm([]),
    profile: {} as Profile,
    now: NOW,
    secrets: { get: (k: SecretKey) => secrets[k] ?? null } as SourceContext['secrets'],
    settings: {} as Settings,
    meta
  }
}

describe('yc source', () => {
  it('yc keeps only active companies from recent batches and maps location', async () => {
    const f = fakeFetch({ [YC_URL]: fx('yc/hiring.json') })
    const out = await ycSource.fetchCandidates(ctx(f))
    const names = out.map((c) => c.name)
    expect(out).toHaveLength(15)
    // Inactive, pre-2025 batches and the unparseable "Unspecified" batch are dropped.
    expect(names).not.toContain('Waddle Labs')
    expect(names).not.toContain('Variant')
    expect(names).not.toContain('Poka Labs')
    expect(names).not.toContain('Y Combinator')

    const conus = out.find((c) => c.name === 'CONUS')!
    expect(conus.country).toBe('DE')
    expect(conus.city).toBe('Cologne')
    expect(conus.remote).toBe(false)
    expect(conus.website).toBe('https://www.conus-med.com')
    expect(conus.signals).toEqual([
      { kind: 'hiring', detail: 'YC Fall 2026, hiring', date: null, sourceId: 'yc', url: 'https://www.ycombinator.com/companies/conus' }
    ])

    const sunflower = out.find((c) => c.name === 'Sunflower')!
    expect(sunflower.country).toBe('US')
    expect(sunflower.city).toBe('San Francisco')
    expect(sunflower.remote).toBe(true)

    // Only the first location segment counts: "San Francisco, CA, USA; Remote".
    const mspilot = out.find((c) => c.name === 'MSPilot')!
    expect(mspilot.country).toBe('US')
    expect(mspilot.city).toBe('San Francisco')
    expect(out.find((c) => c.name === 'Leeroo')!.country).toBe('GB')
  })

  it('yc uses cache within same day', async () => {
    const f = fakeFetch({ [YC_URL]: fx('yc/hiring.json') })
    const meta = fakeMeta()
    const a = await ycSource.fetchCandidates(ctx(f, {}, meta))
    const b = await ycSource.fetchCandidates(ctx(f, {}, meta))
    expect(f.calls).toHaveLength(1)
    expect(b).toEqual(a)
  })

  it('yc refetches on a later day', async () => {
    const f = fakeFetch({ [YC_URL]: fx('yc/hiring.json') })
    const meta = fakeMeta()
    await ycSource.fetchCandidates(ctx(f, {}, meta))
    await ycSource.fetchCandidates({ ...ctx(f, {}, meta), now: new Date('2026-10-28T08:00:00Z') })
    expect(f.calls).toHaveLength(2)
  })
})

describe('product hunt source', () => {
  it('ph uses graphql with token', async () => {
    const f = fakeFetch({ [PH_GQL]: fx('ph/graphql.json') })
    const out = await productHuntSource.fetchCandidates(ctx(f, { 'producthunt.token': 'tok-123' }))
    expect(f.calls).toHaveLength(1)
    const call = f.calls[0]
    expect(call.init?.method).toBe('POST')
    expect(call.init?.headers?.Authorization).toBe('Bearer tok-123')
    const sent = JSON.parse(call.init?.body ?? '{}') as { query: string }
    expect(sent.query).toContain('order: NEWEST')
    expect(sent.query).toContain('postedAfter: "2026-10-24T12:00:00.000Z"')
    expect(sent.query).toContain('first: 50')

    // Dropped: github.com and notion.site sites, missing website, duplicate revix.ai domain.
    expect(out.map((c) => c.name)).toEqual(['Paddock', 'Revix AI', 'Lumen Ledger'])
    expect(out[0].website).toBe('https://paddock.dev/?ref=producthunt')
    expect(out[0].signals).toEqual([
      {
        kind: 'launched',
        detail: 'launched on Product Hunt: Computers and sandboxes for your agents',
        date: '2026-10-26T19:46:50Z',
        sourceId: 'producthunt',
        url: 'https://www.producthunt.com/products/paddock-2'
      }
    ])
  })

  it('ph falls back to rss without token', async () => {
    const f = fakeFetch({ [PH_FEED]: fx('ph/feed.xml') })
    const out = await productHuntSource.fetchCandidates(ctx(f))
    expect(f.calls.map((c) => c.url)).toEqual([PH_FEED])
    expect(f.calls[0].init?.headers?.Authorization).toBeUndefined()
    expect(out.length).toBeGreaterThan(3)
    const revix = out.find((c) => c.name === 'Revix AI')!
    expect(revix.website).toBeNull()
    expect(revix.signals[0]).toMatchObject({
      kind: 'launched',
      detail: "launched on Product Hunt: AI code review that learns your repo's own rules",
      sourceId: 'producthunt',
      url: 'https://www.producthunt.com/products/revix-ai-2'
    })
    // Only entries published within 3 days of now are kept; the captured feed also holds older ones.
    for (const c of out) expect(new Date(c.signals[0].date!).getTime()).toBeGreaterThanOrEqual(NOW.getTime() - 3 * 86400000)
  })
})

describe('github source', () => {
  it('github keeps org owners with blog and skips users', async () => {
    const orgs = JSON.parse(fx('gh/org.json')) as Record<string, unknown>
    const routes: Record<string, string> = { [GH_SEARCH]: fx('gh/search.json') }
    for (const [login, org] of Object.entries(orgs)) routes[`https://api.github.com/orgs/${login}`] = JSON.stringify(org)
    const f = fakeFetch(routes)
    const out = await githubSource.fetchCandidates(ctx(f, { 'github.token': 'ghp_x' }))

    expect(f.calls[0].init?.headers?.Authorization).toBe('Bearer ghp_x')
    // One org lookup per distinct org owner, none for user owners.
    const orgCalls = f.calls.filter((c) => c.url.includes('/orgs/'))
    expect(orgCalls).toHaveLength(7)
    expect(new Set(orgCalls.map((c) => c.url)).size).toBe(7)

    // google-research and openai have more than 200 repos; tangency-labs has no blog.
    expect(out.map((c) => c.name).sort()).toEqual(['ArtCraft', 'CopilotKit', 'DeepSeek', 'shaders'])
    const logins = out.map((c) => c.website)
    expect(logins).toContain('https://getartcraft.com')
    expect(logins).toContain('https://copilotkit.ai')
    expect(logins).not.toContain('https://openai.com/')
    expect(out).toHaveLength(4)

    const story = out.find((c) => c.website === 'https://getartcraft.com')!
    expect(story.signals.length).toBeGreaterThan(1)
    expect(story.signals[0]).toMatchObject({
      kind: 'launched',
      detail: 'open-source photocraft gained 73797★',
      sourceId: 'github',
      url: 'https://github.com/storytold/photocraft'
    })
  })

  it('github works without a token and sends no auth header', async () => {
    const f = fakeFetch({ [GH_SEARCH]: JSON.stringify({ items: [] }) })
    expect(await githubSource.fetchCandidates(ctx(f))).toEqual([])
    expect(f.calls[0].init?.headers?.Authorization).toBeUndefined()
  })
})
