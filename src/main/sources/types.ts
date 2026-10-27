import type { Candidate, Profile, Settings } from '../../shared/types'
import type { Fetcher } from '../net/http'
import type { LlmClient } from '../llm/llm'
import type { SecretStore } from '../secrets/secretStore'
import type { MetaRepo } from '../db/repos'

export interface SourceContext {
  fetch: Fetcher
  llm: LlmClient
  profile: Profile
  now: Date
  secrets: SecretStore
  settings: Settings
  meta: MetaRepo
}

// The signals inside the candidates carry the precise SourceId (one source may emit several).
export interface Source {
  id: string
  label: string
  fetchCandidates(ctx: SourceContext): Promise<Candidate[]>
}

export type { Fetcher }
