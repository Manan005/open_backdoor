import { z } from 'zod'
import type { Company, Contact, Draft, MailMessage, Profile } from '../../shared/types'
import type { OpenRole } from '../enrich/careers'
import { generateStructured, type LlmClient } from '../llm/llm'
import { checkDraft, type CheckContext, type GateFailure } from './checkDraft'

export interface FirstEmailContext {
  profile: Profile
  company: Company
  roles: OpenRole[]
  contact: Contact
  whyFit: string
}

const draftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  startupDetail: z.string(),
  userDetail: z.string()
})

const DETAIL_FIELDS =
  'startupDetail must be an exact phrase copied from your body that refers to something specific about the startup; ' +
  'userDetail must be an exact phrase copied from your body that refers to something specific from the sender\'s background.'

function rulesBlock(profile: Profile): string {
  const lines: string[] = []
  for (const r of profile.rules) {
    const terms = r.forbiddenTerms.length ? ` (never use: ${r.forbiddenTerms.join(', ')})` : ''
    lines.push(`- ${r.topic}: ${r.text}${terms}`)
  }
  return lines.length ? `The sender's rules, which you must follow:\n${lines.join('\n')}` : ''
}

function signOffLine(profile: Profile): string {
  return profile.signOff
    ? `End the body with exactly this sign-off, once, and nothing after it:\n${profile.signOff}`
    : `End with a short sign-off using the sender's name, ${profile.name}.`
}

function visaLine(profile: Profile, company: Company): string {
  const visa = profile.preferences.visa
  const abroad = !!company.country && !!profile.homeCountry && company.country !== profile.homeCountry
  return visa && abroad
    ? `The company is in another country than the sender, so mention the sender's visa status in one short clause: ${visa}`
    : 'Do not mention visas or work authorization.'
}

function profileBlock(profile: Profile): string {
  const projects = profile.projects
    .map((p) => `- ${p.name}: ${p.detail}${p.metrics ? ` (${p.metrics})` : ''}`)
    .join('\n')
  return [
    `Sender: ${profile.name}`,
    `Summary: ${profile.summary}`,
    profile.skills.length ? `Skills: ${profile.skills.join(', ')}` : '',
    projects ? `Projects:\n${projects}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function companyBlock(c: Company, roles: OpenRole[]): string {
  const signals = c.signals.map((s) => `- ${s.kind}: ${s.detail}`).join('\n')
  const open = roles.map((r) => `- ${r.title}${r.location ? ` (${r.location})` : ''}`).join('\n')
  return [
    `Company: ${c.name}`,
    `What it does: ${c.description}`,
    signals ? `Recent signals:\n${signals}` : '',
    open ? `Open roles:\n${open}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function firstSystem(ctx: FirstEmailContext): string {
  return [
    'You write a short, specific cold email from a job seeker to a startup founder.',
    "Write in the sender's own voice: plain, direct, human. No buzzwords, no flattery, no filler, no placeholders.",
    'The body must be 80 to 150 words, sign-off included.',
    "Cite one or two of the sender's projects with the real numbers from the profile. Never invent facts or numbers.",
    'Mention one specific, true thing about the startup.',
    visaLine(ctx.profile, ctx.company),
    rulesBlock(ctx.profile),
    signOffLine(ctx.profile),
    'Keep the subject under 80 characters.',
    DETAIL_FIELDS
  ]
    .filter(Boolean)
    .join('\n')
}

function firstPrompt(ctx: FirstEmailContext): string {
  const who = [ctx.contact.name, ctx.contact.role].filter(Boolean).join(', ')
  return [
    profileBlock(ctx.profile),
    '',
    companyBlock(ctx.company, ctx.roles),
    '',
    `Recipient: ${who || ctx.contact.email}`,
    `Why this is a fit: ${ctx.whyFit}`
  ].join('\n')
}

function describeFailures(failures: GateFailure[]): string {
  const text: Record<GateFailure, string> = {
    length: 'the body must be 80 to 150 words',
    startup_detail: 'startupDetail must be non-empty and appear word for word in the body',
    user_detail: 'userDetail must be non-empty and appear word for word in the body',
    forbidden_term: 'a forbidden term was used',
    sign_off: 'the body must end with the exact sign-off, appearing once',
    placeholder: 'the text contains a placeholder',
    subject: 'the subject must be non-empty, under 80 characters, with no placeholder'
  }
  return failures.map((f) => `- ${text[f]}`).join('\n')
}

function gateCtx(ctx: FirstEmailContext): CheckContext {
  return { kind: 'first', rules: ctx.profile.rules, signOff: ctx.profile.signOff }
}

export async function draftFirstEmail(llm: LlmClient, ctx: FirstEmailContext): Promise<Draft> {
  const system = firstSystem(ctx)
  const prompt = firstPrompt(ctx)
  const gates = gateCtx(ctx)

  const first = await generateStructured(llm, draftSchema, { system, prompt })
  const r1 = checkDraft(first, gates)
  if (r1.ok) return first

  const retryPrompt =
    `${prompt}\n\nA previous attempt failed these checks:\n${describeFailures(r1.failures)}\n` +
    `Previous body:\n${first.body}\n\nWrite a corrected email.`
  const second = await generateStructured(llm, draftSchema, { system, prompt: retryPrompt })
  const r2 = checkDraft(second, gates)
  if (r2.ok) return second
  // Best attempt: fewer failures wins, the second on a tie.
  return r2.failures.length <= r1.failures.length ? second : first
}

export async function reviseDraft(
  llm: LlmClient,
  draft: Draft,
  instruction: string,
  ctx: FirstEmailContext
): Promise<Draft> {
  const prompt = [
    profileBlock(ctx.profile),
    '',
    companyBlock(ctx.company, ctx.roles),
    '',
    `Current draft:\nSubject: ${draft.subject}\n\n${draft.body}`,
    '',
    `The sender asks: ${instruction}`,
    'Rewrite the email applying that request and keeping every rule above.'
  ].join('\n')
  return generateStructured(llm, draftSchema, { system: firstSystem(ctx), prompt })
}

export interface FollowUpContext {
  profile: Profile
  company: Company
  thread: MailMessage[]
  n: 1 | 2 | 3
}

export function originalSubject(thread: MailMessage[]): string {
  const first = thread.find((m) => m.direction === 'out')
  return (first?.subject ?? '').trim()
}

export function followUpSubject(original: string): string {
  return `Re: ${original.replace(/^(\s*re:\s*)+/i, '').trim()}`
}

const ANGLES: Record<1 | 2 | 3, string> = {
  1: 'A short, friendly nudge that adds one new angle: a relevant detail of the sender\'s work or a thought about the startup that was not in the first email.',
  2: 'A second nudge that adds a different new angle than before, such as a concrete idea or a specific result, and makes replying easy.',
  3: 'A polite close. Say this is the last note, that you understand if the timing is wrong, and leave the door open. No new pitch.'
}

export async function draftFollowUp(llm: LlmClient, ctx: FollowUpContext): Promise<Draft> {
  const system = [
    'You write a short follow-up in an existing email thread from a job seeker to a startup founder.',
    "Write in the sender's own voice: plain, direct, human. No buzzwords, no guilt-tripping, no placeholders.",
    'The body must be 20 to 80 words, sign-off included.',
    'Refer to the original email, do not repeat it. Never mention attachments or a resume.',
    ANGLES[ctx.n],
    rulesBlock(ctx.profile),
    signOffLine(ctx.profile),
    'Leave subject as an empty string; it is set automatically.',
    DETAIL_FIELDS
  ]
    .filter(Boolean)
    .join('\n')
  const earlier = ctx.thread
    .map((m, i) => `Message ${i + 1} (${m.direction === 'out' ? 'sent by the sender' : 'received'}):\n${m.text.trim()}`)
    .join('\n\n')
  const prompt = [
    profileBlock(ctx.profile),
    '',
    companyBlock(ctx.company, []),
    '',
    `This is follow-up number ${ctx.n} of 3.`,
    `Thread so far:\n${earlier}`
  ].join('\n')
  const d = await generateStructured(llm, draftSchema, { system, prompt })
  return { ...d, subject: followUpSubject(originalSubject(ctx.thread)) }
}
