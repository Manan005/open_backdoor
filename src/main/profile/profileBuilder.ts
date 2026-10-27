import { z } from 'zod'
import { generateStructured, type LlmClient } from '../llm/llm'
import type { Preferences, Profile } from '../../shared/types'

// The fields the model extracts; everything else on Profile is owned by code.
export const ProfileSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  summary: z.string(),
  yearsExperience: z.number().nullable(),
  skills: z.array(z.string()),
  projects: z.array(
    z.object({ name: z.string(), detail: z.string(), metrics: z.string().nullable() })
  ),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      start: z.string().nullable(),
      end: z.string().nullable()
    })
  ),
  homeCountry: z.string().nullable(),
  homeCity: z.string().nullable()
})
export type ExtractedProfile = z.infer<typeof ProfileSchema>

const SYSTEM =
  'You extract a structured job-seeker profile from resume text. Use only facts present in the text; never invent employers, metrics or dates. ' +
  'Use null when a value is unknown. yearsExperience is total years of professional experience. homeCountry is an ISO-3166 alpha-2 code. ' +
  'Dates are "YYYY-MM" or "YYYY"; end is null for a current role. Keep summary to two sentences.'

const emptyPreferences = (): Preferences => ({
  roles: [],
  locations: [],
  remoteOk: false,
  stages: [],
  visa: null,
  salaryFloor: null,
  exclusions: []
})

export async function buildProfile(
  llm: LlmClient,
  input: {
    resumeText: string
    pastedText: string
    links: string[]
    previous: Profile | null
    timezone: string
  }
): Promise<Profile> {
  const rawText = [input.resumeText, input.pastedText].filter((t) => t.trim()).join('\n\n')
  const prompt =
    `Resume text:\n${input.resumeText}\n\n` +
    `Pasted LinkedIn / extra text:\n${input.pastedText || '(none)'}\n\n` +
    `Links: ${input.links.join(', ') || '(none)'}`
  const x = await generateStructured(llm, ProfileSchema, { system: SYSTEM, prompt })
  const prev = input.previous
  return {
    ...x,
    links: input.links,
    preferences: prev?.preferences ?? emptyPreferences(),
    rules: prev?.rules ?? [],
    signOff: prev?.signOff ?? null,
    timezone: input.timezone,
    resumePath: prev?.resumePath ?? null,
    rawText
  }
}

export function summarizeBack(profile: Profile): string {
  const latest = profile.experience[0]
  const parts: string[] = []
  if (latest) {
    parts.push(`${profile.name} is most recently ${latest.title} at ${latest.company}.`)
  } else {
    parts.push(`${profile.name}: no work experience found yet.`)
  }
  if (profile.yearsExperience !== null) {
    const y = profile.yearsExperience
    parts.push(`About ${y} ${y === 1 ? 'year' : 'years'} of experience.`)
  }
  const withMetrics = profile.projects.filter((p) => p.metrics).slice(0, 2)
  if (withMetrics.length) {
    parts.push(
      `Standout projects: ${withMetrics.map((p) => `${p.name} (${p.metrics})`).join(' and ')}.`
    )
  }
  return parts.join(' ')
}
