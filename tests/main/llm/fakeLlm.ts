import type { LlmClient } from '../../../src/main/llm/llm'

// Scripted LlmClient for tests: replies are returned in order, an Error entry is thrown.
export function createFakeLlm(
  replies: (string | Error)[]
): LlmClient & { calls: { system: string; prompt: string }[] } {
  const calls: { system: string; prompt: string }[] = []
  return {
    calls,
    async text(args) {
      calls.push(args)
      const next = replies[calls.length - 1]
      if (next === undefined) {
        throw new Error(
          `createFakeLlm: no scripted reply for call #${calls.length} (only ${replies.length} scripted)`
        )
      }
      if (next instanceof Error) throw next
      return next
    }
  }
}
