import { describe, it, expect } from 'vitest'
import { checkDraft, wordCount, type CheckContext } from '../../../src/main/drafting/checkDraft'
import {
  draftFirstEmail,
  draftFollowUp,
  followUpSubject
} from '../../../src/main/drafting/draftEmail'
import { LlmAuthError, LlmUnavailableError } from '../../../src/main/llm/llm'
import { createFakeLlm } from '../llm/fakeLlm'
import type { Company, Contact, Draft, MailMessage, Profile } from '../../../src/shared/types'

const SIGN = 'Best,\nAsha'
const STARTUP = 'your open-source query planner'
const USER = 'cut p95 latency from 900ms to 120ms'

const GOOD_BODY =
  `Hi Dana, I have been following Acme and loved ${STARTUP}, especially how it handles messy joins. ` +
  `At my last job I built a streaming ingestion service and ${USER} for a team of forty analysts. ` +
  'I also wrote a small Postgres extension that three hundred people now use every week, which taught me a lot about ' +
  'shipping carefully and listening to users. I would enjoy helping you build the next layer of this product, ' +
  'whether that is performance work, developer tooling, or something messier that nobody has picked up yet. ' +
  'If a short call next week makes sense, I can work around your schedule completely.\n\n' +
  SIGN

const good: Draft = { subject: 'Query planner and p95 latency', body: GOOD_BODY, startupDetail: STARTUP, userDetail: USER }
const ctx: CheckContext = { kind: 'first', rules: [], signOff: SIGN }

const profile = {
  name: 'Asha',
  summary: 'Backend engineer',
  skills: ['TypeScript'],
  projects: [{ name: 'Ingest', detail: 'streaming service', metrics: 'p95 120ms' }],
  preferences: { visa: null },
  rules: [{ topic: 'topics', text: 'No crypto talk', forbiddenTerms: ['crypto'] }],
  signOff: SIGN,
  homeCountry: 'IN'
} as unknown as Profile
const company = { name: 'Acme', description: 'Query planner', signals: [], country: 'US' } as unknown as Company
const contact: Contact = { email: 'dana@acme.com', name: 'Dana', role: 'CEO', kind: 'founder', sourceUrl: 'https://acme.com' }
const fctx = { profile, company, roles: [], contact, whyFit: 'Strong backend fit' }

const reply = (d: Draft): string => JSON.stringify(d)
const fails = (d: Draft, c: CheckContext = ctx): string[] => {
  const r = checkDraft(d, c)
  return r.ok ? [] : r.failures
}

describe('checkDraft', () => {
  it('passes a good first email', () => {
    const n = wordCount(GOOD_BODY)
    expect(n).toBeGreaterThanOrEqual(80)
    expect(n).toBeLessThanOrEqual(150)
    expect(checkDraft(good, ctx)).toEqual({ ok: true })
  })

  it('fails length for 40-word first email', () => {
    const body = `${STARTUP} ${USER} ${'word '.repeat(30)}\n${SIGN}`
    expect(fails({ ...good, body })).toContain('length')
  })

  it('fails forbidden_term for crypto, as a whole word, escaping terms', () => {
    const rules = [{ topic: 't', text: '', forbiddenTerms: ['crypto', 'c++'] }]
    const c: CheckContext = { ...ctx, rules }
    expect(fails({ ...good, body: GOOD_BODY.replace('messy joins', 'Crypto joins') }, c)).toContain('forbidden_term')
    expect(fails({ ...good, subject: 'About crypto' }, c)).toContain('forbidden_term')
    expect(fails({ ...good, body: GOOD_BODY.replace('messy joins', 'cryptography') }, c)).not.toContain('forbidden_term')
    expect(fails({ ...good, body: GOOD_BODY.replace('messy joins', 'C++ joins') }, c)).toContain('forbidden_term')
    expect(fails({ ...good, body: GOOD_BODY.replace('messy joins', 'cxx joins') }, c)).not.toContain('forbidden_term')
  })

  it('fails sign_off when missing or doubled', () => {
    expect(fails({ ...good, body: GOOD_BODY.replace(SIGN, 'Cheers') })).toContain('sign_off')
    expect(fails({ ...good, body: `${GOOD_BODY}\n${SIGN}` })).toContain('sign_off')
    expect(fails({ ...good, body: `${GOOD_BODY}\n\nP.S. hi` })).toContain('sign_off')
  })

  it('fails placeholder for [Company Name]', () => {
    expect(fails({ ...good, body: GOOD_BODY.replace('Acme', '[Company Name]') })).toContain('placeholder')
    expect(fails({ ...good, subject: 'Hello {{name}}' })).toContain('subject')
  })

  it('fails startup_detail when detail not in body', () => {
    expect(fails({ ...good, startupDetail: 'something not said' })).toContain('startup_detail')
    expect(fails({ ...good, startupDetail: '' })).toContain('startup_detail')
    expect(fails({ ...good, userDetail: 'never said' })).toContain('user_detail')
  })

  it('checks follow-up subject and length', () => {
    const body = `Quick nudge: ${STARTUP} still excites me and I ${USER} before, so I would love to chat briefly.\n\n${SIGN}`
    const c: CheckContext = { kind: 'followup', rules: [], signOff: SIGN, originalSubject: 'Hello there' }
    const d = { subject: 'Re: Hello there', body, startupDetail: STARTUP, userDetail: USER }
    expect(checkDraft(d, c)).toEqual({ ok: true })
    expect(fails({ ...d, subject: 'Something else' }, c)).toContain('subject')
    expect(fails({ ...d, body: GOOD_BODY }, c)).toContain('length')
  })

  it('follow-up failing gates is returned with failures', () => {
    const c: CheckContext = { kind: 'followup', rules: [], signOff: SIGN, originalSubject: 'Hi' }
    const r = checkDraft({ subject: 'Re: Hi', body: 'too short', startupDetail: 'x', userDetail: 'y' }, c)
    expect(r.ok).toBe(false)
  })
})

describe('draftFirstEmail', () => {
  it('retries once on gate failure', async () => {
    const bad = { ...good, body: 'Too short.' }
    const llm = createFakeLlm([reply(bad), reply(good)])
    const d = await draftFirstEmail(llm, fctx)
    expect(llm.calls).toHaveLength(2)
    expect(d).toEqual(good)
  })

  it('returns the attempt with fewer failures after two bad tries', async () => {
    const worse = { ...good, body: 'Too short.' } // length, sign_off, details
    const better = { ...good, body: GOOD_BODY.replace(SIGN, 'Cheers') } // sign_off only
    const llm = createFakeLlm([reply(better), reply(worse)])
    expect(await draftFirstEmail(llm, fctx)).toEqual(better)
  })

  it('does not swallow provider errors', async () => {
    await expect(draftFirstEmail(createFakeLlm([new LlmUnavailableError()]), fctx)).rejects.toBeInstanceOf(
      LlmUnavailableError
    )
    await expect(draftFirstEmail(createFakeLlm([new LlmAuthError()]), fctx)).rejects.toBeInstanceOf(LlmAuthError)
  })
})

describe('draftFollowUp', () => {
  const msg = (over: Partial<MailMessage>): MailMessage =>
    ({ id: 1, leadId: 1, direction: 'out', kind: 'first', subject: 'Re: Hello there', text: ' original text ', ...over }) as MailMessage

  it('sets the subject in code and strips existing Re:', async () => {
    const llm = createFakeLlm([reply({ subject: 'Whatever', body: 'x', startupDetail: 'a', userDetail: 'b' })])
    const d = await draftFollowUp(llm, { profile, company, thread: [msg({})], n: 3 })
    expect(d.subject).toBe('Re: Hello there')
    expect(llm.calls[0].prompt).toContain('original text')
    expect(llm.calls[0].system).toMatch(/polite close/i)
    expect(followUpSubject('RE: re: Foo')).toBe('Re: Foo')
  })
})
