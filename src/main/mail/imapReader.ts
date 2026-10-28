import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import type { MailSettings } from '../../shared/types'
import type { MetaRepo } from '../db/repos'
import { MailAuthError, type MailSender } from './smtpSender'

export interface ParsedMail {
  messageId: string; inReplyTo: string | null; references: string[]
  from: string; to: string[]; subject: string; text: string; date: string
  headers: Record<string, string>; mailbox: 'inbox' | 'sent'
}
/**
 * `fetchNew()` reads INBOX and Sent and persists nothing; it throws if either mailbox fails.
 * `commit()` persists the cursors computed by the last successful `fetchNew()`; call it only after
 * the returned mail has been handled. Mail fetched again after a missed commit is deduped by Message-ID.
 */
export interface MailReader { fetchNew(): Promise<ParsedMail[]>; commit(): void; verify(): Promise<void> }

/** `<id>` form: trimmed, brackets added when missing. */
function bracket(id: string): string {
  const t = id.trim()
  return t.startsWith('<') && t.endsWith('>') ? t : `<${t.replace(/^<|>$/g, '')}>`
}
function ids(v: string | string[] | undefined | null): string[] {
  if (!v) return []
  return (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(/\s+/)).filter(Boolean).map(bracket)
}
function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return []
  return (Array.isArray(a) ? a : [a]).flatMap((o) => o.value.map((v) => v.address?.toLowerCase() ?? '')).filter(Boolean)
}
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim()
}
function flattenHeader(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(flattenHeader).filter((x) => x !== null).join(', ')
  if (v && typeof v === 'object') {
    const o = v as { text?: string; value?: unknown; params?: Record<string, string> }
    if (typeof o.text === 'string') return o.text
    if (typeof o.value === 'string') return [o.value, ...Object.entries(o.params ?? {}).map(([k, p]) => `${k}=${p}`)].join('; ')
  }
  return null
}

export async function parseMail(raw: Buffer | string, mailbox: 'inbox' | 'sent'): Promise<ParsedMail> {
  const p = await simpleParser(raw)
  const headers: Record<string, string> = {}
  for (const [k, v] of p.headers) {
    const s = flattenHeader(v)
    if (s !== null) headers[k.toLowerCase()] = s
  }
  let text = p.text ?? (typeof p.html === 'string' ? stripHtml(p.html) : '')
  // A bounce's machine-readable report (Final-Recipient, Status) lives in a message/delivery-status part.
  for (const att of p.attachments) {
    if (att.contentType === 'message/delivery-status') text += `\n${att.content.toString('utf8')}`
  }
  return {
    messageId: p.messageId ? bracket(p.messageId) : '',
    inReplyTo: p.inReplyTo ? bracket(p.inReplyTo) : null,
    references: ids(p.references),
    from: addresses(p.from)[0] ?? '',
    to: addresses(p.to),
    subject: p.subject ?? '',
    text,
    date: (p.date ?? new Date(0)).toISOString(),
    headers,
    mailbox
  }
}

export async function testMailbox(sender: MailSender, reader: MailReader, address: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await sender.send({ to: address, subject: 'Sidedoor test email', text: 'This confirms Sidedoor can send and read mail.', inReplyTo: null, references: [], attachmentPath: null })
    await reader.verify()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const DAY_MS = 86_400_000
const TIMEOUT_MS = 20_000

function isAuthFailure(e: unknown): boolean {
  const err = e as { authenticationFailed?: boolean; code?: string }
  return err?.authenticationFailed === true || err?.code === 'AUTHENTICATIONFAILED'
}

/** Thin imapflow wrapper; verified manually. Read-only mailbox lock and `source` fetch (BODY.PEEK), so nothing is marked \Seen. */
export function createImapReader(cfg: MailSettings, password: string, meta: MetaRepo): MailReader {
  const open = async () => {
    const client = new ImapFlow({
      host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993,
      auth: { user: cfg.address, pass: password }, logger: false,
      connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS * 3
    })
    // imapflow emits 'error' on socket failures; without a listener that would crash the process.
    client.on('error', () => {})
    try { await client.connect() } catch (e) { throw isAuthFailure(e) ? new MailAuthError() : e }
    return client
  }

  let pending: { key: string; uid: number; validityKey: string; uidValidity: number }[] = []

  async function readMailbox(client: ImapFlow, path: string, mailbox: 'inbox' | 'sent'): Promise<ParsedMail[]> {
    const lock = await client.getMailboxLock(path, { readOnly: true })
    try {
      const uidValidity = Number(client.mailbox ? client.mailbox.uidValidity : 0)
      const uidNext = Number(client.mailbox ? client.mailbox.uidNext : 1)
      const lastKey = `imap.lastUid.${mailbox}`, validityKey = `imap.uidValidity.${mailbox}`
      const stored = meta.get<number>(lastKey)
      const valid = stored !== null && meta.get<number>(validityKey) === uidValidity
      const last = valid ? stored : 0
      const found = valid
        ? await client.search({ uid: `${last + 1}:*` }, { uid: true })
        : await client.search({ since: new Date(Date.now() - 7 * DAY_MS) }, { uid: true })
      // `N:*` always includes the highest existing UID, even when it is not above N.
      const fresh = (found || []).filter((u) => u > last).sort((a, b) => a - b)
      const out: ParsedMail[] = []
      for (const uid of fresh) {
        // Transport errors from fetchOne propagate (fetchNew then persists nothing); `false` means the message was expunged.
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
        if (!msg || !msg.source) continue
        try {
          out.push(await parseMail(msg.source, mailbox))
        } catch {
          // One unparsable message must not block the cursor forever; skip it.
        }
      }
      // A quiet reset stores the highest existing UID so the next poll doesn't download the whole mailbox.
      const cursor = fresh.length ? fresh[fresh.length - 1] : valid ? last : Number.isFinite(uidNext) ? Math.max(uidNext - 1, 0) : null
      if (cursor !== null) pending.push({ key: lastKey, uid: cursor, validityKey, uidValidity })
      return out
    } finally {
      lock.release()
    }
  }

  return {
    async verify() {
      const client = await open()
      try {
        for (const path of ['INBOX', cfg.sentMailbox]) (await client.getMailboxLock(path, { readOnly: true })).release()
      } catch (e) {
        if (isAuthFailure(e)) throw new MailAuthError()
        throw new Error(`Could not open the INBOX and "${cfg.sentMailbox}" folders on ${cfg.imapHost}. Check the Sent folder name.`)
      } finally {
        await client.logout().catch(() => {})
      }
    },
    commit() {
      for (const p of pending) { meta.set(p.key, p.uid); meta.set(p.validityKey, p.uidValidity) }
      pending = []
    },
    async fetchNew() {
      pending = []
      const client = await open()
      try {
        const inbox = await readMailbox(client, 'INBOX', 'inbox')
        const sent = await readMailbox(client, cfg.sentMailbox, 'sent')
        return [...inbox, ...sent]
      } catch (e) {
        pending = []
        throw isAuthFailure(e) ? new MailAuthError() : e
      } finally {
        await client.logout().catch(() => {})
      }
    }
  }
}
