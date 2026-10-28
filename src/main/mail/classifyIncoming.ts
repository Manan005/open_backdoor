import type { Lead, MailMessage } from '../../shared/types'
import type { ParsedMail } from './imapReader'

export type Classified =
  | { kind: 'reply' | 'ooo' | 'user'; leadId: number; mail: ParsedMail }
  | { kind: 'bounce'; leadId: number; failedRecipient: string; mail: ParsedMail }
  | { kind: 'unrelated' }

export interface ClassifyLookup {
  byMessageId(mid: string): MailMessage | null
  byContactEmail(email: string): Lead[]
}

const UNRELATED: Classified = { kind: 'unrelated' }
const OOO_SUBJECT = /out of (the )?office|automatic reply|auto-?reply|on vacation|away from/i
const EMAIL = /[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[^\s<>(),;:"'[\]]+/g

/** The thread's known outgoing message, looked up through In-Reply-To first, then References (newest first). */
function threadMessage(mail: ParsedMail, lookup: ClassifyLookup): MailMessage | null {
  const ids = [...(mail.inReplyTo ? [mail.inReplyTo] : []), ...[...mail.references].reverse()]
  for (const id of ids) {
    const hit = lookup.byMessageId(id)
    if (hit) return hit
  }
  return null
}

function isBounce(mail: ParsedMail): boolean {
  const ct = (mail.headers['content-type'] ?? '').toLowerCase()
  return /mailer-daemon|postmaster/i.test(mail.from) || (ct.includes('multipart/report') && ct.includes('report-type=delivery-status'))
}

function failedRecipients(mail: ParsedMail): string[] {
  const header = mail.headers['x-failed-recipients']
  const found = header ? header.match(EMAIL) ?? [] : []
  if (found.length) return found
  const m = /Final-Recipient:\s*[^;\r\n]*;\s*<?([^\s<>\r\n]+)>?/i.exec(mail.text)
  return m ? [m[1]] : []
}

/** Delivery-status verdict: true = permanent failure, false = delay or other non-failure, null = no report fields at all. */
function permanentFailure(mail: ParsedMail): boolean | null {
  const action = /^Action:\s*(\w+)/im.exec(mail.text)?.[1]?.toLowerCase()
  const status = /^Status:\s*(\d)\.\d+\.\d+/im.exec(mail.text)?.[1]
  if (action === undefined && status === undefined) return null
  return action === 'failed' || status === '5'
}

function isAutoReply(mail: ParsedMail): boolean {
  const h = mail.headers
  const auto = h['auto-submitted']
  if (auto !== undefined && auto.trim().toLowerCase() !== 'no') return true
  if ('x-autoreply' in h || 'x-autorespond' in h) return true
  if (/auto_?reply/i.test(h['precedence'] ?? '')) return true
  return OOO_SUBJECT.test(mail.subject)
}

export function classifyIncoming(mail: ParsedMail, lookup: ClassifyLookup, ownOutgoingIds: (mid: string) => boolean): Classified {
  if (mail.mailbox === 'sent') {
    const hit = threadMessage(mail, lookup)
    return hit && !ownOutgoingIds(mail.messageId) ? { kind: 'user', leadId: hit.leadId, mail } : UNRELATED
  }

  if (isBounce(mail)) {
    // A delay notice (Action: delayed / Status 4.x.x) is not a bounce; the message may still be delivered.
    if (permanentFailure(mail) === false) return UNRELATED
    const failed = failedRecipients(mail).map((r) => r.toLowerCase())
    for (const failedRecipient of failed) {
      const lead = lookup.byContactEmail(failedRecipient)[0]
      if (lead) return { kind: 'bounce', leadId: lead.id, failedRecipient, mail }
    }
    // The failed address may differ from the stored contact (alias, forward); fall back to the thread.
    const hit = threadMessage(mail, lookup)
    return hit ? { kind: 'bounce', leadId: hit.leadId, failedRecipient: failed[0] ?? '', mail } : UNRELATED
  }

  // Thread headers first: a co-founder or a personal address still matches. Sender address is only a fallback.
  let leadId = threadMessage(mail, lookup)?.leadId ?? null
  if (leadId === null && /^\s*re:/i.test(mail.subject)) leadId = lookup.byContactEmail(mail.from)[0]?.id ?? null
  if (leadId === null) return UNRELATED
  return { kind: isAutoReply(mail) ? 'ooo' : 'reply', leadId, mail }
}
