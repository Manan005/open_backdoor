import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../../src/main/db/database'
import {
  CompanyRepo,
  LeadRepo,
  MessageRepo,
  MetaRepo,
  ProfileRepo,
  SettingsRepo
} from '../../../src/main/db/repos'
import type {
  Candidate,
  Contact,
  Draft,
  Lead,
  Profile,
  Settings,
  Signal
} from '../../../src/shared/types'

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  name: 'Acme',
  website: 'https://acme.io',
  description: 'Rockets',
  signals: [],
  country: 'IN',
  city: null,
  remote: null,
  stage: 'seed',
  emails: [],
  ...over
})
const signal = (url: string, kind: Signal['kind'] = 'raised'): Signal => ({
  kind,
  detail: 'x',
  date: null,
  sourceId: 'hn',
  url
})
const defaults = (): Settings => ({
  ai: null,
  mail: null,
  dailyCap: 10,
  picksPerDay: 4,
  pickTime: '08:00',
  attachResume: true,
  paused: false,
  pauseReason: null,
  searchProvider: null
})
const newLead = (
  companyId: number,
  over: Partial<Lead> = {}
): Omit<Lead, 'id' | 'createdAt' | 'updatedAt'> => ({
  companyId,
  status: 'queued',
  fitScore: 80,
  whyFit: 'fits',
  contact: null,
  draft: null,
  followUpsSent: 0,
  nextActionAt: null,
  needsApproval: false,
  firstSentAt: null,
  lastError: null,
  ...over
})

let db: DatabaseSync
beforeEach(() => {
  db = openDatabase(':memory:')
})

describe('database', () => {
  it('migrations are idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidedoor-db-'))
    const file = join(dir, 'a.db')
    try {
      const a = openDatabase(file)
      a.close()
      const b = openDatabase(file)
      const v = b.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(v.user_version).toBe(1)
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CompanyRepo', () => {
  it('company upsert merges signals by url', () => {
    const repo = new CompanyRepo(db)
    const a = repo.upsert(
      candidate({ signals: [signal('u1')], emails: [{ email: 'a@acme.io', url: 'p1' }] }),
      'acme.io'
    )
    const b = repo.upsert(
      candidate({
        signals: [signal('u1'), signal('u2', 'hiring')],
        emails: [
          { email: 'a@acme.io', url: 'p2' },
          { email: 'b@acme.io', url: 'p2' }
        ]
      }),
      'acme.io'
    )
    expect(b.id).toBe(a.id)
    expect(b.signals.map((s) => s.url)).toEqual(['u1', 'u2'])
    expect(b.emails.map((e) => e.email)).toEqual(['a@acme.io', 'b@acme.io'])
    const n = db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }
    expect(n.n).toBe(1)
    expect(repo.byKey('acme.io')?.id).toBe(a.id)
    expect(repo.byKey('nope')).toBeNull()
    expect(repo.byId(a.id).domainKey).toBe('acme.io')
  })

  it('upsert keeps existing fields when the new candidate has nulls', () => {
    const repo = new CompanyRepo(db)
    repo.upsert(candidate({ city: 'Pune', remote: true }), 'acme.io')
    const b = repo.upsert(
      candidate({ city: null, remote: null, stage: null, website: null }),
      'acme.io'
    )
    expect(b.city).toBe('Pune')
    expect(b.remote).toBe(true)
    expect(b.stage).toBe('seed')
    expect(b.website).toBe('https://acme.io')
  })
})

describe('LeadRepo', () => {
  const contact: Contact = {
    email: 'f@acme.io',
    name: 'Fay',
    role: 'CEO',
    kind: 'founder',
    sourceUrl: 'p'
  }
  const draft: Draft = { subject: 's', body: 'b', startupDetail: 'sd', userDetail: 'ud' }
  let companyId: number
  let repo: LeadRepo
  beforeEach(() => {
    companyId = new CompanyRepo(db).upsert(candidate(), 'acme.io').id
    repo = new LeadRepo(db)
  })

  it('lead round-trips contact and draft JSON', () => {
    const l = repo.create(newLead(companyId, { contact, draft, needsApproval: true }))
    const got = repo.get(l.id)
    expect(got.contact).toEqual(contact)
    expect(got.draft).toEqual(draft)
    expect(got.needsApproval).toBe(true)
    const up = repo.update(l.id, {
      status: 'sent',
      draft: null,
      followUpsSent: 2,
      lastError: 'boom'
    })
    expect(up.status).toBe('sent')
    expect(up.draft).toBeNull()
    expect(up.contact).toEqual(contact)
    expect(up.followUpsSent).toBe(2)
    expect(up.lastError).toBe('boom')
  })

  it('lists and looks up leads', () => {
    const a = repo.create(newLead(companyId, { contact, status: 'drafted' }))
    const b = repo.create(newLead(companyId, { status: 'queued' }))
    expect(repo.list().length).toBe(2)
    expect(repo.list({ status: ['queued'] }).map((l) => l.id)).toEqual([b.id])
    expect(repo.queued().map((l) => l.id)).toEqual([b.id])
    expect(repo.byCompany(companyId).length).toBe(2)
    expect(repo.byContactEmail('f@acme.io').map((l) => l.id)).toEqual([a.id])
  })

  it('firstSentCountBetween counts only leads with firstSentAt in range', () => {
    repo.create(newLead(companyId, { status: 'sent', firstSentAt: '2026-10-27T10:00:00.000Z' }))
    repo.create(newLead(companyId, { status: 'sent', firstSentAt: '2026-10-28T10:00:00.000Z' }))
    repo.create(newLead(companyId, { status: 'queued', firstSentAt: null }))
    expect(repo.firstSentCountBetween('2026-10-27T00:00:00.000Z', '2026-10-28T00:00:00.000Z')).toBe(
      1
    )
  })

  it('dueFollowUps excludes needsApproval and followUpsSent=3', () => {
    const due = '2026-10-27T09:00:00.000Z'
    const ok = repo.create(newLead(companyId, { status: 'sent', nextActionAt: due }))
    repo.create(newLead(companyId, { status: 'sent', nextActionAt: due, needsApproval: true }))
    repo.create(newLead(companyId, { status: 'sent', nextActionAt: due, followUpsSent: 3 }))
    repo.create(newLead(companyId, { status: 'sent', nextActionAt: '2026-10-29T00:00:00.000Z' }))
    repo.create(newLead(companyId, { status: 'replied', nextActionAt: due }))
    expect(repo.dueFollowUps('2026-10-27T12:00:00.000Z').map((l) => l.id)).toEqual([ok.id])
  })
})

describe('MessageRepo', () => {
  it('messages.byMessageId finds inserted message', () => {
    const cid = new CompanyRepo(db).upsert(candidate(), 'acme.io').id
    const lead = new LeadRepo(db).create(newLead(cid))
    const repo = new MessageRepo(db)
    const m = repo.insert({
      leadId: lead.id,
      direction: 'out',
      kind: 'first',
      messageId: '<m1@x>',
      inReplyTo: null,
      references: ['<r0@x>'],
      from: 'me@x.io',
      to: 'f@acme.io',
      subject: 's',
      text: 't',
      at: '2026-10-27T10:00:00.000Z'
    })
    expect(repo.byMessageId('<m1@x>')).toEqual(m)
    expect(repo.byMessageId('<zz>')).toBeNull()
    expect(repo.byLead(lead.id)).toEqual([m])
  })
})

describe('kv repos', () => {
  it('SettingsRepo returns defaults then saved value', () => {
    const repo = new SettingsRepo(db, defaults)
    expect(repo.get()).toEqual(defaults())
    repo.save({ ...defaults(), dailyCap: 15 })
    expect(repo.get().dailyCap).toBe(15)
  })

  it('ProfileRepo round-trips', () => {
    const repo = new ProfileRepo(db)
    expect(repo.get()).toBeNull()
    const p = { name: 'Me', skills: ['ts'] } as unknown as Profile
    repo.save(p)
    expect(repo.get()).toEqual(p)
  })

  it('MetaRepo get/set/clearAll leaves profile and settings alone', () => {
    const meta = new MetaRepo(db)
    expect(meta.get('k')).toBeNull()
    meta.set('k', { a: 1 })
    expect(meta.get<{ a: number }>('k')).toEqual({ a: 1 })
    new ProfileRepo(db).save({ name: 'Me' } as unknown as Profile)
    meta.clearAll()
    expect(meta.get('k')).toBeNull()
    expect(new ProfileRepo(db).get()).not.toBeNull()
  })
})
