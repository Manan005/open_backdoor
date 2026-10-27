import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../../src/main/db/database'
import { CompanyRepo, LeadRepo, MessageRepo } from '../../../src/main/db/repos'
import {
  clampSettings,
  defaultSettings,
  deleteEverything,
  isUnsupportedMailDomain,
  validateAiSettings
} from '../../../src/main/settings/settings'
import {
  SecretsUnavailableError,
  createMemorySecretStore,
  createSafeStorageSecretStore
} from '../../../src/main/secrets/secretStore'

const tmp = () => mkdtempSync(join(tmpdir(), 'sidedoor-'))
const reverse = (s: string) => [...s].reverse().join('')
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(reverse(s), 'utf8'),
  decryptString: (b: Buffer) => reverse(b.toString('utf8'))
})

describe('clampSettings', () => {
  it('clamp caps dailyCap at 20 and floors at 1', () => {
    expect(clampSettings({ ...defaultSettings(), dailyCap: 99 }).dailyCap).toBe(20)
    expect(clampSettings({ ...defaultSettings(), dailyCap: 0 }).dailyCap).toBe(1)
    expect(clampSettings({ ...defaultSettings(), dailyCap: 7 }).dailyCap).toBe(7)
  })
  it('clamp picksPerDay to 3..5', () => {
    expect(clampSettings({ ...defaultSettings(), picksPerDay: 1 }).picksPerDay).toBe(3)
    expect(clampSettings({ ...defaultSettings(), picksPerDay: 9 }).picksPerDay).toBe(5)
    expect(clampSettings({ ...defaultSettings(), picksPerDay: 4 }).picksPerDay).toBe(4)
  })
  it('defaults match the spec', () => {
    expect(defaultSettings()).toEqual({
      ai: null, mail: null, dailyCap: 10, picksPerDay: 4, pickTime: '08:00',
      attachResume: false, paused: false, pauseReason: null, searchProvider: null
    })
  })
})

describe('validateAiSettings', () => {
  it('custom AI needs a valid base URL and model', () => {
    expect(validateAiSettings({ provider: 'custom', model: 'x', baseUrl: null })).not.toBeNull()
    expect(validateAiSettings({ provider: 'custom', model: 'x', baseUrl: 'ftp://x' })).not.toBeNull()
    expect(validateAiSettings({ provider: 'custom', model: 'x', baseUrl: 'not a url' })).not.toBeNull()
    expect(validateAiSettings({ provider: 'custom', model: '', baseUrl: 'http://localhost:20128/v1' })).not.toBeNull()
    expect(validateAiSettings({ provider: 'custom', model: 'x', baseUrl: 'http://localhost:20128/v1' })).toBeNull()
    expect(validateAiSettings({ provider: 'custom', model: 'x', baseUrl: 'https://api.example.com/v1/' })).toBeNull()
  })
  it('every provider needs a model', () => {
    expect(validateAiSettings({ provider: 'openai', model: '  ', baseUrl: null })).not.toBeNull()
    expect(validateAiSettings({ provider: 'openai', model: 'gpt-x', baseUrl: null })).toBeNull()
  })
})

describe('isUnsupportedMailDomain', () => {
  it('outlook.com, hotmail.co.uk, live.com rejected; gmail.com, zoho.in accepted', () => {
    for (const a of ['a@outlook.com', 'a@hotmail.co.uk', 'a@live.com', 'a@msn.com', 'a@outlook.in', 'A@Outlook.COM'])
      expect(isUnsupportedMailDomain(a)).toBe(true)
    for (const a of ['a@gmail.com', 'a@zoho.in', 'a@outlookish.com'])
      expect(isUnsupportedMailDomain(a)).toBe(false)
  })
})

describe('secret stores', () => {
  it('safeStorage store round-trips and file contains no plaintext', () => {
    const dir = tmp()
    try {
      const file = join(dir, 'secrets.json')
      const s = createSafeStorageSecretStore(file, fakeSafe())
      expect(s.has('ai.apiKey')).toBe(false)
      expect(s.get('ai.apiKey')).toBeNull()
      s.set('ai.apiKey', 'sk-super-secret')
      s.set('mail.password', 'hunter2hunter2')
      expect(s.get('ai.apiKey')).toBe('sk-super-secret')
      expect(s.has('ai.apiKey')).toBe(true)
      const raw = readFileSync(file, 'utf8')
      expect(raw).not.toContain('sk-super-secret')
      expect(raw).not.toContain(reverse('sk-super-secret'))
      expect(raw).not.toContain('hunter2')
      const again = createSafeStorageSecretStore(file, fakeSafe())
      expect(again.get('mail.password')).toBe('hunter2hunter2')
      again.clearAll()
      expect(again.has('mail.password')).toBe(false)
      expect(createSafeStorageSecretStore(file, fakeSafe()).has('ai.apiKey')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('throws when encryption unavailable', () => {
    const dir = tmp()
    try {
      const s = createSafeStorageSecretStore(join(dir, 's.json'), fakeSafe(false))
      expect(() => s.set('ai.apiKey', 'x')).toThrow(SecretsUnavailableError)
      expect(existsSync(join(dir, 's.json'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('memory store works', () => {
    const s = createMemorySecretStore()
    s.set('github.token', 't')
    expect(s.get('github.token')).toBe('t')
    s.clearAll()
    expect(s.has('github.token')).toBe(false)
  })
})

describe('deleteEverything', () => {
  it('leaves empty tables and no secrets', () => {
    const dir = tmp()
    try {
      const db = openDatabase(join(dir, 'app.db'))
      const companies = new CompanyRepo(db)
      const leads = new LeadRepo(db)
      const messages = new MessageRepo(db)
      const c = companies.upsert({
        name: 'Acme', website: 'https://acme.io', description: 'd', signals: [], country: null,
        city: null, remote: null, stage: null, emails: []
      }, 'acme.io')
      const lead = leads.create({
        companyId: c.id, status: 'picked', fitScore: 1, whyFit: 'w', contact: null, draft: null,
        followUpsSent: 0, nextActionAt: null, needsApproval: false, firstSentAt: null, lastError: null
      })
      messages.insert({
        leadId: lead.id, direction: 'out', kind: 'first', messageId: '<1@x>', inReplyTo: null,
        references: [], from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', at: new Date().toISOString()
      })
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('k', 'v')
      const secrets = createMemorySecretStore()
      secrets.set('ai.apiKey', 'k')
      const resume = join(dir, 'resume.pdf')
      writeFileSync(resume, 'x')
      deleteEverything({ db, secrets, appDataFiles: [resume, join(dir, 'missing.pdf')] })
      for (const t of ['kv', 'companies', 'leads', 'messages'])
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0)
      expect(secrets.has('ai.apiKey')).toBe(false)
      expect(existsSync(resume)).toBe(false)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
