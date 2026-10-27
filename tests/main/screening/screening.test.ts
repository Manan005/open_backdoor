import { describe, expect, it } from 'vitest'
import type { Candidate, Profile } from '../../../src/shared/types'
import { dedupe, screen } from '../../../src/main/screening/screen'
import { keepCandidate, scoreFit } from '../../../src/main/screening/fitScore'
import { timezoneFor } from '../../../src/main/screening/timezones'
import { createFakeLlm } from '../llm/fakeLlm'

const cand = (o: Partial<Candidate> = {}): Candidate => ({
  name: 'Acme', website: null, description: 'builds tools', signals: [], country: null, city: null,
  remote: null, stage: null, emails: [], ...o
})
const sig = (url: string) => ({ kind: 'launched' as const, detail: 'd', date: null, sourceId: 'hn' as const, url })
const profile = (o: Partial<Profile['preferences']> = {}, home: string | null = 'IN'): Profile => ({
  name: 'Me', email: null, summary: 'Full-stack dev', yearsExperience: 3, skills: ['ts', 'react'],
  projects: [{ name: 'Sidedoor', detail: 'job agent', metrics: null }], experience: [], links: [],
  preferences: { roles: [], locations: [], remoteOk: true, stages: [], visa: null, salaryFloor: null, exclusions: [], ...o },
  rules: [], signOff: null, homeCountry: home, homeCity: null, timezone: 'Asia/Kolkata', resumePath: null, rawText: ''
})

describe('dedupe', () => {
  it('merges www/https/path variants into one', () => {
    const out = dedupe([
      cand({ website: 'https://www.acme.com/about', signals: [sig('a')], emails: [{ email: 'Hi@acme.com', url: 'u' }], country: 'US' }),
      cand({ website: 'http://acme.com', signals: [sig('a'), sig('b')], emails: [{ email: 'hi@acme.com', url: 'u2' }], city: 'Austin', stage: 'seed' })
    ], new Set())
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('acme.com')
    expect(out[0].candidate.signals.map((s) => s.url)).toEqual(['a', 'b'])
    expect(out[0].candidate.emails).toHaveLength(1)
    expect(out[0].candidate).toMatchObject({ country: 'US', city: 'Austin', stage: 'seed' })
  })

  it('treats unknown stage as a gap', () => {
    const out = dedupe([cand({ website: 'acme.com', stage: 'unknown' }), cand({ website: 'acme.com', stage: 'seed' })], new Set())
    expect(out[0].candidate.stage).toBe('seed')
  })

  it('drops already-contacted keys', () => {
    const out = dedupe([cand({ website: 'https://acme.com' }), cand({ name: 'Other', website: 'other.io' })], new Set(['acme.com']))
    expect(out.map((o) => o.key)).toEqual(['other.io'])
  })

  it('drops by name key, for name-only and for website candidates stored earlier name-only', () => {
    const existing = new Set(['name:acme'])
    expect(dedupe([cand({ name: 'ACME!' })], existing)).toEqual([])
    expect(dedupe([cand({ website: 'acme.com' })], existing)).toEqual([])
  })

  it('merges name-only into website candidate with same name', () => {
    const out = dedupe([
      cand({ name: 'Acme', signals: [sig('x')], emails: [{ email: 'a@acme.com', url: 'u' }] }),
      cand({ name: 'ACME', website: 'https://acme.com', signals: [sig('y')] })
    ], new Set())
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('acme.com')
    expect(out[0].candidate.signals).toHaveLength(2)
    expect(out[0].candidate.website).toBe('https://acme.com')
  })

  it('keeps unmatched name-only candidates, merged by name', () => {
    const out = dedupe([cand({ name: 'Foo Bar' }), cand({ name: 'foo-bar', signals: [sig('z')] })], new Set())
    expect(out.map((o) => o.key)).toEqual(['name:foobar'])
    expect(out[0].candidate.signals).toHaveLength(1)
  })
})

describe('screen', () => {
  it('excludes by term', () => {
    expect(screen(cand({ description: 'A Crypto exchange' }), profile({ exclusions: ['crypto'] }))).toEqual({ pass: false, reason: 'excluded' })
  })
  it('rejects by stage but allows unknown stage and empty list', () => {
    expect(screen(cand({ stage: 'series-c' }), profile({ stages: ['seed'] }))).toEqual({ pass: false, reason: 'stage' })
    expect(screen(cand({ stage: 'unknown' }), profile({ stages: ['seed'] })).pass).toBe(true)
    expect(screen(cand({ stage: 'later' }), profile()).pass).toBe(true)
  })
  it('rejects onsite foreign company, passes remote one, passes unknown', () => {
    expect(screen(cand({ country: 'US', remote: false }), profile())).toEqual({ pass: false, reason: 'location' })
    expect(screen(cand({ country: 'US', remote: true }), profile()).pass).toBe(true)
    expect(screen(cand({ country: null, remote: false }), profile()).pass).toBe(true)
    expect(screen(cand({ country: 'IN', remote: false }), profile()).pass).toBe(true)
  })
  it('passes a foreign onsite company whose country is in preferred locations, via free text', () => {
    expect(screen(cand({ country: 'US', remote: false }), profile({ locations: ['Remote', 'San Francisco'] })).pass).toBe(true)
  })
  it('with unknown home country only preferred locations pass', () => {
    expect(screen(cand({ country: 'US', remote: false }), profile({}, null))).toEqual({ pass: false, reason: 'location' })
    expect(screen(cand({ country: 'US', remote: false }), profile({ locations: ['USA'] }, null)).pass).toBe(true)
  })
})

describe('timezoneFor', () => {
  it('prefers city', () => {
    expect(timezoneFor('US', 'San Francisco')).toBe('America/Los_Angeles')
    expect(timezoneFor('US', 'New York')).toBe('America/New_York')
    expect(timezoneFor('IN', 'Bengaluru')).toBe('Asia/Kolkata')
    expect(timezoneFor(null, 'Bangalore')).toBe('Asia/Kolkata')
    expect(timezoneFor('US', 'San Francisco, CA')).toBe('America/Los_Angeles')
  })
  it('falls back to country default, then null', () => {
    expect(timezoneFor('DE', null)).toBe('Europe/Berlin')
    expect(timezoneFor('US', 'Nowhereville')).toBe('America/New_York')
    expect(timezoneFor('ZZ', null)).toBeNull()
    expect(timezoneFor(null, null)).toBeNull()
  })
  it('returns valid IANA zones', () => {
    for (const c of ['US', 'IN', 'GB', 'CA', 'DE', 'FR', 'SG', 'AE', 'AU', 'NL', 'IL', 'BR']) {
      expect(() => new Intl.DateTimeFormat('en', { timeZone: timezoneFor(c, null)! })).not.toThrow()
    }
    for (const city of ['San Francisco', 'Seattle', 'Denver', 'Vancouver', 'Calgary', 'Melbourne', 'Perth', 'Brisbane', 'Sao Paulo', 'Tel Aviv', 'Chicago']) {
      expect(() => new Intl.DateTimeFormat('en', { timeZone: timezoneFor(null, city)! })).not.toThrow()
    }
  })
})

describe('scoreFit', () => {
  it('parses LLM result and includes context in the prompt', async () => {
    const llm = createFakeLlm(['{"score": 82, "whyFit": "Sidedoor matches their agent work", "couldDoWork": true, "hiresInRegion": "yes"}'])
    const roles = Array.from({ length: 20 }, (_, i) => ({ title: `Role${i}`, location: null, remote: true, url: 'u' }))
    const r = await scoreFit(llm, cand({ signals: [sig('a')] }), roles, profile())
    expect(r).toEqual({ score: 82, whyFit: 'Sidedoor matches their agent work', couldDoWork: true, hiresInRegion: 'yes' })
    const p = llm.calls[0].prompt
    expect(p).toContain('Sidedoor')
    expect(p).toContain('Role14')
    expect(p).not.toContain('Role15')
  })
  it('clamps score to 0-100', async () => {
    const mk = (s: number) => `{"score": ${s}, "whyFit": "w", "couldDoWork": true, "hiresInRegion": "unknown"}`
    expect((await scoreFit(createFakeLlm([mk(140)]), cand(), [], profile())).score).toBe(100)
    expect((await scoreFit(createFakeLlm([mk(-5)]), cand(), [], profile())).score).toBe(0)
  })
  it('keepCandidate applies the keep rule', () => {
    const base = { score: 60, whyFit: 'w', couldDoWork: true, hiresInRegion: 'unknown' as const }
    expect(keepCandidate(base)).toBe(true)
    expect(keepCandidate({ ...base, score: 59 })).toBe(false)
    expect(keepCandidate({ ...base, couldDoWork: false })).toBe(false)
    expect(keepCandidate({ ...base, hiresInRegion: 'no' })).toBe(false)
    expect(keepCandidate({ ...base, hiresInRegion: 'yes' })).toBe(true)
  })
})
