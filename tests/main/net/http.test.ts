import { describe, expect, it, vi } from 'vitest'
import { BlockedDomainError, createFetcher } from '../../../src/main/net/http'

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
}

describe('createFetcher', () => {
  it('fetcher refuses wellfound.com and www.crunchbase.com', async () => {
    const base = okFetch()
    const f = createFetcher(base)
    await expect(f('https://wellfound.com/company/acme')).rejects.toBeInstanceOf(BlockedDomainError)
    await expect(f('https://www.crunchbase.com/organization/acme')).rejects.toBeInstanceOf(BlockedDomainError)
    await expect(f('https://www.linkedin.com/in/x')).rejects.toBeInstanceOf(BlockedDomainError)
    await expect(f('https://angel.co/acme')).rejects.toBeInstanceOf(BlockedDomainError)
    expect(base).not.toHaveBeenCalled()
  })

  it('matches blocked hosts on a dot boundary only', async () => {
    const f = createFetcher(okFetch())
    expect((await f('https://notlinkedin.com/')).text).toBe('ok')
  })

  it('sends the Sidedoor user agent and returns status, text and final url', async () => {
    const base = vi.fn(async (_u: string, _i?: unknown) => new Response('hello', { status: 201 }))
    const f = createFetcher(base as unknown as typeof fetch)
    const res = await f('https://example.com/a', { headers: { 'X-Test': '1' } })
    expect(res).toEqual({ status: 201, text: 'hello', url: 'https://example.com/a' })
    const init = base.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers['User-Agent']).toBe('Sidedoor/0.1 (+https://github.com/<owner>/sidedoor)')
    expect(init.headers['X-Test']).toBe('1')
  })

  it('refuses a redirect that lands on a blocked host', async () => {
    const base = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://www.linkedin.com/jobs' } })
    )
    const f = createFetcher(base as unknown as typeof fetch)
    await expect(f('https://example.com/go')).rejects.toBeInstanceOf(BlockedDomainError)
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('follows a normal redirect and reports the final url', async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/b' } }))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))
    const f = createFetcher(base as unknown as typeof fetch)
    const res = await f('https://example.com/a')
    expect(res).toEqual({ status: 200, text: 'done', url: 'https://example.com/b' })
  })

  it('drops credential headers on a cross-origin redirect and keeps them same-origin', async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/same' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.org/x' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const f = createFetcher(base as unknown as typeof fetch)
    await f('https://api.example.com/a', {
      headers: { Authorization: 'Bearer t', 'X-Subscription-Token': 's', 'x-api-key': 'k', Cookie: 'c=1', Accept: 'a/b' }
    })
    const hdr = (i: number): Record<string, string> => base.mock.calls[i][1].headers
    expect(Object.keys(hdr(1)).map((k) => k.toLowerCase())).toContain('authorization')
    const cross = Object.keys(hdr(2)).map((k) => k.toLowerCase())
    expect(cross).not.toContain('authorization')
    expect(cross).not.toContain('x-subscription-token')
    expect(cross).not.toContain('x-api-key')
    expect(cross).not.toContain('cookie')
    expect(cross).toContain('accept')
    expect(cross).toContain('user-agent')
  })

  it('switches a POST to GET without a body on a 302', async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/done' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const f = createFetcher(base as unknown as typeof fetch)
    await f('https://example.com/post', { method: 'POST', body: '{"a":1}' })
    expect(base.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"a":1}' })
    expect(base.mock.calls[1][1].method).toBe('GET')
    expect(base.mock.calls[1][1].body).toBeUndefined()
  })
})
