import { z } from 'zod'
import type { Candidate, Profile } from '../../shared/types'
import type { OpenRole } from '../enrich/careers'
import { generateStructured, type LlmClient } from '../llm/llm'

export interface FitResult {
  score: number
  whyFit: string
  couldDoWork: boolean
  hiresInRegion: 'yes' | 'no' | 'unknown'
}

const schema = z.object({
  score: z.number(),
  whyFit: z.string(),
  couldDoWork: z.boolean(),
  hiresInRegion: z.enum(['yes', 'no', 'unknown'])
})

const SYSTEM =
  "You judge how well a startup fits one job seeker. Be honest and strict: score 0-100 where 60 means worth a cold email. " +
  "couldDoWork is true only if the seeker has the skills to do the startup's actual work. " +
  'hiresInRegion is "no" only when the startup clearly will not hire someone in the seeker\'s location or visa situation. ' +
  "whyFit is one or two sentences naming exactly one of the seeker's projects or experiences and one concrete fact about the startup."

export function keepCandidate(r: FitResult): boolean {
  return r.score >= 60 && r.couldDoWork && r.hiresInRegion !== 'no'
}

export async function scoreFit(llm: LlmClient, c: Candidate, roles: OpenRole[], profile: Profile): Promise<FitResult> {
  const p = profile.preferences
  const prompt = [
    `Startup: ${c.name}${c.website ? ` (${c.website})` : ''}`,
    `Description: ${c.description || 'unknown'}`,
    `Location: ${[c.city, c.country].filter(Boolean).join(', ') || 'unknown'}${c.remote ? ' (remote)' : ''}; stage: ${c.stage ?? 'unknown'}`,
    `Signals:\n${c.signals.map((s) => `- ${s.kind}: ${s.detail}`).join('\n') || '- none'}`,
    `Open roles:\n${roles.slice(0, 15).map((r) => `- ${r.title}${r.location ? ` (${r.location})` : ''}${r.remote ? ' [remote]' : ''}`).join('\n') || '- none known'}`,
    '',
    `Job seeker summary: ${profile.summary}`,
    `Skills: ${profile.skills.join(', ')}`,
    `Projects:\n${profile.projects.map((j) => `- ${j.name}: ${j.detail}`).join('\n') || '- none'}`,
    `Seeker location: ${[profile.homeCity, profile.homeCountry].filter(Boolean).join(', ') || 'unknown'}`,
    `Wants roles: ${p.roles.join(', ') || 'any'}; locations: ${p.locations.join(', ') || 'any'}; remote ok: ${p.remoteOk}; visa: ${p.visa ?? 'n/a'}`
  ].join('\n')
  const r = await generateStructured(llm, schema, { system: SYSTEM, prompt })
  return { ...r, score: Math.max(0, Math.min(100, Math.round(r.score))) }
}
