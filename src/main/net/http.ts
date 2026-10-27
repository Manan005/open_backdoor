export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number }
) => Promise<{ status: number; text: string; url: string }>

export class BlockedDomainError extends Error {
  constructor(public readonly host: string) {
    super(`Fetching ${host} is not allowed.`)
    this.name = 'BlockedDomainError'
  }
}

const USER_AGENT = 'Sidedoor/0.1 (+https://github.com/<owner>/sidedoor)'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
export const BLOCKED_HOSTS = ['linkedin.com', 'crunchbase.com', 'wellfound.com', 'angel.co']
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-subscription-token'])

function assertAllowed(url: string): void {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTS.some((b) => host === b || host.endsWith('.' + b))) throw new BlockedDomainError(host)
}

// Wraps fetch with the Sidedoor user agent, a timeout and the blocked-domain guard.
// Redirects are followed by hand so every hop is checked, not just the first URL.
export function createFetcher(baseFetch: typeof fetch = fetch): Fetcher {
  return async (url, init) => {
    const signal = AbortSignal.timeout(init?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let current = url
    let method = init?.method
    let body = init?.body
    let headers: Record<string, string> = { 'User-Agent': USER_AGENT, ...init?.headers }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertAllowed(current)
      const res = await baseFetch(current, { method, body, headers, redirect: 'manual', signal })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current)
        if (next.origin !== new URL(current).origin) {
          // never carry credentials to another origin
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase()))
          )
        }
        if ([301, 302, 303].includes(res.status) && method && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
          method = 'GET'
          body = undefined
        }
        current = next.toString()
        continue
      }
      const finalUrl = res.url || current
      assertAllowed(finalUrl)
      return { status: res.status, text: await res.text(), url: finalUrl }
    }
    throw new Error(`Too many redirects fetching ${url}`)
  }
}
