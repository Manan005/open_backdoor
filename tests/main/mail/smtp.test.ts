import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SMTPServer } from 'smtp-server'
import { simpleParser, type ParsedMail } from 'mailparser'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { MailSettings } from '../../../src/shared/types'
import { presetForAddress, MAIL_PRESETS } from '../../../src/main/mail/presets'
import { createSmtpSender, MailAuthError, MailSendError } from '../../../src/main/mail/smtpSender'

let server: SMTPServer
let received: ParsedMail[]
let cfg: MailSettings
const plain = { tls: { rejectUnauthorized: false } }

beforeEach(async () => {
  received = []
  server = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authOptional: false,
    onAuth(auth, _s, cb) {
      if (auth.password === 'pw') cb(null, { user: auth.username })
      else cb(new Error('Invalid login'))
    },
    onData(stream, _s, cb) {
      simpleParser(stream).then((m) => { received.push(m); cb() }, cb)
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.server.address() as AddressInfo).port
  cfg = { address: 'me@example.com', preset: 'other', smtpHost: '127.0.0.1', smtpPort: port, imapHost: 'x', imapPort: 993, sentMailbox: 'Sent' }
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const base = { to: 'founder@startup.io', subject: 'Hello', text: 'Body text', inReplyTo: null, references: [], attachmentPath: null }

describe('smtp sender', () => {
  it('sends plain text with Message-ID', async () => {
    const res = await createSmtpSender(cfg, 'pw', plain).send(base)
    expect(res.messageId).toMatch(/^<[0-9a-f-]{36}@example\.com>$/)
    expect(Number.isNaN(Date.parse(res.at))).toBe(false)
    expect(received).toHaveLength(1)
    const m = received[0]
    expect(m.messageId).toBe(res.messageId)
    expect(m.text?.trim()).toBe('Body text')
    expect(m.html).toBe(false)
    expect(m.subject).toBe('Hello')
    expect(m.from?.value[0].address).toBe('me@example.com')
    expect(m.to).toMatchObject({ value: [{ address: 'founder@startup.io' }] })
    expect(m.attachments).toHaveLength(0)
  })

  it('follow-up carries In-Reply-To and References', async () => {
    const s = createSmtpSender(cfg, 'pw', plain)
    const first = await s.send(base)
    await s.send({ ...base, subject: 'Re: Hello', inReplyTo: first.messageId, references: [first.messageId] })
    const m = received[1]
    expect(m.inReplyTo).toBe(first.messageId)
    expect([m.references].flat()).toEqual([first.messageId])
  })

  it('wrong password throws MailAuthError without leaking the password', async () => {
    const err = await createSmtpSender(cfg, 'badpass-secret', plain).send(base).catch((e) => e)
    expect(err).toBeInstanceOf(MailAuthError)
    expect(String(err.message)).not.toContain('badpass-secret')
    await expect(createSmtpSender(cfg, 'bad', plain).verify()).rejects.toBeInstanceOf(MailAuthError)
  })

  it('verify succeeds with the right password', async () => {
    await expect(createSmtpSender(cfg, 'pw', plain).verify()).resolves.toBeUndefined()
  })

  it('attachment included when attachmentPath set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smtp-'))
    try {
      const p = join(dir, 'resume.pdf')
      writeFileSync(p, 'PDFDATA')
      await createSmtpSender(cfg, 'pw', plain).send({ ...base, attachmentPath: p })
      expect(received[0].attachments).toHaveLength(1)
      expect(received[0].attachments[0].filename).toBe('resume.pdf')
      expect(received[0].attachments[0].content.toString()).toBe('PDFDATA')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects header injection and invalid recipients with MailSendError', async () => {
    const s = createSmtpSender(cfg, 'pw', plain)
    await expect(s.send({ ...base, subject: 'a\r\nBcc: x@y.com' })).rejects.toBeInstanceOf(MailSendError)
    await expect(s.send({ ...base, to: 'a@b.com\nBcc: x@y.com' })).rejects.toBeInstanceOf(MailSendError)
    await expect(s.send({ ...base, to: 'a@b.com, c@d.com' })).rejects.toBeInstanceOf(MailSendError)
    await expect(s.send({ ...base, to: 'not-an-address' })).rejects.toBeInstanceOf(MailSendError)
    expect(received).toHaveLength(0)
  })

  it('unreachable server throws MailSendError', async () => {
    const err = await createSmtpSender({ ...cfg, smtpPort: 1 }, 'pw', plain).send(base).catch((e) => e)
    expect(err).toBeInstanceOf(MailSendError)
    expect(err).not.toBeInstanceOf(MailAuthError)
  })
})

describe('presets', () => {
  it('presetForAddress maps gmail/zoho/zoho.in/other', () => {
    expect(presetForAddress('a@gmail.com')).toBe('gmail')
    expect(presetForAddress('a@GoogleMail.com')).toBe('gmail')
    expect(presetForAddress('a@zoho.com')).toBe('zoho')
    expect(presetForAddress('a@zoho.in')).toBe('zoho_in')
    expect(presetForAddress('a@acme.dev')).toBe('other')
    expect(MAIL_PRESETS.gmail).toEqual({ smtpHost: 'smtp.gmail.com', smtpPort: 465, imapHost: 'imap.gmail.com', imapPort: 993, sentMailbox: '[Gmail]/Sent Mail' })
    expect(MAIL_PRESETS.zoho_in.smtpHost).toBe('smtp.zoho.in')
  })
})
