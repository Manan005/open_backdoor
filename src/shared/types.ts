export type SourceId = 'yc' | 'producthunt' | 'techcrunch' | 'inc42' | 'entrackr' | 'yourstory' | 'hn' | 'github' | 'careers' | 'websearch'
export type SignalKind = 'raised' | 'launched' | 'hiring'
export interface Signal { kind: SignalKind; detail: string; date: string | null; sourceId: SourceId; url: string }
export interface FoundEmail { email: string; url: string }
export type Stage = 'pre-seed' | 'seed' | 'series-a' | 'series-b' | 'series-c' | 'later' | 'unknown'
export interface Candidate {
  name: string; website: string | null; description: string; signals: Signal[]
  country: string | null /* ISO-3166 alpha-2 */; city: string | null; remote: boolean | null
  stage: Stage | null; emails: FoundEmail[]
}
export interface Company extends Candidate { id: number; domainKey: string; createdAt: string }
export type ContactKind = 'founder' | 'person' | 'hiring_inbox'
export interface Contact { email: string; name: string | null; role: string | null; kind: ContactKind; sourceUrl: string }
export interface Draft { subject: string; body: string; startupDetail: string; userDetail: string }
export type LeadStatus = 'picked' | 'drafted' | 'queued' | 'skipped' | 'sent' | 'replied' | 'bounced' | 'closed' | 'interview'
export interface Lead {
  id: number; companyId: number; status: LeadStatus; fitScore: number; whyFit: string
  contact: Contact | null; draft: Draft | null; followUpsSent: 0 | 1 | 2 | 3
  nextActionAt: string | null; needsApproval: boolean; firstSentAt: string | null
  lastError: string | null; createdAt: string; updatedAt: string
}
export type MessageKind = 'first' | 'followup' | 'reply' | 'bounce' | 'ooo' | 'user'
export interface MailMessage {
  id: number; leadId: number; direction: 'out' | 'in'; kind: MessageKind; messageId: string
  inReplyTo: string | null; references: string[]; from: string; to: string; subject: string; text: string; at: string
}
export interface Rule { topic: string; text: string; forbiddenTerms: string[] }
export interface Preferences {
  roles: string[]; locations: string[]; remoteOk: boolean; stages: Stage[]
  visa: string | null; salaryFloor: string | null; exclusions: string[]
}
export interface Profile {
  name: string; email: string | null; summary: string; yearsExperience: number | null; skills: string[]
  projects: { name: string; detail: string; metrics: string | null }[]
  experience: { company: string; title: string; start: string | null; end: string | null }[]
  links: string[]; preferences: Preferences; rules: Rule[]; signOff: string | null
  homeCountry: string | null; homeCity: string | null; timezone: string
  resumePath: string | null; rawText: string
}
export type SecretKey = 'ai.apiKey' | 'mail.password' | 'search.apiKey' | 'producthunt.token' | 'github.token'
export type EngineEvent =
  | { type: 'reply'; leadId: number } | { type: 'bounce'; leadId: number }
  | { type: 'paused'; reason: 'mail_auth_failed' } | { type: 'error'; leadId: number | null; message: string }
export type AiProvider = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'ollama' | 'huggingface' | 'custom'
export type MailPreset = 'gmail' | 'zoho' | 'zoho_in' | 'other'
export interface MailSettings { address: string; preset: MailPreset; smtpHost: string; smtpPort: number; imapHost: string; imapPort: number; sentMailbox: string }
export interface Settings {
  ai: { provider: AiProvider; model: string; baseUrl: string | null /* required for 'custom', optional override for 'ollama', ignored otherwise */ } | null
  mail: MailSettings | null
  dailyCap: number; picksPerDay: number; pickTime: string /* "HH:mm" */
  attachResume: boolean; paused: boolean; pauseReason: 'user' | 'mail_auth_failed' | null
  searchProvider: 'tavily' | 'brave' | 'exa' | null
}
