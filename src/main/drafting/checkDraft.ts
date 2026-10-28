import type { Draft, Rule } from '../../shared/types'

export type GateFailure =
  | 'length'
  | 'startup_detail'
  | 'user_detail'
  | 'forbidden_term'
  | 'sign_off'
  | 'placeholder'
  | 'subject'

export interface CheckContext {
  kind: 'first' | 'followup'
  rules: Rule[]
  signOff: string | null
  /** Subject of the thread's first outgoing message; follow-ups must be "Re: " + this. */
  originalSubject?: string
}

const PLACEHOLDER = /\[[^\]]{2,}\]|\{\{|\}\}|<[a-z_ ]+>|lorem ipsum|your name|company name/i
const MAX_SUBJECT = 80

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function wordCount(body: string): number {
  const t = body.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}

// Whole-word match that also works for terms starting/ending with non-word characters ("c++", "node.js").
function containsTerm(text: string, term: string): boolean {
  const t = collapse(term)
  if (!t) return false
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(t)}(?![\\p{L}\\p{N}])`, 'iu')
  return re.test(text)
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++
  return n
}

export function checkDraft(
  d: Draft,
  ctx: CheckContext
): { ok: true } | { ok: false; failures: GateFailure[] } {
  const failures: GateFailure[] = []

  const [min, max] = ctx.kind === 'first' ? [80, 150] : [20, 80]
  const words = wordCount(d.body)
  if (words < min || words > max) failures.push('length')

  const body = collapse(d.body).toLowerCase()
  const has = (detail: string): boolean => {
    const x = collapse(detail).toLowerCase()
    return x !== '' && body.includes(x)
  }
  if (!has(d.startupDetail)) failures.push('startup_detail')
  if (!has(d.userDetail)) failures.push('user_detail')

  const terms = ctx.rules.flatMap((r) => r.forbiddenTerms)
  const haystack = `${d.subject}\n${d.body}`
  if (terms.some((t) => containsTerm(haystack, t))) failures.push('forbidden_term')

  if (ctx.signOff && collapse(ctx.signOff)) {
    const sign = collapse(ctx.signOff)
    const b = collapse(d.body)
    if (!b.endsWith(sign) || countOccurrences(b, sign) !== 1) failures.push('sign_off')
  }

  if (PLACEHOLDER.test(d.body)) failures.push('placeholder')

  const subject = d.subject.trim()
  let subjectBad = subject === '' || subject.length > MAX_SUBJECT || PLACEHOLDER.test(subject)
  if (!subjectBad && ctx.kind === 'followup') {
    subjectBad =
      ctx.originalSubject !== undefined
        ? subject !== `Re: ${ctx.originalSubject.trim()}`
        : !subject.startsWith('Re: ')
  }
  if (subjectBad) failures.push('subject')

  return failures.length ? { ok: false, failures } : { ok: true }
}
