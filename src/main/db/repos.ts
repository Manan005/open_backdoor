import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  Candidate,
  Company,
  Contact,
  Draft,
  FoundEmail,
  Lead,
  LeadStatus,
  MailMessage,
  Profile,
  Settings,
  Signal,
  Stage
} from '../../shared/types'

type Row = Record<string, unknown>

const json = (v: unknown): string => JSON.stringify(v)
const parse = <T>(s: unknown): T => JSON.parse(s as string) as T
const parseOrNull = <T>(s: unknown): T | null => (s == null ? null : parse<T>(s))
const now = (): string => new Date().toISOString()
const boolToInt = (b: boolean | null): number | null => (b == null ? null : b ? 1 : 0)

function mergeBy<T>(a: T[], b: T[], key: (t: T) => string): T[] {
  const seen = new Set(a.map(key))
  const out = [...a]
  for (const t of b) {
    const k = key(t)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(t)
    }
  }
  return out
}

class KvRepo {
  constructor(protected db: DatabaseSync) {}
  protected read(key: string): unknown {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined
    return r ? JSON.parse(r.value as string) : null
  }
  protected write(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, json(value))
  }
}

export class ProfileRepo extends KvRepo {
  get(): Profile | null {
    return this.read('profile') as Profile | null
  }
  save(p: Profile): void {
    this.write('profile', p)
  }
}

export class SettingsRepo extends KvRepo {
  constructor(
    db: DatabaseSync,
    private defaults: () => Settings
  ) {
    super(db)
  }
  get(): Settings {
    return (this.read('settings') as Settings | null) ?? this.defaults()
  }
  save(s: Settings): void {
    this.write('settings', s)
  }
}

const META_PREFIX = 'meta:'

export class MetaRepo extends KvRepo {
  get<T>(key: string): T | null {
    return this.read(META_PREFIX + key) as T | null
  }
  set(key: string, value: unknown): void {
    this.write(META_PREFIX + key, value)
  }
  // Only meta keys: profile and settings share the kv table but are not meta.
  clearAll(): void {
    this.db.prepare('DELETE FROM kv WHERE key LIKE ?').run(META_PREFIX + '%')
  }
}

function companyFromRow(r: Row): Company {
  return {
    id: r.id as number,
    domainKey: r.domain_key as string,
    name: r.name as string,
    website: r.website as string | null,
    description: r.description as string,
    signals: parse<Signal[]>(r.signals),
    country: r.country as string | null,
    city: r.city as string | null,
    remote: r.remote == null ? null : r.remote === 1,
    stage: r.stage as Stage | null,
    emails: parse<FoundEmail[]>(r.emails),
    createdAt: r.created_at as string
  }
}

export class CompanyRepo {
  constructor(private db: DatabaseSync) {}

  upsert(c: Candidate, domainKey: string): Company {
    const existing = this.byKey(domainKey)
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO companies (domain_key, name, website, description, signals, country, city, remote, stage, emails, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          domainKey,
          c.name,
          c.website,
          c.description,
          json(c.signals),
          c.country,
          c.city,
          boolToInt(c.remote),
          c.stage,
          json(c.emails),
          now()
        )
      return this.byKey(domainKey) as Company
    }
    // Keep what we already know; new data fills gaps and adds signals/emails.
    const m = {
      website: existing.website ?? c.website,
      description: c.description || existing.description,
      signals: mergeBy(existing.signals, c.signals, (s) => s.url),
      country: existing.country ?? c.country,
      city: existing.city ?? c.city,
      remote: existing.remote ?? c.remote,
      stage:
        existing.stage && existing.stage !== 'unknown'
          ? existing.stage
          : (c.stage ?? existing.stage),
      emails: mergeBy(existing.emails, c.emails, (e) => e.email.toLowerCase())
    }
    this.db
      .prepare(
        `UPDATE companies SET website = ?, description = ?, signals = ?, country = ?, city = ?, remote = ?, stage = ?, emails = ?
         WHERE id = ?`
      )
      .run(
        m.website,
        m.description,
        json(m.signals),
        m.country,
        m.city,
        boolToInt(m.remote),
        m.stage,
        json(m.emails),
        existing.id
      )
    return this.byId(existing.id)
  }

  byKey(k: string): Company | null {
    const r = this.db.prepare('SELECT * FROM companies WHERE domain_key = ?').get(k) as
      Row | undefined
    return r ? companyFromRow(r) : null
  }

  byId(id: number): Company {
    const r = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new Error(`Company ${id} not found`)
    return companyFromRow(r)
  }
}

function leadFromRow(r: Row): Lead {
  return {
    id: r.id as number,
    companyId: r.company_id as number,
    status: r.status as LeadStatus,
    fitScore: r.fit_score as number,
    whyFit: r.why_fit as string,
    contact: parseOrNull<Contact>(r.contact),
    draft: parseOrNull<Draft>(r.draft),
    followUpsSent: r.follow_ups_sent as Lead['followUpsSent'],
    nextActionAt: r.next_action_at as string | null,
    needsApproval: r.needs_approval === 1,
    firstSentAt: r.first_sent_at as string | null,
    lastError: r.last_error as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}

export class LeadRepo {
  constructor(private db: DatabaseSync) {}

  create(l: Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>): Lead {
    const t = now()
    const res = this.db
      .prepare(
        `INSERT INTO leads (company_id, status, fit_score, why_fit, contact, draft, follow_ups_sent, next_action_at,
           needs_approval, first_sent_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        l.companyId,
        l.status,
        l.fitScore,
        l.whyFit,
        l.contact ? json(l.contact) : null,
        l.draft ? json(l.draft) : null,
        l.followUpsSent,
        l.nextActionAt,
        l.needsApproval ? 1 : 0,
        l.firstSentAt,
        l.lastError,
        t,
        t
      )
    return this.get(Number(res.lastInsertRowid))
  }

  get(id: number): Lead {
    const r = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new Error(`Lead ${id} not found`)
    return leadFromRow(r)
  }

  update(id: number, patch: Partial<Lead>): Lead {
    const l = { ...this.get(id), ...patch }
    this.db
      .prepare(
        `UPDATE leads SET company_id = ?, status = ?, fit_score = ?, why_fit = ?, contact = ?, draft = ?,
           follow_ups_sent = ?, next_action_at = ?, needs_approval = ?, first_sent_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        l.companyId,
        l.status,
        l.fitScore,
        l.whyFit,
        l.contact ? json(l.contact) : null,
        l.draft ? json(l.draft) : null,
        l.followUpsSent,
        l.nextActionAt,
        l.needsApproval ? 1 : 0,
        l.firstSentAt,
        l.lastError,
        now(),
        id
      )
    return this.get(id)
  }

  private query(where: string, ...params: SQLInputValue[]): Lead[] {
    const rows = this.db.prepare(`SELECT * FROM leads ${where} ORDER BY id`).all(...params) as Row[]
    return rows.map(leadFromRow)
  }

  list(f?: { status?: LeadStatus[] }): Lead[] {
    if (f?.status) {
      if (f.status.length === 0) return []
      return this.query(`WHERE status IN (${f.status.map(() => '?').join(',')})`, ...f.status)
    }
    return this.query('')
  }

  byCompany(companyId: number): Lead[] {
    return this.query('WHERE company_id = ?', companyId)
  }

  byContactEmail(email: string): Lead[] {
    return this.query("WHERE lower(json_extract(contact, '$.email')) = lower(?)", email)
  }

  firstSentCountBetween(startIso: string, endIso: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM leads WHERE first_sent_at >= ? AND first_sent_at < ?')
      .get(startIso, endIso) as { n: number }
    return r.n
  }

  dueFollowUps(nowIso: string): Lead[] {
    return this.query(
      "WHERE status = 'sent' AND follow_ups_sent < 3 AND next_action_at IS NOT NULL AND next_action_at <= ? AND needs_approval = 0",
      nowIso
    )
  }

  queued(): Lead[] {
    return this.query("WHERE status = 'queued'")
  }
}

function messageFromRow(r: Row): MailMessage {
  return {
    id: r.id as number,
    leadId: r.lead_id as number,
    direction: r.direction as MailMessage['direction'],
    kind: r.kind as MailMessage['kind'],
    messageId: r.message_id as string,
    inReplyTo: r.in_reply_to as string | null,
    references: parse<string[]>(r.refs),
    from: r.from_addr as string,
    to: r.to_addr as string,
    subject: r.subject as string,
    text: r.text as string,
    at: r.at as string
  }
}

export class MessageRepo {
  constructor(private db: DatabaseSync) {}

  insert(m: Omit<MailMessage, 'id'>): MailMessage {
    const res = this.db
      .prepare(
        `INSERT INTO messages (lead_id, direction, kind, message_id, in_reply_to, refs, from_addr, to_addr, subject, text, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.leadId,
        m.direction,
        m.kind,
        m.messageId,
        m.inReplyTo,
        json(m.references),
        m.from,
        m.to,
        m.subject,
        m.text,
        m.at
      )
    const r = this.db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as Row
    return messageFromRow(r)
  }

  byLead(leadId: number): MailMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY at, id')
      .all(leadId) as Row[]
    return rows.map(messageFromRow)
  }

  byMessageId(mid: string): MailMessage | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(mid) as
      Row | undefined
    return r ? messageFromRow(r) : null
  }
}
