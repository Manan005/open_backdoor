import { rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Settings } from '../../shared/types'
import type { SecretStore } from '../secrets/secretStore'

export function defaultSettings(): Settings {
  return {
    ai: null,
    mail: null,
    dailyCap: 10,
    picksPerDay: 4,
    pickTime: '08:00',
    attachResume: false,
    paused: false,
    pauseReason: null,
    searchProvider: null
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export function clampSettings(s: Settings): Settings {
  return { ...s, dailyCap: clamp(s.dailyCap, 1, 20), picksPerDay: clamp(s.picksPerDay, 3, 5) }
}

export function validateAiSettings(ai: NonNullable<Settings['ai']>): string | null {
  if (!ai.model.trim()) return 'Enter a model name.'
  if (ai.provider === 'custom') {
    let url: URL
    try {
      url = new URL(ai.baseUrl ?? '')
    } catch {
      return 'Enter a valid base URL (http or https).'
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Enter a valid base URL (http or https).'
  }
  return null
}

const UNSUPPORTED_MAIL = new Set(['outlook', 'hotmail', 'live', 'msn'])

// Matches the leading label of the domain, so country variants (hotmail.co.uk, outlook.in) are caught too.
export function isUnsupportedMailDomain(address: string): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase()
  return UNSUPPORTED_MAIL.has(domain.split('.')[0])
}

export function deleteEverything(deps: { db: DatabaseSync; secrets: SecretStore; appDataFiles: string[] }): void {
  const { db, secrets, appDataFiles } = deps
  db.exec('BEGIN')
  try {
    // Children first: foreign keys are enforced.
    for (const t of ['messages', 'leads', 'companies', 'kv']) db.exec(`DELETE FROM ${t}`)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  secrets.clearAll()
  for (const f of appDataFiles) rmSync(f, { force: true })
}
