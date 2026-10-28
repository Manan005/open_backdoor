import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import nodemailer from 'nodemailer'
import type { MailSettings } from '../../shared/types'

export interface OutgoingMail {
  to: string; subject: string; text: string
  inReplyTo: string | null; references: string[]; attachmentPath: string | null
}
/** messageId is exactly the Message-ID header value, angle brackets included (`<uuid@domain>`). Store and match it verbatim. */
export interface MailSender {
  send(m: OutgoingMail): Promise<{ messageId: string; at: string }>
  verify(): Promise<void>
}

export class MailAuthError extends Error {
  constructor(message = 'Mail server rejected the login') { super(message); this.name = 'MailAuthError' }
}
export class MailSendError extends Error {
  constructor(message: string) { super(message); this.name = 'MailSendError' }
}

const SIMPLE_ADDRESS = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[^\s@<>(),;:"\[\]]+$/

function isAuthFailure(e: unknown): boolean {
  const err = e as { code?: string; responseCode?: number }
  return err?.code === 'EAUTH' || err?.responseCode === 535
}

function wrap(e: unknown): Error {
  if (isAuthFailure(e)) return new MailAuthError()
  // Only the error code is surfaced; server text could echo credentials.
  const code = (e as { code?: string })?.code
  return new MailSendError(code ? `Sending failed (${code})` : 'Sending failed')
}

export function createSmtpSender(cfg: MailSettings, password: string, opts?: { tls?: { rejectUnauthorized: boolean } }): MailSender {
  const domain = cfg.address.slice(cfg.address.lastIndexOf('@') + 1)
  // opts.tls is the test-only path for a plain local server; production never allows plaintext auth.
  const transport = nodemailer.createTransport(
    opts?.tls
      ? { host: cfg.smtpHost, port: cfg.smtpPort, secure: false, ignoreTLS: true, tls: opts.tls, auth: { user: cfg.address, pass: password } }
      : cfg.smtpPort === 465
        ? { host: cfg.smtpHost, port: cfg.smtpPort, secure: true, auth: { user: cfg.address, pass: password } }
        : { host: cfg.smtpHost, port: cfg.smtpPort, secure: false, requireTLS: true, auth: { user: cfg.address, pass: password } }
  )

  return {
    async send(m) {
      if (/[\r\n]/.test(m.to) || /[\r\n]/.test(m.subject)) throw new MailSendError('Recipient or subject contains a line break')
      if (!SIMPLE_ADDRESS.test(m.to)) throw new MailSendError('Recipient is not a single valid email address')
      const messageId = `<${randomUUID()}@${domain}>`
      try {
        await transport.sendMail({
          from: cfg.address,
          to: m.to,
          subject: m.subject,
          text: m.text,
          messageId,
          ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
          ...(m.references.length ? { references: m.references } : {}),
          ...(m.attachmentPath ? { attachments: [{ filename: basename(m.attachmentPath), path: m.attachmentPath }] } : {})
        })
      } catch (e) {
        throw wrap(e)
      }
      return { messageId, at: new Date().toISOString() }
    },
    async verify() {
      try { await transport.verify() } catch (e) { throw wrap(e) }
    }
  }
}
