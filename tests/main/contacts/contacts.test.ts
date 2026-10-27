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
