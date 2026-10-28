import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Lead, MailMessage } from '../../../src/shared/types'
import { parseMail } from '../../../src/main/mail/imapReader'
import { classifyIncoming } from '../../../src/main/mail/classifyIncoming'

const fx = (name: string) => readFileSync(join(__dirname, '../../fixtures/mail', name))
const lead = (id: number, email: string) => ({ id, contact: { email } }) as unknown as Lead
const out = (leadId: number, messageId: string) => ({ leadId, messageId, direction: 'out' }) as unknown as MailMessage

const known: Record<string, MailMessage> = {
  '<out-first-1@gmail.com>': out(1, '<out-first-1@gmail.com>'),
  '<out-first-2@gmail.com>': out(2, '<out-first-2@gmail.com>'),
  '<out-followup-1@gmail.com>': out(1, '<out-followup-1@gmail.com>')
}
const leads = [lead(1, 'priya@acme.io'), lead(2, 'gone@deadstartup.example')]
const lookup = {
  byMessageId: (mid: string) => known[mid] ?? null,
  byContactEmail: (e: string) => leads.filter((l) => l.contact!.email.toLowerCase() === e.toLowerCase())
}
const ownIds = (mid: string) => mid === '<out-followup-1@gmail.com>'

describe('parseMail', () => {
  it('normalizes ids and addresses', async () => {
    const m = await parseMail(fx('reply-other-sender.eml'), 'inbox')
    expect(m.from).toBe('sam.okafor@personalmail.example')
    expect(m.messageId).toBe('<CAF9d4e5f6@mail.personalmail.example>')
    expect(m.references).toEqual(['<out-first-1@gmail.com>', '<CAF7a1b2c3@mail.gmail.com>'])
    expect(m.headers['in-reply-to']).toBeDefined()
  })
  it('falls back to stripped html for text', async () => {
    const m = await parseMail(fx('unrelated.eml'), 'inbox')
    expect(m.text).toContain('Ten startups & their funding.')
    expect(m.text).not.toContain('<p>')
  })
})

describe('classifyIncoming', () => {
  it('reply matched by In-Reply-To', async () => {
    const c = classifyIncoming(await parseMail(fx('reply.eml'), 'inbox'), lookup, ownIds)
    expect(c).toMatchObject({ kind: 'reply', leadId: 1 })
  })
  it('reply from different sender matches by references', async () => {
    const c = classifyIncoming(await parseMail(fx('reply-other-sender.eml'), 'inbox'), lookup, ownIds)
    expect(c).toMatchObject({ kind: 'reply', leadId: 1 })
  })
  it('falls back to sender address with a Re: subject (case-insensitive)', async () => {
    const m = await parseMail(fx('reply.eml'), 'inbox')
    const c = classifyIncoming({ ...m, inReplyTo: null, references: [], subject: 'RE: hello' }, lookup, ownIds)
    expect(c).toMatchObject({ kind: 'reply', leadId: 1 })
    expect(classifyIncoming({ ...m, inReplyTo: null, references: [], subject: 'hello' }, lookup, ownIds)).toEqual({ kind: 'unrelated' })
  })
  it('gmail bounce yields failedRecipient and lead', async () => {
    const c = classifyIncoming(await parseMail(fx('bounce-gmail.eml'), 'inbox'), lookup, ownIds)
    expect(c).toMatchObject({ kind: 'bounce', leadId: 2, failedRecipient: 'gone@deadstartup.example' })
  })
  it('bounce falls back to Final-Recipient in the delivery-status part', async () => {
    const m = await parseMail(fx('bounce-gmail.eml'), 'inbox')
    const headers = { ...m.headers }
    delete headers['x-failed-recipients']
    const c = classifyIncoming({ ...m, headers }, lookup, ownIds)
    expect(c).toMatchObject({ kind: 'bounce', leadId: 2, failedRecipient: 'gone@deadstartup.example' })
  })
  it('gmail delay notice is unrelated, not a bounce', async () => {
    const c = classifyIncoming(await parseMail(fx('delay-gmail.eml'), 'inbox'), lookup, ownIds)
    expect(c).toEqual({ kind: 'unrelated' })
  })
  it('plain mailer-daemon text without a delivery-status part is a bounce', async () => {
    const m = await parseMail(fx('bounce-gmail.eml'), 'inbox')
    const c = classifyIncoming({ ...m, text: 'Address not found: gone@deadstartup.example', headers: { 'x-failed-recipients': 'gone@deadstartup.example' } }, lookup, ownIds)
    expect(c).toMatchObject({ kind: 'bounce', leadId: 2 })
  })
  it('bounce with an unknown recipient falls back to the thread and lowercases', async () => {
    const m = await parseMail(fx('bounce-gmail.eml'), 'inbox')
    const c = classifyIncoming({ ...m, headers: { ...m.headers, 'x-failed-recipients': 'Alias@Other.example' }, text: 'Action: failed' }, lookup, ownIds)
    expect(c).toMatchObject({ kind: 'bounce', leadId: 2, failedRecipient: 'alias@other.example' })
    const upper = classifyIncoming({ ...m, headers: { ...m.headers, 'x-failed-recipients': 'GONE@deadstartup.example' } }, lookup, ownIds)
    expect(upper).toMatchObject({ kind: 'bounce', failedRecipient: 'gone@deadstartup.example' })
  })
  it('ooo detected by Auto-Submitted header', async () => {
    const c = classifyIncoming(await parseMail(fx('ooo.eml'), 'inbox'), lookup, ownIds)
    expect(c).toMatchObject({ kind: 'ooo', leadId: 1 })
  })
  it('ooo detected by subject', async () => {
    const m = await parseMail(fx('reply.eml'), 'inbox')
    const c = classifyIncoming({ ...m, subject: 'Out of office: back Monday' }, lookup, ownIds)
    expect(c.kind).toBe('ooo')
  })
  it('user message in Sent with our references is kind user', async () => {
    const c = classifyIncoming(await parseMail(fx('user-sent.eml'), 'sent'), lookup, ownIds)
    expect(c).toMatchObject({ kind: 'user', leadId: 1 })
  })
  it('our own sent follow-up is unrelated', async () => {
    const m = await parseMail(fx('user-sent.eml'), 'sent')
    const c = classifyIncoming({ ...m, messageId: '<out-followup-1@gmail.com>' }, lookup, ownIds)
    expect(c).toEqual({ kind: 'unrelated' })
  })
  it('unrelated newsletter is unrelated', async () => {
    const c = classifyIncoming(await parseMail(fx('unrelated.eml'), 'inbox'), lookup, ownIds)
    expect(c).toEqual({ kind: 'unrelated' })
  })
})

describe('testMailbox', () => {
  it('never throws', async () => {
    const { testMailbox } = await import('../../../src/main/mail/imapReader')
    const sender = { send: async () => ({ messageId: '<x@y>', at: '' }), verify: async () => {} }
    expect(await testMailbox(sender, { fetchNew: async () => [], commit: () => {}, verify: async () => {} }, 'a@b.co')).toEqual({ ok: true })
    const bad = { fetchNew: async () => [], commit: () => {}, verify: async () => { throw new Error('IMAP down') } }
    expect(await testMailbox(sender, bad, 'a@b.co')).toEqual({ ok: false, error: 'IMAP down' })
    const badSend = { ...sender, send: async () => { throw new Error('nope') } }
    expect(await testMailbox(badSend, bad, 'a@b.co')).toEqual({ ok: false, error: 'nope' })
  })
})
