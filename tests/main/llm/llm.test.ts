import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  createAiSdkClient,
  generateStructured,
  listModels,
  LlmAuthError,
  LlmOutputError,
  LlmUnavailableError
} from '../../../src/main/llm/llm'
import { createFakeLlm } from './fakeLlm'

const schema = z.object({
  name: z.string(),
  score: z.number(),
  tags: z.array(z.string()).optional()
})
const args = { system: 'sys', prompt: 'p' }

function connRefused(): Error {
  const e = new TypeError('fetch failed')
  ;(e as Error & { cause: unknown }).cause = Object.assign(
    new Error('connect ECONNREFUSED 127.0.0.1:11434'),
    {
      code: 'ECONNREFUSED'
    }
  )
  return e
}

describe('generateStructured', () => {
  it('parses JSON wrapped in prose and code fences', async () => {
    const llm = createFakeLlm([
      'Sure! Here you go:\n```json\n{"name":"A } b","score":3}\n```\nHope it helps {not json}'
    ])
    expect(await generateStructured(llm, schema, args)).toEqual({ name: 'A } b', score: 3 })
    expect(llm.calls[0].prompt).toContain('Reply with only a JSON object matching this shape:')
    expect(llm.calls[0].prompt).toContain('"name"')
  })

  it('retries once with validation error then succeeds', async () => {
    const llm = createFakeLlm(['{"name":"A","score":"high"}', '{"name":"A","score":4}'])
    expect(await generateStructured(llm, schema, args)).toEqual({ name: 'A', score: 4 })
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].prompt).toContain('score')
    expect(llm.calls[1].prompt).toContain('expected number')
  })

  it('throws LlmOutputError after two bad replies', async () => {
    const llm = createFakeLlm(['no json at all', ''])
    const err = await generateStructured(llm, schema, args).catch((e) => e)
    expect(err).toBeInstanceOf(LlmOutputError)
    expect(err.raw).toBe('')
    expect(llm.calls).toHaveLength(2)
  })

  it('wraps ECONNREFUSED as LlmUnavailableError', async () => {
    const llm = createFakeLlm([connRefused()])
    await expect(generateStructured(llm, schema, args)).rejects.toBeInstanceOf(LlmUnavailableError)
  })

  it('builds examples for nested objects, arrays, enums and nullable fields', async () => {
    const nested = z.object({
      a: z.object({ b: z.array(z.object({ c: z.number() })) }),
      kind: z.enum(['x', 'y']),
      note: z.string().nullable()
    })
    const llm = createFakeLlm(['{"a":{"b":[{"c":1}]},"kind":"x","note":null}'])
    await generateStructured(llm, nested, args)
    const prompt = llm.calls[0].prompt
    expect(prompt).toContain('"b":[{"c":0}]')
    expect(prompt).toContain('"kind":"x|y"')
    expect(prompt).toContain('"note":"string"')
  })
})

describe('createFakeLlm', () => {
  it('throws a clear error past the scripted replies', async () => {
    const llm = createFakeLlm(['one'])
    await llm.text(args)
    await expect(llm.text(args)).rejects.toThrow(/no scripted reply/)
  })
})

describe('createAiSdkClient', () => {
  const chatOk = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )

  it('huggingface uses the HF router base URL', async () => {
    const seen: { url: string; auth: string | null }[] = []
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      return chatOk()
    }) as typeof fetch
    const llm = createAiSdkClient(
      { provider: 'huggingface', model: 'm', apiKey: 'hf_tok', baseUrl: null },
      { fetch: fakeFetch }
    )
    expect(await llm.text(args)).toBe('hi')
    expect(seen[0].url).toBe('https://router.huggingface.co/v1/chat/completions')
    expect(seen[0].auth).toBe('Bearer hf_tok')
  })

  it('custom endpoint trims trailing slash and sends no auth without a key', async () => {
    const seen: { url: string; auth: string | null }[] = []
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      return chatOk()
    }) as typeof fetch
    const llm = createAiSdkClient(
      { provider: 'custom', model: 'm', apiKey: '', baseUrl: 'http://localhost:20128/v1/' },
      { fetch: fakeFetch }
    )
    await llm.text(args)
    expect(seen[0].url).toBe('http://localhost:20128/v1/chat/completions')
    expect(seen[0].auth).toBeNull()
  })

  it('maps connection refusal to LlmUnavailableError', async () => {
    const fakeFetch = (async () => {
      throw connRefused()
    }) as unknown as typeof fetch
    const llm = createAiSdkClient(
      { provider: 'ollama', model: 'm', apiKey: null, baseUrl: null },
      { fetch: fakeFetch }
    )
    await expect(generateStructured(llm, schema, args)).rejects.toBeInstanceOf(LlmUnavailableError)
  })

  it('maps HTTP 401 to LlmAuthError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    const llm = createAiSdkClient(
      { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: null },
      { fetch: fakeFetch }
    )
    const err = await llm.text(args).catch((e) => e)
    expect(err).toBeInstanceOf(LlmAuthError)
    expect(err.message).toBe('The AI key was rejected.')
  })
})

describe('listModels', () => {
  const cfg = {
    provider: 'custom' as const,
    model: '',
    apiKey: 'sk-1',
    baseUrl: 'http://localhost:20128/v1/'
  }
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('listModels reads data ids from a custom localhost endpoint', async () => {
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:20128/v1/models')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-1')
      return json({ data: [{ id: 'b' }, { id: 'a' }] })
    }) as typeof fetch
    expect(await listModels(cfg, fetchFn)).toEqual(['a', 'b'])
  })

  it('listModels sends no Authorization header when key is empty', async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return json({ data: [] })
    }) as typeof fetch
    expect(await listModels({ ...cfg, apiKey: '' }, fetchFn)).toEqual([])
  })

  it('listModels maps 401 to LlmAuthError', async () => {
    const fetchFn = (async () => json({}, 401)) as typeof fetch
    await expect(listModels(cfg, fetchFn)).rejects.toBeInstanceOf(LlmAuthError)
  })

  it('listModels maps connection refusal to LlmUnavailableError', async () => {
    const fetchFn = (async () => {
      throw connRefused()
    }) as unknown as typeof fetch
    await expect(listModels(cfg, fetchFn)).rejects.toBeInstanceOf(LlmUnavailableError)
  })

  it('listModels uses the HF router for huggingface', async () => {
    const fetchFn = (async (url: unknown) => {
      expect(String(url)).toBe('https://router.huggingface.co/v1/models')
      return json({ data: [{ id: 'z' }] })
    }) as typeof fetch
    expect(
      await listModels({ provider: 'huggingface', model: '', apiKey: 'hf', baseUrl: null }, fetchFn)
    ).toEqual(['z'])
  })
})
