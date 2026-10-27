import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { domainKey, deobfuscateEmails, extractEmails } from '../../../src/main/sources/normalize'
import { FUNDING_FEEDS, rssFundingSource } from '../../../src/main/sources/rssFunding'
import { hnHiringSource, NON_WEBSITE_HOSTS } from '../../../src/main/sources/hnHiring'
import type { Fetcher, SourceContext } from '../../../src/main/sources/types'
import { createFakeLlm } from '../llm/fakeLlm'
import type { Profile, Settings } from '../../../src/shared/types'

const fx = (p: string): string => readFileSync(join(__dirname, '../../fixtures', p), 'utf8')
const NOW = new Date('2026-10-27T12:00:00Z')

function fakeFetch(routes: Record<string, string>): Fetcher {
  return async (url) => {
    const text = routes[url]
    if (text === undefined) throw new Error(`no route for ${url}`)
    return { status: 200, text, url }
  }
}

function ctx(
  fetch: Fetcher,
  replies: (string | Error)[] = []
): SourceContext & { llm: ReturnType<typeof createFakeLlm> } {
  return {
    fetch,
    llm: createFakeLlm(replies),
    profile: {} as Profile,
    now: NOW,
    secrets: {} as SourceContext['secrets'],
    settings: {} as Settings,
    meta: {} as SourceContext['meta']
  }
}

describe('normalize', () => {
  it('domainKey normalizes https://www.Acme.ai/about/ to acme.ai', () => {
    expect(domainKey('https://www.Acme.ai/about/', 'Acme')).toBe('acme.ai')
    expect(domainKey('http://acme.ai:8080/x?y=1#z', 'Acme')).toBe('acme.ai')
    expect(domainKey('acme.ai./', 'Acme')).toBe('acme.ai')
  })

  it('domainKey falls back to name: key', () => {
    expect(domainKey(null, 'Acme, Inc.')).toBe('name:acmeinc')
    expect(domainKey('', 'Acme AI')).toBe('name:acmeai')
  })

  it('deobfuscates "jobs [at] acme [dot] io"', () => {
    expect(deobfuscateEmails('mail jobs [at] acme [dot] io now')).toBe('mail jobs@acme.io now')
    expect(deobfuscateEmails('x(at)y.com')).toBe('x@y.com')
    expect(deobfuscateEmails('write x at y dot com please')).toBe('write x@y.com please')
  })

  it('does not mangle ordinary prose', () => {
    const prose = 'We meet at noon dot. See you at the office. Look at this.'
    expect(deobfuscateEmails(prose)).toBe(prose)
  })

  it('never invents an address from "at <domain>" prose', () => {
    for (const s of ['contact us at acme.com', 'apply at acme.io', 'email me at foo.com']) {
      expect(deobfuscateEmails(s)).toBe(s)
      expect(extractEmails(s)).toEqual([])
    }
    expect(extractEmails('jobs at acme dot io')).toEqual(['jobs@acme.io'])
    expect(extractEmails('jobs [at] acme.io')).toEqual(['jobs@acme.io'])
    expect(extractEmails('jobs(at)acme.io')).toEqual(['jobs@acme.io'])
  })

  it('extractEmails lowercases and dedupes after deobfuscation', () => {
    expect(extractEmails('Jobs@Acme.io, jobs [at] acme [dot] io and bob@x.co.')).toEqual([
      'jobs@acme.io',
      'bob@x.co'
    ])
  })
})

describe('rssFundingSource', () => {
  const tc = FUNDING_FEEDS.find((f) => f.id === 'techcrunch')!
  const reply = JSON.stringify({
    items: [
      { itemIndex: 0, isFundingNews: false, companyName: '', website: null, round: null, amount: null, country: null },
      {
        itemIndex: 3,
        isFundingNews: true,
        companyName: 'Warhound',
        website: 'https://warhound.com',
        round: 'seed',
        amount: '$200M',
        country: 'US'
      }
    ]
  })

  it('rss source emits raised signal with feed item url', async () => {
    const c = ctx(fakeFetch({ [tc.url]: fx('rss/techcrunch.xml') }), [reply])
    const out = await rssFundingSource.fetchCandidates(c)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'Warhound', website: 'https://warhound.com', stage: 'seed', country: 'US' })
    expect(out[0].signals).toEqual([
      {
        kind: 'raised',
        detail: 'raised $200M seed',
        date: '2026-10-22T23:15:00.000Z',
        sourceId: 'techcrunch',
        url: 'https://techcrunch.com/2026/10/22/ben-lamm-raises-200m-for-warhound-to-engineer-war-dogs-and-arm-them-with-anduril-gear/'
      }
    ])
    expect(c.llm.calls[0].prompt).toContain('Warhound raises $200M')
  })

  it('rss source skips failing feed', async () => {
    const routes: Record<string, string> = {}
    for (const f of FUNDING_FEEDS) if (f.id !== 'techcrunch') routes[f.url] = fx(`rss/${f.id}.xml`)
    const empty = JSON.stringify({ items: [] })
    const c = ctx(fakeFetch(routes), [empty, empty, empty])
    const out = await rssFundingSource.fetchCandidates(c)
    expect(out).toEqual([])
    expect(c.llm.calls).toHaveLength(3)
  })

  it('skips a feed whose LLM batch fails, keeps the others', async () => {
    const routes = { [tc.url]: fx('rss/techcrunch.xml'), [FUNDING_FEEDS[1].url]: fx('rss/inc42.xml') }
    const inc = JSON.stringify({
      items: [
        { itemIndex: 0, isFundingNews: true, companyName: 'Zed', website: null, round: null, amount: null, country: 'India' }
      ]
    })
    const c = ctx(fakeFetch(routes), [new Error('boom'), inc])
    const out = await rssFundingSource.fetchCandidates(c)
    expect(out.map((o) => o.name)).toEqual(['Zed'])
    expect(out[0].country).toBeNull()
    expect(out[0].signals[0].detail).toBe('raised')
  })

  it('drops items older than 7 days', async () => {
    const c = { ...ctx(fakeFetch({ [tc.url]: fx('rss/techcrunch.xml') }), []), now: new Date('2026-11-20T00:00:00Z') }
    expect(await rssFundingSource.fetchCandidates(c)).toEqual([])
    expect(c.llm.calls).toHaveLength(0)
  })
})

describe('hnHiringSource', () => {
  const search = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5'

  it('hn source parses company, remote, website and email with comment url', async () => {
    const item = JSON.parse(fx('hn/item.json'))
    item.children.push(
      { id: 1, author: null, text: null, created_at: '2026-10-01T16:00:00Z', children: [] },
      { id: 2, author: 'x', text: 'No pipe line here<p>just text', created_at: '2026-10-01T16:00:00Z', children: [] },
      {
        id: 3,
        author: 'y',
        text: 'Acme Labs | Backend Engineer | Remote (EU) | Full-time<p>See <a href="https:&#x2F;&#x2F;acme.io&#x2F;jobs" rel="nofollow">https:&#x2F;&#x2F;acme.io&#x2F;jo...</a> or mail jobs [at] acme [dot] io',
        created_at: '2026-10-02T09:30:00Z',
        children: []
      }
    )
    const c = ctx(
      fakeFetch({
        [search]: fx('hn/search.json'),
        'https://hn.algolia.com/api/v1/items/49922569': JSON.stringify(item)
      })
    )
    const out = await hnHiringSource.fetchCandidates(c)
    expect(out).toHaveLength(6)
    const acme = out.find((o) => o.name === 'Acme Labs')!
    expect(acme.website).toBe('https://acme.io/jobs')
    expect(acme.remote).toBe(true)
    expect(acme.emails).toEqual([{ email: 'jobs@acme.io', url: 'https://news.ycombinator.com/item?id=3' }])
    expect(acme.signals).toEqual([
      {
        kind: 'hiring',
        detail: 'hiring: Backend Engineer',
        date: '2026-10-02T09:30:00Z',
        sourceId: 'hn',
        url: 'https://news.ycombinator.com/item?id=3'
      }
    ])
    const snout = out.find((o) => o.name === 'Snout')!
    expect(snout.website).toBe('https://snout.com/')
    expect(snout.remote).toBe(true)
    expect(out.find((o) => o.name.startsWith('Shepherd'))!.remote).toBeNull()
  })

  it('skips job-board, code-host and blocked URLs when choosing the website', async () => {
    const mk = (id: number, text: string): object => ({ id, text, created_at: '2026-10-02T00:00:00Z', children: [] })
    const item = {
      children: [
        mk(10, 'Foo | Eng | Remote<p>Apply https:&#x2F;&#x2F;jobs.lever.co&#x2F;foo and https:&#x2F;&#x2F;foo.dev&#x2F;about'),
        mk(11, 'Bar | Eng<p>https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;bar https:&#x2F;&#x2F;www.linkedin.com&#x2F;company&#x2F;bar https:&#x2F;&#x2F;github.com&#x2F;bar'),
        mk(12, 'Baz | Eng<p>https:&#x2F;&#x2F;notlinkedin.com&#x2F;')
      ]
    }
    const c = ctx(
      fakeFetch({ [search]: fx('hn/search.json'), 'https://hn.algolia.com/api/v1/items/49922569': JSON.stringify(item) })
    )
    const out = await hnHiringSource.fetchCandidates(c)
    expect(out.map((o) => o.website)).toEqual(['https://foo.dev/about', null, 'https://notlinkedin.com/'])
    expect(NON_WEBSITE_HOSTS).toContain('jobs.ashbyhq.com'.split('.').slice(1).join('.'))
  })

  it('skips when no hiring thread is found', async () => {
    const s = JSON.stringify({
      hits: [{ objectID: '1', title: 'Ask HN: Who wants to be hired?', author: 'whoishiring', created_at: '2026-10-01T00:00:00Z' }]
    })
    expect(await hnHiringSource.fetchCandidates(ctx(fakeFetch({ [search]: s })))).toEqual([])
  })
})
