import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { SecretKey } from '../../shared/types'

export interface SecretStore {
  get(k: SecretKey): string | null
  set(k: SecretKey, v: string): void
  has(k: SecretKey): boolean
  clearAll(): void
}

// The shape of Electron's safeStorage, injected so this module never imports electron.
export interface SafeStorageLike {
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
  isEncryptionAvailable(): boolean
}

export class SecretsUnavailableError extends Error {
  constructor() {
    super('Secure storage is not available on this system; secrets cannot be saved.')
    this.name = 'SecretsUnavailableError'
  }
}

export function createMemorySecretStore(): SecretStore {
  const m = new Map<SecretKey, string>()
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    has: (k) => m.has(k),
    clearAll: () => m.clear()
  }
}

export function createSafeStorageSecretStore(filePath: string, safe: SafeStorageLike): SecretStore {
  const requireEncryption = (): void => {
    if (!safe.isEncryptionAvailable()) throw new SecretsUnavailableError()
  }
  const load = (): Partial<Record<SecretKey, string>> => {
    if (!existsSync(filePath)) return {}
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Record<SecretKey, string>>
    } catch {
      return {}
    }
  }
  const save = (data: Partial<Record<SecretKey, string>>): void => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, filePath)
  }
  return {
    get(k) {
      const c = load()[k]
      if (c === undefined) return null
      requireEncryption()
      try {
        return safe.decryptString(Buffer.from(c, 'base64'))
      } catch {
        return null
      }
    },
    set(k, v) {
      requireEncryption()
      const data = load()
      data[k] = safe.encryptString(v).toString('base64')
      save(data)
    },
    has: (k) => load()[k] !== undefined,
    clearAll() {
      rmSync(filePath, { force: true })
    }
  }
}
