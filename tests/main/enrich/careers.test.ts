import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectBoards, domainLabel, findOpenRoles } from '../../../src/main/enrich/careers'
import type { Fetcher } from '../../../src/main/net/http'

const fx = (p: string): string => readFileSync(join(__dirname, '../../fixtures/careers', p), 'utf8')

// Routes map a URL to a body or a status; anything else is a 404.
function fakeFetch(routes: Record<string, string | number | Error>): Fetcher & { urls: string[] } {
  const urls: string[] = []
  const f: Fetcher = async (url) => {
    urls.push(url)
    const r = routes[url]
    if (r instanceof Error) throw r
    if (typeof r === 'number') return { status: r, text: '', url }
    if (r === undefined) return { status: 404, text: 'Not Found', url }
    return { status: 200, text: r, url }
  }
  return Object.assign(f, { urls })
}

// The Workable fixture is Hugging Face's board; guessed boards must carry the company's own name.
const workableAs = (name: string): string => JSON.stringify({ ...JSON.parse(fx('workable.json')), name })

const GH = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs'
const LEVER = 'https://api.lever.co/v0/postings/acme?mode=json'
const ASHBY = 'https://api.ashbyhq.com/posting-api/job-board/acme'
const WORKABLE = 'https://apply.workable.com/api/v1/widget/accounts/acme'

describe('findOpenRoles', () => {
  it('detects lever slug from careers html and returns roles', async () => {
    const f = fakeFetch({ 'https://api.lever.co/v0/postings/palantir?mode=json': fx('lever.json') })
    const roles = await findOpenRoles(f, {
      name: 'Palantir',
      website: 'https://www.example.com',
      careersHtml: '<a href="https://jobs.lever.co/palantir/">Open roles</a>'
    })
    expect(f.urls).toEqual(['https://api.lever.co/v0/postings/palantir?mode=json'])
    expect(roles).toHaveLength(3)
    expect(roles[0]).toEqual({
      title: 'Administrative Business Partner',
      location: 'Singapore, Singapore',
      remote: false,
      url: 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd'
    })
  })

  it('falls back to domain-label slug on greenhouse', async () => {
    const f = fakeFetch({ [GH]: fx('gh.json') })
    const roles = await findOpenRoles(f, { name: 'Acme', website: 'https://www.acme.ai/about', careersHtml: null })
    expect(f.urls[0]).toBe(GH)
    expect(roles.map((r) => r.title)).toEqual(['Abuse Investigator', 'Abuse Investigator', 'Abuse Investigator'])
    expect(roles[0]).toMatchObject({ location: 'Dublin', remote: null, url: 'https://stripe.com/jobs/search?gh_jid=8172508' })
  })

  it('404 on all boards returns []', async () => {
    const f = fakeFetch({})
    const roles = await findOpenRoles(f, { name: 'Acme', website: 'https://acme.ai', careersHtml: null })
    expect(roles).toEqual([])
    expect(f.urls).toEqual([GH, LEVER, ASHBY, WORKABLE])
  })

  it('rejects a guessed greenhouse board that belongs to another company, accepts a matching one', async () => {
    const GH_META = 'https://boards-api.greenhouse.io/v1/boards/acme'
    const co = { name: 'Acme AI', website: 'https://acme.ai', careersHtml: null }
    const other = fakeFetch({ [GH]: fx('gh.json'), [GH_META]: JSON.stringify({ name: 'Stripe' }) })
    expect(await findOpenRoles(other, co)).toEqual([])
    const same = fakeFetch({ [GH]: fx('gh.json'), [GH_META]: JSON.stringify({ name: 'Acme' }) })
    expect(await findOpenRoles(same, co)).toHaveLength(3)
  })

  it('rejects a guessed workable board with a different name and skips guesses whose slug does not fit the name', async () => {
    const f = fakeFetch({ [WORKABLE]: fx('workable.json') })
    expect(await findOpenRoles(f, { name: 'Acme', website: 'https://acme.ai', careersHtml: null })).toEqual([])
    const g = fakeFetch({ [GH]: fx('gh.json') })
    expect(await findOpenRoles(g, { name: 'Totally Different', website: 'https://acme.ai', careersHtml: null })).toEqual([])
    expect(g.urls).toEqual([])
  })

  it('detected-link slugs skip the name checks', async () => {
    const f = fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs': fx('gh.json') })
    const roles = await findOpenRoles(f, {
      name: 'Unrelated Name', website: null, careersHtml: '<a href="https://boards.greenhouse.io/stripe">x</a>'
    })
    expect(roles).toHaveLength(3)
    expect(f.urls).toHaveLength(1)
  })

  it('maps ashby and workable boards', async () => {
    const ashby = await findOpenRoles(fakeFetch({ [ASHBY]: fx('ashby.json') }), { name: 'Acme', website: 'https://acme.ai', careersHtml: null })
    expect(ashby[0]).toEqual({
      title: 'Engineering Manager - EU',
      location: 'Remote - European Union',
      remote: true,
      url: 'https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2'
    })
    const workable = await findOpenRoles(fakeFetch({ [WORKABLE]: workableAs('Acme') }), { name: 'Acme', website: 'https://acme.ai', careersHtml: null })
    expect(workable[0]).toEqual({
      title: 'Open-Source Machine Learning Engineer - EMEA Remote',
      location: 'Paris, France',
      remote: true,
      url: 'https://apply.workable.com/j/81B46579FE'
    })
  })

  it('a failing board does not stop the next one; network errors count as no board', async () => {
    const f = fakeFetch({ [GH]: new Error('ECONNRESET'), [LEVER]: 500, [ASHBY]: '<html>not json</html>', [WORKABLE]: workableAs('Acme') })
    const roles = await findOpenRoles(f, { name: 'Acme', website: 'https://acme.ai', careersHtml: null })
    expect(f.urls).toHaveLength(4)
    expect(roles).toHaveLength(3)
  })

  it('returns [] with no careers html and no website', async () => {
    const f = fakeFetch({})
    expect(await findOpenRoles(f, { name: 'Acme', website: null, careersHtml: null })).toEqual([])
    expect(f.urls).toEqual([])
  })
})

describe('detectBoards', () => {
  it('finds each ATS link, the greenhouse embed ?for= form and ignores api/embed paths', () => {
    const html = `
      <a href="https://boards.greenhouse.io/acme/jobs/123">a</a>
      <a href="https://job-boards.greenhouse.io/beta">b</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=gamma"></script>
      <a href="https://boards.greenhouse.io/embed/job_board?for=delta&amp;x=1">d</a>
      <a href="https://jobs.lever.co/epsilon/abc-123">e</a>
      <a href="https://jobs.ashbyhq.com/zeta/job/1">z</a>
      <a href="https://apply.workable.com/eta/j/ABC/">h</a>
      <a href="https://apply.workable.com/api/v1/widget/accounts/x">x</a>`
    expect(detectBoards(html)).toEqual([
      { ats: 'greenhouse', slug: 'acme' },
      { ats: 'greenhouse', slug: 'beta' },
      { ats: 'greenhouse', slug: 'gamma' },
      { ats: 'greenhouse', slug: 'delta' },
      { ats: 'lever', slug: 'epsilon' },
      { ats: 'ashby', slug: 'zeta' },
      { ats: 'workable', slug: 'eta' }
    ])
  })
})

describe('domainLabel', () => {
  it('takes the registrable label', () => {
    expect(domainLabel('https://www.acme.ai/x')).toBe('acme')
    expect(domainLabel('acme.co.uk')).toBe('acme')
    expect(domainLabel('https://app.acme.io')).toBe('acme')
    expect(domainLabel(null)).toBeNull()
    expect(domainLabel('https://acme.vercel.app')).toBeNull()
    expect(domainLabel('https://x.github.io')).toBeNull()
    expect(domainLabel('https://foo.notion.site')).toBeNull()
    expect(domainLabel('https://acme.pages.dev')).toBeNull()
    expect(domainLabel('https://github.com/acme')).toBeNull()
  })
})
