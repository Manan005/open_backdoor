import type { Candidate, FoundEmail, Profile, Signal } from '../../shared/types'
import { domainKey } from '../sources/normalize'
import { countryFromText } from './timezones'

function mergeBy<T>(a: T[], b: T[], key: (t: T) => string): T[] {
  const seen = new Set(a.map(key))
  const out = [...a]
  for (const t of b) {
    const k = key(t)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(t)
    }
  }
  return out
}

// First member's value wins; null (and stage 'unknown') count as gaps, like CompanyRepo.upsert.
function merge(members: Candidate[]): Candidate {
  const first = <K extends keyof Candidate>(k: K): Candidate[K] | null =>
    members.find((m) => m[k] !== null)?.[k] ?? null
  return {
    name: members[0].name,
    website: first('website'),
    description: members.find((m) => m.description)?.description ?? '',
    signals: members.reduce<Signal[]>((acc, m) => mergeBy(acc, m.signals, (s) => s.url), []),
    country: first('country'),
    city: first('city'),
    remote: first('remote'),
    stage: members.find((m) => m.stage && m.stage !== 'unknown')?.stage ?? first('stage'),
    emails: members.reduce<FoundEmail[]>((acc, m) => mergeBy(acc, m.emails, (e) => e.email.toLowerCase()), [])
  }
}

// One entry per startup. Candidates sharing a domainKey merge; a name-only candidate joins the
// website candidate with the same normalized name (the first one, if two share it).
// Anything already in existingKeys (under its domain key or its name key) is dropped.
export function dedupe(candidates: Candidate[], existingKeys: Set<string>): { key: string; candidate: Candidate }[] {
  const groups = new Map<string, Candidate[]>()
  const nameOnly: Candidate[] = []
  for (const c of candidates) {
    const key = domainKey(c.website, c.name)
    if (key.startsWith('name:')) nameOnly.push(c)
    else groups.set(key, [...(groups.get(key) ?? []), c])
  }
  const byName = new Map<string, string>()
  for (const [key, members] of groups) {
    for (const m of members) {
      const nk = domainKey(null, m.name)
      if (!byName.has(nk)) byName.set(nk, key)
    }
  }
  for (const c of nameOnly) {
    const nk = domainKey(null, c.name)
    const key = byName.get(nk) ?? nk
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  const out: { key: string; candidate: Candidate }[] = []
  for (const [key, members] of groups) {
    const nameKeys = members.map((m) => domainKey(null, m.name))
    if (existingKeys.has(key) || nameKeys.some((k) => existingKeys.has(k))) continue
    out.push({ key, candidate: merge(members) })
  }
  return out
}

export function screen(
  c: Candidate,
  profile: Profile
): { pass: true } | { pass: false; reason: 'excluded' | 'location' | 'stage' } {
  const prefs = profile.preferences
  const text = `${c.name} ${c.description}`.toLowerCase()
  if (prefs.exclusions.some((t) => t.trim() && text.includes(t.trim().toLowerCase()))) {
    return { pass: false, reason: 'excluded' }
  }
  if (c.stage && c.stage !== 'unknown' && prefs.stages.length > 0 && !prefs.stages.includes(c.stage)) {
    return { pass: false, reason: 'stage' }
  }
  if (c.remote === false && c.country && c.country !== profile.homeCountry) {
    // Users write "India", "Bengaluru" or "Remote", so locations go through countryFromText.
    const wanted = prefs.locations.map(countryFromText)
    if (!wanted.includes(c.country)) return { pass: false, reason: 'location' }
  }
  return { pass: true }
}
