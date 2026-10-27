import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findContacts, fetchCompanyPages } from '../../../src/main/contacts/findContacts'
import { BlockedDomainError, type Fetcher } from '../../../src/main/net/http'
import { LlmUnavailableError } from '../../../src/main/llm/llm'
import { createFakeLlm } from '../llm/fakeLlm'

const fx = (n: string): string => readFileSync(join(__dirname, '../../fixtures/site', n), 'utf8')
const pages = [
  { url: 'https://acme.ai/', html: fx('home.html') },
  { url: 'https://acme.ai/team', html: fx('team.html') },
  { url: 'https://acme.ai/careers', html: fx('careers.html') }
]
const reply = (people: object[]): string => JSON.stringify({ people })
const linked = reply([
  { email: 'jane@acme.ai', name: 'Jane Doe', role: 'Co-founder & CEO' },
  { email: 'sam@acme.ai', name: 'Sam Roe', role: 'Engineer' }
])

describe('findContacts', () => {
  it('finds founder email on team page with sourceUrl', async () => {
    const out = await findContacts(createFakeLlm([linked]), {
      companyDomain: 'acme.ai',
      sourceEmails: [],
      pages
    })
    expect(out[0]).toEqual({
      email: 'jane@acme.ai',
      name: 'Jane Doe',
      role: 'Co-founder & CEO',
      kind: 'founder',
      sourceUrl: 'https://acme.ai/team'
    })
    expect(out.find((c) => c.email === 'sam@acme.ai')).toMatchObject({
      kind: 'person',
      sourceUrl: 'https://acme.ai/team'
    })
    expect(out.map((c) => c.email)).not.toContain('fake@scripted.com')
  })

  it('excludes info@ and support@', async () => {
    const out = await findContacts(createFakeLlm([linked]), {
      companyDomain: 'acme.ai',
      sourceEmails: [],
      pages
    })
    const emails = out.map((c) => c.email)
    for (const g of ['info@acme.ai', 'support@acme.ai', 'press@acme.ai'])
      expect(emails).not.toContain(g)
  })

  it('classifies careers@ as hiring_inbox, sorted last', async () => {
    const out = await findContacts(createFakeLlm([linked]), {
      companyDomain: 'acme.ai',
      sourceEmails: [],
      pages
    })
    expect(out[out.length - 1]).toMatchObject({
      email: 'careers@acme.ai',
      kind: 'hiring_inbox',
      name: null
    })
  })

  it('keeps gmail address only when it came from sourceEmails', async () => {
    const without = await findContacts(createFakeLlm([linked]), {
      companyDomain: 'acme.ai',
      sourceEmails: [],
      pages
    })
    expect(without.map((c) => c.email)).not.toContain('pat@gmail.com')
    const withSrc = await findContacts(createFakeLlm([linked]), {
      companyDomain: 'acme.ai',
      sourceEmails: [
        { email: 'Pat@Gmail.com', url: 'https://news.ycombinator.com/item?id=1' },
        { email: 'lee@gmail.com', url: 'https://news.ycombinator.com/item?id=2' }
      ],
      pages
    })
    expect(withSrc.find((c) => c.email === 'pat@gmail.com')).toMatchObject({
      kind: 'person',
      sourceUrl: 'https://acme.ai/team'
    })
    expect(withSrc.find((c) => c.email === 'lee@gmail.com')).toMatchObject({
      kind: 'person',
      sourceUrl: 'https://news.ycombinator.com/item?id=2'
    })
  })

  it('discards an address the LLM invents', async () => {
    const llm = createFakeLlm([reply([{ email: 'ceo@acme.ai', name: 'X', role: 'CEO' }])])
    const out = await findContacts(llm, { companyDomain: 'acme.ai', sourceEmails: [], pages })
    expect(out.map((c) => c.email)).not.toContain('ceo@acme.ai')
    expect(out.find((c) => c.email === 'jane@acme.ai')).toMatchObject({
      name: null,
      role: null,
      kind: 'person'
    })
  })

  it('keeps contacts unlinked when the LLM is unavailable', async () => {
    const out = await findContacts(createFakeLlm([new LlmUnavailableError()]), {
      companyDomain: 'acme.ai',
      sourceEmails: [],
      pages
    })
    expect(out.map((c) => c.email)).toEqual(expect.arrayContaining(['jane@acme.ai', 'sam@acme.ai']))
    expect(out.every((c) => c.name === null && c.role === null)).toBe(true)
  })

  it('sends the LLM a window of surrounding text', async () => {
    const llm = createFakeLlm([linked])
    await findContacts(llm, { companyDomain: 'acme.ai', sourceEmails: [], pages })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].prompt).toContain('jane@acme.ai')
    expect(llm.calls[0].prompt).toContain('Co-founder & CEO')
  })

  it('returns [] when nothing published', async () => {
    const llm = createFakeLlm([])
    const out = await findContacts(llm, {
      companyDomain: 'acme.ai',
      sourceEmails: [],
      pages: [{ url: 'https://acme.ai/', html: '<p>Hello</p>' }]
    })
    expect(out).toEqual([])
    expect(llm.calls).toHaveLength(0)
  })

  it('does not turn "we are at acme dot com" into are@acme.com', async () => {
    const out = await findContacts(createFakeLlm([]), {
      companyDomain: 'acme.com',
      sourceEmails: [],
      pages: [{ url: 'https://acme.com/', html: '<p>Today we are at acme dot com</p>' }]
    })
    expect(out).toEqual([])
  })
})

describe('findContacts safeguards', () => {
  const one = (html: string, domain = 'acme.com'): { url: string; html: string }[] => [
    { url: `https://${domain}/team`, html }
  ]

  it('only real founder titles become founder', async () => {
    const html =
      '<p>Dee Rector, Director of Engineering dee@acme.com</p><p>Cy Oh, Co-founder & CTO cy@acme.com</p><p>Ed Ceo, CEO ed@acme.com</p>'
    const llm = createFakeLlm([
      reply([
        { email: 'dee@acme.com', name: 'Dee', role: 'Director of Engineering' },
        { email: 'cy@acme.com', name: 'Cy', role: 'Co-founder & CTO' },
        { email: 'ed@acme.com', name: 'Ed', role: 'CEO' }
      ])
    ])
    const out = await findContacts(llm, {
      companyDomain: 'acme.com',
      sourceEmails: [],
      pages: one(html)
    })
    const kind = (e: string): string | undefined => out.find((c) => c.email === e)?.kind
    expect(kind('dee@acme.com')).toBe('person')
    expect(kind('cy@acme.com')).toBe('founder')
    expect(kind('ed@acme.com')).toBe('founder')
  })

  it('does not let software@ vouch for are@', async () => {
    const out = await findContacts(createFakeLlm([reply([])]), {
      companyDomain: 'acme.com',
      sourceEmails: [],
      pages: one('<p>Mail software@acme.com. Today we are at acme dot com</p>')
    })
    expect(out.map((c) => c.email)).toEqual(['software@acme.com'])
  })

  it("drops a neighbour's name and an unsupported role returned by the LLM", async () => {
    const html =
      '<p>Jane Doe Co-founder jane@acme.com</p>' +
      '<p>filler </p>'.repeat(60) +
      '<p>Sam Roe CTO sam@acme.com</p>'
    const llm = createFakeLlm([
      reply([
        { email: 'jane@acme.com', name: 'Sam Roe', role: 'CTO' },
        { email: 'sam@acme.com', name: 'Sam Roe', role: 'CTO' }
      ])
    ])
    const out = await findContacts(llm, {
      companyDomain: 'acme.com',
      sourceEmails: [],
      pages: one(html)
    })
    expect(out.find((c) => c.email === 'jane@acme.com')).toMatchObject({
      name: null,
      role: null,
      kind: 'person'
    })
    expect(out.find((c) => c.email === 'sam@acme.com')).toMatchObject({
      name: 'Sam Roe',
      role: 'CTO',
      kind: 'founder'
    })
  })
})

describe('findContacts name and role grounding', () => {
  const html =
    '<p>Alessandro Rossi, CEO alessandro@acme.com</p>' +
    '<p>filler </p>'.repeat(60) +
    '<p>Jessica Lee, Doctor of Physics jessica@acme.com</p>'
  const pages = [{ url: 'https://acme.com/team', html }]

  it('keeps full names whose first name appears in the own window', async () => {
    const llm = createFakeLlm([
      reply([
        { email: 'alessandro@acme.com', name: 'Alessandro Rossi', role: 'CEO' },
        { email: 'jessica@acme.com', name: 'Jessica Lee', role: null }
      ])
    ])
    const out = await findContacts(llm, { companyDomain: 'acme.com', sourceEmails: [], pages })
    expect(out.find((c) => c.email === 'alessandro@acme.com')).toMatchObject({
      name: 'Alessandro Rossi',
      role: 'CEO',
      kind: 'founder'
    })
    expect(out.find((c) => c.email === 'jessica@acme.com')).toMatchObject({ name: 'Jessica Lee' })
  })

  it('does not match a role inside another word', async () => {
    const llm = createFakeLlm([
      reply([{ email: 'jessica@acme.com', name: 'Jessica Lee', role: 'CTO' }])
    ])
    const out = await findContacts(llm, { companyDomain: 'acme.com', sourceEmails: [], pages })
    expect(out.find((c) => c.email === 'jessica@acme.com')).toMatchObject({
      role: null,
      kind: 'person'
    })
  })
})

describe('fetchCompanyPages', () => {
  it('fetches same-host pages in path order, skipping errors, blocked hosts, off-host redirects and duplicates', async () => {
    const fetch: Fetcher = async (url) => {
      const path = new URL(url).pathname
      if (path === '/about') throw new Error('boom')
      if (path === '/about-us') throw new BlockedDomainError('linkedin.com')
      if (path === '/team') return { status: 200, text: 'team', url: 'https://other.com/team' }
      if (path === '/company') return { status: 404, text: 'nf', url }
      if (path === '/jobs')
        return { status: 200, text: 'careers dup', url: 'https://www.acme.ai/careers' }
      if (path === '/careers')
        return { status: 200, text: 'careers', url: 'https://www.acme.ai/careers' }
      return { status: 200, text: path, url }
    }
    const out = await fetchCompanyPages(fetch, 'https://acme.ai')
    expect(out.map((p) => p.url)).toEqual([
      'https://acme.ai/',
      'https://www.acme.ai/careers',
      'https://acme.ai/contact'
    ])
    expect(out[1].html).toBe('careers')
  })
})
