import { generateText, APICallError, type LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import type { AiProvider } from '../../shared/types'

export interface LlmClient {
  text(args: { system: string; prompt: string }): Promise<string>
}

export interface LlmConfig {
  provider: AiProvider
  model: string
  apiKey: string | null
  baseUrl: string | null
}

export class LlmUnavailableError extends Error {
  constructor(
    message = "Couldn't reach the AI provider. Check that it is running and the address is right."
  ) {
    super(message)
    this.name = 'LlmUnavailableError'
  }
}

export class LlmAuthError extends Error {
  constructor(message = 'The AI key was rejected.') {
    super(message)
    this.name = 'LlmAuthError'
  }
}

export class LlmOutputError extends Error {
  constructor(
    message: string,
    public readonly raw: string
  ) {
    super(message)
    this.name = 'LlmOutputError'
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT'
])

// Follows cause / lastError / errors links (AI SDK wraps failures in RetryError etc.).
function* errorChain(e: unknown): Generator<unknown> {
  const seen = new Set<unknown>()
  const stack = [e]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue
    seen.add(cur)
    yield cur
    const o = cur as { cause?: unknown; lastError?: unknown; errors?: unknown }
    stack.push(o.cause, o.lastError)
    if (Array.isArray(o.errors)) stack.push(...o.errors)
  }
}

// Maps any failure to LlmAuthError / LlmUnavailableError when it looks like one; otherwise returns it unchanged.
function classifyError(e: unknown): unknown {
  if (e instanceof LlmAuthError || e instanceof LlmUnavailableError || e instanceof LlmOutputError)
    return e
  for (const c of errorChain(e)) {
    const status = APICallError.isInstance(c) ? c.statusCode : undefined
    if (status === 401 || status === 403) return new LlmAuthError()
  }
  for (const c of errorChain(e)) {
    const o = c as { code?: unknown; name?: unknown; message?: unknown }
    if (typeof o.code === 'string' && NETWORK_CODES.has(o.code)) return new LlmUnavailableError()
    if (o.name === 'TimeoutError' || o.name === 'AbortError') return new LlmUnavailableError()
    if (
      typeof o.message === 'string' &&
      /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(o.message)
    ) {
      return new LlmUnavailableError()
    }
  }
  return e
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
const HF_URL = 'https://router.huggingface.co/v1'
const OLLAMA_URL = 'http://localhost:11434/v1'

// Base URL for providers that expose an OpenAI-style /models listing.
function compatibleBaseUrl(cfg: LlmConfig): string | null {
  switch (cfg.provider) {
    case 'openrouter':
      return OPENROUTER_URL
    case 'huggingface':
      return HF_URL
    case 'ollama':
      return cfg.baseUrl?.trim() || OLLAMA_URL
    case 'custom':
      return cfg.baseUrl?.trim().replace(/\/+$/, '') || null
    default:
      return null
  }
}

function buildModel(cfg: LlmConfig, fetchFn?: typeof fetch): LanguageModel {
  const apiKey = cfg.apiKey || undefined
  switch (cfg.provider) {
    case 'openai':
      return createOpenAI({ apiKey, fetch: fetchFn })(cfg.model)
    case 'anthropic':
      return createAnthropic({ apiKey, fetch: fetchFn })(cfg.model)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, fetch: fetchFn })(cfg.model)
    default: {
      const baseURL = compatibleBaseUrl(cfg)
      if (!baseURL) throw new Error('A base URL is required for a custom AI endpoint.')
      return createOpenAICompatible({
        name: cfg.provider,
        baseURL,
        // ollama never needs a key; custom sends one only when non-empty
        apiKey: cfg.provider === 'ollama' ? undefined : apiKey,
        fetch: fetchFn
      })(cfg.model)
    }
  }
}

export function createAiSdkClient(cfg: LlmConfig, opts?: { fetch?: typeof fetch }): LlmClient {
  return {
    async text({ system, prompt }) {
      try {
        const model = buildModel(cfg, opts?.fetch)
        // maxRetries 0: a dead local server should fail fast, not back off for seconds
        const res = await generateText({ model, system, prompt, maxRetries: 0 })
        return res.text
      } catch (e) {
        throw classifyError(e)
      }
    }
  }
}

export async function listModels(cfg: LlmConfig, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const baseURL = compatibleBaseUrl(cfg)
  if (!baseURL) throw new Error('Listing models is not supported for this provider.')
  const headers: Record<string, string> = {}
  if (cfg.apiKey && cfg.provider !== 'ollama') headers.Authorization = `Bearer ${cfg.apiKey}`
  let res: Response
  try {
    res = await fetchFn(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000)
    })
  } catch (e) {
    const c = classifyError(e)
    throw c === e ? new LlmUnavailableError() : c
  }
  if (res.status === 401 || res.status === 403) throw new LlmAuthError()
  if (!res.ok) throw new LlmUnavailableError(`The AI provider answered with HTTP ${res.status}.`)
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null
  const ids = (body?.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
  return ids.sort()
}

type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  default?: unknown
}

// Deterministic sample value from a JSON Schema node: strings -> "string", numbers -> 0,
// enums -> "a|b|c", nullable/union -> first non-null branch, arrays -> one sample element.
function sample(s: JsonSchema): unknown {
  if (s.const !== undefined) return s.const
  if (s.enum) return s.enum.join('|')
  const union = s.anyOf ?? s.oneOf
  if (union) return sample(union.find((u) => u.type !== 'null') ?? union[0])
  const type = Array.isArray(s.type) ? (s.type.find((t) => t !== 'null') ?? 'null') : s.type
  switch (type) {
    case 'object':
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]))
    case 'array':
      return s.items ? [sample(s.items)] : []
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    default:
      return null
  }
}

function exampleFor(schema: z.ZodType): string {
  return JSON.stringify(
    sample(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema)
  )
}

// First balanced {...} in the text, ignoring braces inside JSON strings.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

function parseReply<T>(
  schema: z.ZodType<T>,
  raw: string
): { ok: true; value: T } | { ok: false; error: string } {
  const json = extractJsonObject(raw)
  if (!json) return { ok: false, error: 'The reply contained no JSON object.' }
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (e) {
    return { ok: false, error: `The JSON could not be parsed: ${(e as Error).message}` }
  }
  const r = schema.safeParse(data)
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error) }
}

async function callText(llm: LlmClient, args: { system: string; prompt: string }): Promise<string> {
  try {
    return await llm.text(args)
  } catch (e) {
    throw classifyError(e)
  }
}

export async function generateStructured<T>(
  llm: LlmClient,
  schema: z.ZodType<T>,
  args: { system: string; prompt: string }
): Promise<T> {
  const prompt = `${args.prompt}\n\nReply with only a JSON object matching this shape:\n${exampleFor(schema)}`
  const first = await callText(llm, { system: args.system, prompt })
  const a = parseReply(schema, first)
  if (a.ok) return a.value

  const retryPrompt = `${prompt}\n\nYour previous reply was invalid:\n${a.error}\nReply again with only the corrected JSON object.`
  const second = await callText(llm, { system: args.system, prompt: retryPrompt })
  const b = parseReply(schema, second)
  if (b.ok) return b.value
  throw new LlmOutputError(
    `The AI reply was not valid JSON for the expected shape: ${b.error}`,
    second
  )
}
