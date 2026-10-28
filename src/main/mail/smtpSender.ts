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
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MailSendError'
  }
}

const SIMPLE_ADDRESS = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[^\s@<>(),;:"\[\]]+$/
const UNREACHABLE = new Set(['ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'ESOCKETTIMEDOUT'])
const TIMEOUT_MS = 20_000

function isAuthFailure(e: unknown): boolean {
  const err = e as { code?: string; responseCode?: number }
  return err?.code === 'EAUTH' || err?.responseCode === 535
}

// Messages are fixed sentences plus host/port; server text is never echoed (it could contain credentials).
// The original error is kept as `cause` for logging only.
function wrap(e: unknown, cfg: MailSettings, verifying: boolean): Error {
  if (isAuthFailure(e)) return new MailAuthError()
  const err = e as { code?: string; message?: string }
  const code = err?.code
  let message: string
  const text = err?.message ?? ''
  if ((code && UNREACHABLE.has(code)) || (code === 'ESOCKET' && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/.test(text))) message = `Could not reach ${cfg.smtpHost}:${cfg.smtpPort}.`
  else if (code === 'ETLS' || (code === 'ESOCKET' && /tls|ssl|certificate|starttls|self.signed|wrong version/i.test(text))) {
    message = `Secure connection to ${cfg.smtpHost} failed.`
  } else if (code === 'EENVELOPE') message = 'The server rejected the recipient address.'
  else message = `${verifying ? 'Could not connect' : 'Sending failed'}${code ? ` (${code})` : ''}.`
  return new MailSendError(message, e)
}

/** `opts.insecurePlaintextForTests` talks plain SMTP to a local test server. Never set it in production. */
export function createSmtpSender(cfg: MailSettings, password: string, opts?: { insecurePlaintextForTests?: boolean }): MailSender {
  const domain = cfg.address.slice(cfg.address.lastIndexOf('@') + 1)
  const common = {
    host: cfg.smtpHost, port: cfg.smtpPort, auth: { user: cfg.address, pass: password },
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS
  }
  // Production never allows plaintext auth: 465 is implicit TLS, anything else must upgrade via STARTTLS.
  const transport = nodemailer.createTransport(
    opts?.insecurePlaintextForTests
      ? { ...common, secure: false, ignoreTLS: true }
      : cfg.smtpPort === 465
        ? { ...common, secure: true }
        : { ...common, secure: false, requireTLS: true }
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
        throw wrap(e, cfg, false)
      }
      return { messageId, at: new Date().toISOString() }
    },
    async verify() {
      try { await transport.verify() } catch (e) { throw wrap(e, cfg, true) }
    }
  }
}
