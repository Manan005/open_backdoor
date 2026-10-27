import { z } from 'zod'
import { generateStructured, type LlmClient } from '../llm/llm'
import type { Profile, Rule } from '../../shared/types'
import { ProfileSchema } from './profileBuilder'

const RuleSchema = z.object({ topic: z.string(), forbiddenTerms: z.array(z.string()) })

export async function addRule(llm: LlmClient, rules: Rule[], text: string): Promise<Rule[]> {
  const r = await generateStructured(llm, RuleSchema, {
    system:
      "You turn a job-seeker's instruction about what outreach emails must avoid into a rule. " +
      'topic is a short lowercase label (e.g. "crypto"). forbiddenTerms are lowercase words or phrases an email must not contain.',
    prompt: `Instruction: ${text}`
  })
  const topic = r.topic.trim()
  const rule: Rule = {
    topic,
    text,
    forbiddenTerms: [
      ...new Set(r.forbiddenTerms.map((t) => t.trim().toLowerCase()).filter(Boolean))
    ]
  }
  const key = topic.toLowerCase()
  const i = rules.findIndex((x) => x.topic.toLowerCase() === key)
  if (i < 0) return [...rules, rule]
  return rules.map((x, j) => (j === i ? rule : x))
}

export async function applyCorrection(
  llm: LlmClient,
  profile: Profile,
  correction: string
): Promise<Profile> {
  const {
    name,
    email,
    summary,
    yearsExperience,
    skills,
    projects,
    experience,
    homeCountry,
    homeCity
  } = profile
  const current = {
    name,
    email,
    summary,
    yearsExperience,
    skills,
    projects,
    experience,
    homeCountry,
    homeCity
  }
  const x = await generateStructured(llm, ProfileSchema, {
    system:
      "You update a structured job-seeker profile according to the user's correction. Change only what the correction requires; keep everything else exactly as is. Return the full updated profile.",
    prompt: `Current profile:\n${JSON.stringify(current)}\n\nCorrection: ${correction}`
  })
  return { ...profile, ...x }
}
