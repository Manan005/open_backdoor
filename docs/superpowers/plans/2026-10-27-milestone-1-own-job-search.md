# Sidedoor Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows desktop app the owner can use for their own startup job search. It finds startups each day, finds a published founder email, drafts a specific note, sends it from the owner's Gmail after they click Send, follows up 3 times in the same thread, and stops when anyone replies.

**Architecture:**
- **Electron main process:** owns all logic. That covers the SQLite database, secrets, LLM calls, sources, contact finding, drafting, SMTP/IMAP, and the outreach engine with its scheduler.
- **Renderer:** a React UI. It talks to the main process only through a typed `window.sidedoor` API exposed by the preload script.
- **The pipeline is fixed:** code drives every step, and the LLM only fills structured slots and writes prose.

**Tech Stack:**
- App: Electron (latest stable), electron-vite, React 19, TypeScript, Vitest.
- Storage and secrets: `node:sqlite` (built in, no native rebuild); Electron `safeStorage`.
- Libraries: Luxon, zod, Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`), nodemailer, imapflow, mailparser, fast-xml-parser, unpdf, mammoth.
- Test-only: `smtp-server`.

**Spec:** `docs/superpowers/specs/2026-10-27-open-source-job-outreach-agent-design.md`. Read it before any task. §7 "Milestone 1" is the scope of this plan.

## Global Constraints

- App name in all UI, window titles and the User-Agent: **Sidedoor**. Never use the name or branding "Backdoor".
- Platform: Windows 11 first. No macOS- or Linux-only APIs.
- No first email is sent without the user's explicit Send. Follow-ups are pre-approved by that Send.
- Daily cap on **new** founders contacted: default **10**, user-adjustable, maximum **20**. Follow-ups don't count toward it.
- Never generate email addresses from name patterns. Every stored contact email must appear verbatim (after de-obfuscating `[at]`/`(at)`/` at ` and `[dot]`/`(dot)`) in fetched text. Each one carries its `sourceUrl`.
- Generic inboxes are excluded: `info@ support@ sales@ hello@ contact@ noreply@ no-reply@ admin@ help@ press@ media@ marketing@ billing@ privacy@ legal@ security@ team@ office@ partners@`.
- Never fetch pages on `linkedin.com`, `crunchbase.com`, `wellfound.com` or `angel.co`. Those can only be used through web-search result snippets.
- Follow-ups: at most **3**, in the same thread, sent **3, 4, 5** days after the previous message.
- Stop conditions for follow-ups:
  - any reply in the thread, including a "no"
  - the user writes in the thread themselves
  - a bounce
  - the user cancels

  An out-of-office reply only postpones the next follow-up.
- Sending window: **09:00–17:00, Monday–Friday**, in the startup's time zone if its country is known, otherwise in the user's.
- Mailbox poll every **10 minutes** while the app runs. Daily picks at **08:00** local by default. Picks per day: default **4**, allowed range **3–5**.
- Secrets (AI key, mail app password, search key, Product Hunt token, GitHub token) are stored only through `safeStorage`, never in plain text or in SQLite.
- Outlook / Hotmail / Live / MSN addresses are rejected in setup with the message "Outlook accounts aren't supported yet."
- Network calls are allowed only to: the configured AI provider, the configured mail servers, public source/company URLs, and the user's search provider.
- **All renderer UI work must load and follow the `design-taste-frontend-v1` skill before writing any UI code.** The mockups in `.superpowers/brainstorm/50-1793040584/content/layout-v2.html` fix layout only, not visual style.
- Every git commit message ends with the two attribution lines given in the session's system reminder.

## Review Focus

1. **The same startup arriving from several sources, or one already contacted.** Domains differ only by `www.`, scheme, path or trailing slash, or only a name is known. The startup must get one lead and never a second first email. Test: Task 9 `dedupe`.
2. **The app was closed or asleep past a follow-up's due time, and the founder replied in the meantime.** On startup, the engine must poll the mailbox *before* sending anything, so the overdue follow-up is cancelled, not sent. Test: Task 14 `tick polls before sending`.
3. **The app password was revoked or mistyped mid-run (SMTP 535 / IMAP auth failure).** Outreach pauses with reason `mail_auth_failed`, the lead stays `queued` (not `sent`), and nothing retries in a loop. Test: Task 14 `auth failure pauses`.
4. **The model returns malformed JSON, empty text, or Ollama isn't running.** No crash and no send. The pick or follow-up is marked with `lastError` or `needsApproval`. Test: Task 4 `structured fallback` and Task 11 `follow-up failing gates needs approval`.
5. **The founder replies from a different address than the one emailed** (a co-founder, or a personal Gmail). The reply must be matched by `In-Reply-To`/`References`, with a sender-address fallback. Test: Task 13 `reply from different sender matches by references`.

---

## File Structure

```
package.json, electron.vite.config.ts, tsconfig*.json, vitest.config.ts, .gitignore
src/shared/types.ts            domain types shared by main + renderer
src/shared/api.ts              the window.sidedoor API contract (types only)
src/main/index.ts              Electron entry: window, container, scheduler start
src/main/container.ts          builds all services from paths + Electron deps
src/main/db/database.ts        openDatabase + migrations
src/main/db/repos.ts           ProfileRepo, SettingsRepo, CompanyRepo, LeadRepo, MessageRepo, MetaRepo
src/main/secrets/secretStore.ts
src/main/settings/settings.ts  defaults, clamp, provider detection
src/main/llm/llm.ts            LlmClient interface, AI SDK adapter, generateStructured
src/main/net/http.ts           fetch helper: UA, timeout, blocked domains
src/main/profile/resumeText.ts, profileBuilder.ts, rules.ts
src/main/sources/types.ts, normalize.ts, rssFunding.ts, hnHiring.ts, yc.ts, productHunt.ts, github.ts, webSearch.ts
src/main/enrich/careers.ts     ATS job-board lookups
src/main/screening/timezones.ts, screen.ts, fitScore.ts
src/main/contacts/findContacts.ts
src/main/drafting/draftEmail.ts, checkDraft.ts
src/main/mail/presets.ts, smtpSender.ts, imapReader.ts, classifyIncoming.ts
src/main/outreach/schedule.ts, engine.ts
src/main/pipeline/runPicks.ts
src/main/app/scheduler.ts, ipc.ts
src/preload/index.ts
src/renderer/                  React app (Tasks 16–18)
tests/main/**                  mirrors src/main
tests/fixtures/**              saved RSS/HN/YC/HTML/email fixtures
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `.gitignore`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: `npm run dev` (electron-vite dev), `npm test` (vitest run), `npm run build`, `npm run typecheck`.

- [ ] **Step 1:** `git init` in `D:\github Brainstorm\backdoor app`. Create `.gitignore` with `node_modules/ out/ dist/ .superpowers/ *.log`.
- [ ] **Step 2:** Scaffold with `npm create @quick-start/electron@latest sidedoor-tmp -- --template react-ts`. Move its contents to the repo root (keep `docs/`), then delete `sidedoor-tmp`. Set `"name": "sidedoor"`, `"productName": "Sidedoor"`, and the window title `Sidedoor`.
- [ ] **Step 3:** Add Vitest with two projects. `main` uses `environment: 'node'` and includes `tests/main/**` and `tests/*.test.ts`. `renderer` uses `environment: 'jsdom'` and includes `tests/renderer/**`. Install `vitest jsdom @testing-library/react`.
- [ ] **Step 4: Write the smoke test**

```ts
import { DatabaseSync } from 'node:sqlite'
test('node:sqlite works in test runtime', () => {
  const db = new DatabaseSync(':memory:')
  expect(db.prepare('select 1 as x').get()).toEqual({ x: 1 })
})
```

- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** In `src/main/index.ts`, log `process.versions.node` and open `new DatabaseSync(':memory:')` on startup. Run `npm run dev`. Expected: the window titled "Sidedoor" opens, and the console shows a Node version ≥ 22.13 with no sqlite error. If `node:sqlite` is unavailable in this Electron build, stop and report; don't silently switch libraries.
- [ ] **Step 7:** Remove the startup sqlite probe, then commit: `chore: scaffold Electron + React + Vitest app`.

---

### Task 2: Shared types, database and repositories

**Files:**
- Create: `src/shared/types.ts`, `src/main/db/database.ts`, `src/main/db/repos.ts`
- Test: `tests/main/db/repos.test.ts`

**Interfaces:**
- Produces `src/shared/types.ts` (exact):

```ts
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
```

- Produces `openDatabase(path: string): DatabaseSync`. It runs migrations idempotently with `PRAGMA user_version`. Tables:
  - `kv(key primary key, value text)` stores profile, settings and meta as JSON.
  - `companies`: candidate JSON columns + `domain_key unique`.
  - `leads`: contact and draft as JSON.
  - `messages`: `message_id unique`.
- Produces in `repos.ts`:
  - `ProfileRepo { get(): Profile | null; save(p: Profile): void }`
  - `SettingsRepo { get(): Settings; save(s: Settings): void }`. `get` returns `defaultSettings()` from Task 3 when the row is empty, so this file imports it lazily via a passed-in `defaults` arg: `new SettingsRepo(db, defaults: () => Settings)`.
  - `CompanyRepo { upsert(c: Candidate, domainKey: string): Company; byKey(k: string): Company | null; byId(id: number): Company }`. `upsert` merges `signals` and `emails` (union by `url`/`email`).
  - `LeadRepo { create(l: Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>): Lead; get(id): Lead; update(id, patch: Partial<Lead>): Lead; list(f?: { status?: LeadStatus[] }): Lead[]; byCompany(companyId): Lead[]; byContactEmail(email): Lead[]; firstSentCountBetween(startIso, endIso): number; dueFollowUps(nowIso): Lead[]; queued(): Lead[] }`
  - `MessageRepo { insert(m: Omit<MailMessage, 'id'>): MailMessage; byLead(leadId): MailMessage[]; byMessageId(mid): MailMessage | null }`
  - `MetaRepo { get<T>(key): T | null; set(key, value: unknown): void; clearAll(): void }`
- `dueFollowUps` returns leads with `status='sent' AND followUpsSent<3 AND nextActionAt<=now AND needsApproval=0`.

- [ ] **Step 1: Write failing tests** in `tests/main/db/repos.test.ts` (in-memory DB):
  - `migrations are idempotent`: open the same file DB twice, with no throw.
  - `company upsert merges signals by url`: two upserts with the same `domainKey` produce one row with 2 signals.
  - `lead round-trips contact and draft JSON`.
  - `firstSentCountBetween counts only leads with firstSentAt in range`.
  - `dueFollowUps excludes needsApproval and followUpsSent=3`.
  - `messages.byMessageId finds inserted message`.
- [ ] **Step 2:** Run `npx vitest run tests/main/db`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement `src/shared/types.ts`, `database.ts` and `repos.ts` per the Interfaces.
- [ ] **Step 4:** Run `npx vitest run tests/main/db`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: sqlite schema and repositories`.

---

### Task 3: Secrets, settings and delete-everything

**Files:**
- Create: `src/main/secrets/secretStore.ts`, `src/main/settings/settings.ts`
- Test: `tests/main/settings/settings.test.ts`

**Interfaces:**
- Consumes `SecretKey` from `src/shared/types.ts`.
- Produces `interface SecretStore { get(k: SecretKey): string | null; set(k: SecretKey, v: string): void; has(k: SecretKey): boolean; clearAll(): void }`.
  - `createSafeStorageSecretStore(filePath: string, safe: { encryptString(s: string): Buffer; decryptString(b: Buffer): string; isEncryptionAvailable(): boolean }): SecretStore` stores base64 ciphertexts in a JSON file. It throws `SecretsUnavailableError` if encryption isn't available; it never falls back to plain text.
  - `createMemorySecretStore(): SecretStore` for tests.
- Produces `defaultSettings(): Settings` with: ai null, mail null, dailyCap 10, picksPerDay 4, pickTime "08:00", attachResume false, paused false, pauseReason null, searchProvider null.
- Produces `clampSettings(s: Settings): Settings`: dailyCap is clamped to 1..20 and picksPerDay to 3..5.
- Produces `validateAiSettings(ai: NonNullable<Settings['ai']>): string | null`, returning an error message or null. Every provider needs a non-empty `model`. `custom` also needs a `baseUrl` that parses as an `http:` or `https:` URL (`localhost` allowed). A trailing `/` on `baseUrl` is fine; the client trims it.
- Produces `isUnsupportedMailDomain(address: string): boolean`, true for `outlook.com hotmail.com live.com msn.com` and their country variants (`outlook.in`, `hotmail.co.uk`…), matched by second-level label.
- Produces `deleteEverything(deps: { db: DatabaseSync; secrets: SecretStore; appDataFiles: string[] }): void`. It drops every row, clears secrets, and deletes the copied resume files.

- [ ] **Step 1: Failing tests:**
  - `clamp caps dailyCap at 20 and floors at 1`
  - `clamp picksPerDay to 3..5`
  - `custom AI needs a valid base URL and model`: `{provider:'custom', baseUrl:null}` and `baseUrl:'ftp://x'` return an error; `http://localhost:20128/v1` with model `x` returns null
  - `outlook.com, hotmail.co.uk, live.com rejected; gmail.com, zoho.in accepted`
  - `safeStorage store round-trips and file contains no plaintext`: use a fake `safe` that reverses strings
  - `throws when encryption unavailable`
  - `deleteEverything leaves empty tables and no secrets`
- [ ] **Step 2:** Run `npx vitest run tests/main/settings`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: secret store, settings defaults, delete everything`.

---

### Task 4: LLM client with structured output that tolerates small models

**Files:**
- Create: `src/main/llm/llm.ts`
- Test: `tests/main/llm/llm.test.ts`

**Interfaces:**
- Produces `interface LlmClient { text(args: { system: string; prompt: string }): Promise<string> }`. Everything else builds on `text`, so tests use a scripted fake.
- Produces `createAiSdkClient(cfg: { provider: AiProvider; model: string; apiKey: string | null; baseUrl: string | null }): LlmClient`:
  - `openai` → `@ai-sdk/openai`
  - `anthropic` → `@ai-sdk/anthropic`
  - `google` → `@ai-sdk/google`
  - `openrouter` → `@ai-sdk/openai-compatible` with baseURL `https://openrouter.ai/api/v1`
  - `ollama` → `@ai-sdk/openai-compatible` with baseURL `cfg.baseUrl ?? 'http://localhost:11434/v1'` and no key
  - `huggingface` → `@ai-sdk/openai-compatible` with baseURL `https://router.huggingface.co/v1` and the HF token (stored as `ai.apiKey`) as the key
  - `custom` → `@ai-sdk/openai-compatible` with baseURL `cfg.baseUrl` (trailing `/` trimmed) and `cfg.apiKey` sent only when non-empty. This covers a localhost OmniRoute router, LM Studio, Groq, DeepSeek, Together, or a self-hosted server.
- Produces `listModels(cfg: same as createAiSdkClient, fetchFn: typeof fetch = fetch): Promise<string[]>`, only for `openrouter`, `ollama`, `huggingface` and `custom`. It sends `GET {baseURL}/models` (with `Authorization: Bearer <key>` when there is a key) and returns the sorted `data[].id`. It times out after 10 s. Connection refused or timeout → `LlmUnavailableError`; HTTP 401/403 → `LlmAuthError` (new, message "The AI key was rejected.").
- `text()` also maps HTTP 401/403 from any provider to `LlmAuthError`, so a bad HF token or router key shows a clear message instead of a stack trace.
- Produces `generateStructured<T>(llm: LlmClient, schema: z.ZodType<T>, args: { system: string; prompt: string }): Promise<T>`:
  - Append the instruction "Reply with only a JSON object matching this shape:" plus a compact JSON example derived from the schema description.
  - Extract the first balanced `{...}` from the reply, `JSON.parse` it, then `schema.parse` it.
  - On failure, retry once with the validation error appended.
  - Then throw `LlmOutputError` with the `raw` text.
  - Network or connection errors (including Ollama not running) are wrapped as `LlmUnavailableError`.
- Produces `createFakeLlm(replies: (string | Error)[]): LlmClient & { calls: { system: string; prompt: string }[] }` in `tests/main/llm/fakeLlm.ts`, used by later tasks.

- [ ] **Step 1: Failing tests:**
  - `parses JSON wrapped in prose and code fences`
  - `retries once with validation error then succeeds`: the fake's second call prompt contains the zod error text
  - `throws LlmOutputError after two bad replies` (Review Focus 4)
  - `wraps ECONNREFUSED as LlmUnavailableError`
  - `listModels reads data ids from a custom localhost endpoint`: a fake `fetchFn` asserts the URL `http://localhost:20128/v1/models` (from baseUrl `http://localhost:20128/v1/`) and the Bearer header, and returns `{data:[{id:'b'},{id:'a'}]}` → `['a','b']`
  - `listModels sends no Authorization header when key is empty`
  - `listModels maps 401 to LlmAuthError`
  - `huggingface uses the HF router base URL`: pass a fake `fetch` into the openai-compatible provider (its `fetch` option) and assert the request goes to `https://router.huggingface.co/v1/chat/completions` with the token as Bearer
- [ ] **Step 2:** Run `npx vitest run tests/main/llm`. Expected: FAIL.
- [ ] **Step 3:** Implement. Don't use the AI SDK's `generateObject`. Small local models often lack JSON mode, so the text-plus-parse path is the single code path.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: provider-agnostic LLM client with tolerant structured output`.

---

### Task 5: Profile intake (resume → profile, corrections, rules)

**Files:**
- Create: `src/main/profile/resumeText.ts`, `src/main/profile/profileBuilder.ts`, `src/main/profile/rules.ts`
- Test: `tests/main/profile/profile.test.ts`, fixtures `tests/fixtures/resume.pdf`, `tests/fixtures/resume.docx`, `tests/fixtures/scanned.pdf` (image-only)

**Interfaces:**
- Produces `extractResumeText(filePath: string): Promise<string>`. PDF uses `unpdf`'s `extractText`; DOCX uses `mammoth.extractRawText`. If fewer than 200 non-whitespace chars come out, it throws `ResumeUnreadableError` with the message "This resume looks like a scanned image. Export it as a text PDF or paste your experience instead."
- Produces `buildProfile(llm: LlmClient, input: { resumeText: string; pastedText: string; links: string[]; previous: Profile | null; timezone: string }): Promise<Profile>`. It uses `generateStructured` with a zod `ProfileSchema` mirroring `Profile`. It keeps `previous.preferences`, `rules`, `signOff` and `resumePath` when they're present.
- Produces `summarizeBack(profile: Profile): string`. This is a deterministic one-paragraph summary used by the UI. It names the latest title or company, the years of experience, and the 2 projects with metrics.
- Produces `addRule(llm: LlmClient, rules: Rule[], text: string): Promise<Rule[]>`. The LLM returns `{ topic, forbiddenTerms }`, and a rule with the same `topic` (case-insensitive) is replaced, not duplicated.
- Produces `applyCorrection(llm: LlmClient, profile: Profile, correction: string): Promise<Profile>`. It returns the updated profile, e.g. "2 years, not 4" sets `yearsExperience: 2`.

- [ ] **Step 1: Failing tests:**
  - `extracts text from pdf and docx fixtures`
  - `scanned pdf throws ResumeUnreadableError`
  - `buildProfile keeps previous rules and preferences` (fake LLM)
  - `addRule replaces same topic`: "never mention crypto", then "don't mention crypto or web3", leaves 1 rule with forbiddenTerms `['crypto','web3']`
  - `applyCorrection updates yearsExperience`
- [ ] **Step 2:** Run `npx vitest run tests/main/profile`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: resume parsing, profile builder, rules and corrections`.

---

### Task 6: HTTP helper, source interface, normalization, funding RSS, HN hiring

**Files:**
- Create: `src/main/net/http.ts`, `src/main/sources/types.ts`, `src/main/sources/normalize.ts`, `src/main/sources/rssFunding.ts`, `src/main/sources/hnHiring.ts`
- Test: `tests/main/sources/rss-hn.test.ts`, `tests/main/net/http.test.ts`, fixtures `tests/fixtures/rss/{techcrunch,inc42,entrackr,yourstory}.xml`, `tests/fixtures/hn/{search.json,item.json}`

**Interfaces:**
- Produces `type Fetcher = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number }) => Promise<{ status: number; text: string; url: string }>`.
- Produces `createFetcher(): Fetcher`:
  - User-Agent `Sidedoor/0.1 (+https://github.com/<owner>/sidedoor)`, default timeout 15000 ms.
  - Throws `BlockedDomainError` for hosts ending in `linkedin.com`, `crunchbase.com`, `wellfound.com`, `angel.co`.
- Produces `interface SourceContext { fetch: Fetcher; llm: LlmClient; profile: Profile; now: Date; secrets: SecretStore; settings: Settings }`.
- Produces `interface Source { id: string; label: string; fetchCandidates(ctx: SourceContext): Promise<Candidate[]> }`. The signals inside the candidates carry the precise `SourceId`, e.g. one `rssFunding` source emits `techcrunch`/`inc42`/`entrackr`/`yourstory`.
- Produces `domainKey(website: string | null, name: string): string`. It lowercases the host, strips `www.`, scheme, path, port and trailing dot, giving `acme.ai`. With no website it returns `name:` + the lowercased name with non-alphanumerics removed.
- Produces `deobfuscateEmails(text: string): string`, which turns `x [at] y [dot] com`, `x(at)y.com` and `x at y dot com` into `x@y.com`.
- Produces `extractEmails(text: string): string[]`. It runs after deobfuscation and returns lowercased, unique addresses.
- Produces `FUNDING_FEEDS: { id: SourceId; url: string }[]`, each URL verified in planning:
  - techcrunch: `https://techcrunch.com/category/venture/feed/`
  - inc42: `https://inc42.com/buzz/feed/`
  - entrackr: `https://entrackr.com/rss`
  - yourstory: `https://yourstory.com/feed`
- Produces `rssFundingSource: Source`:
  - Parse each feed with fast-xml-parser and keep items from the last 7 days.
  - Send the item titles and descriptions to the LLM in one batch per feed. Schema: array of `{ itemIndex, isFundingNews, companyName, website|null, round: Stage|null, amount: string|null, country|null }`.
  - Emit a `raised` signal with detail `"raised {amount} {round}"` and the item date and URL.
  - A failing feed is skipped, not fatal.
- Produces `hnHiringSource: Source`:
  - Find the newest story by `author_whoishiring` whose title starts with "Ask HN: Who is hiring", via `https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5`.
  - Load `https://hn.algolia.com/api/v1/items/{id}` and parse top-level comments.
  - The first line is split by `|`. Segment 0 is the company. Segments matching `/remote/i` set `remote=true`. The first URL is the website.
  - Emails come from `extractEmails` on the full comment, with `url = https://news.ycombinator.com/item?id={commentId}`.
  - Emit a `hiring` signal. Comments that are deleted or lack a `|` first line are skipped.

- [ ] **Step 1:** Save the fixtures: real responses from each URL above via curl, trimmed to about 5 items each.
- [ ] **Step 2: Failing tests:**
  - `fetcher refuses wellfound.com and www.crunchbase.com`
  - `domainKey normalizes https://www.Acme.ai/about/ to acme.ai`
  - `domainKey falls back to name: key`
  - `deobfuscates "jobs [at] acme [dot] io"`
  - `rss source emits raised signal with feed item url` (fake fetch + fake LLM)
  - `rss source skips failing feed`
  - `hn source parses company, remote, website and email with comment url`
- [ ] **Step 3:** Run `npx vitest run tests/main/sources tests/main/net`. Expected: FAIL.
- [ ] **Step 4:** Implement per the Interfaces.
- [ ] **Step 5:** Run it again. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: http helper, source normalization, funding RSS and HN hiring sources`.

---

### Task 7: YC, Product Hunt and GitHub sources

**Files:**
- Create: `src/main/sources/yc.ts`, `src/main/sources/productHunt.ts`, `src/main/sources/github.ts`
- Test: `tests/main/sources/yc-ph-gh.test.ts`, fixtures `tests/fixtures/yc/hiring.json` (20 entries), `tests/fixtures/ph/{graphql.json,feed.xml}`, `tests/fixtures/gh/{search.json,org.json}`

**Interfaces:**
- Produces `ycSource: Source`:
  - Fetch `https://yc-oss.github.io/api/companies/hiring.json`. Fields: `name, website, one_liner, all_locations, regions, batch, status, isHiring, stage, url`.
  - Keep `status === 'Active'` from the 8 most recent distinct batches. Batch order is parsed from "Season YYYY", with seasons ordered Winter < Spring < Summer < Fall.
  - Country and city come from the first `all_locations` segment, using a small country-name → ISO map from Task 9's `timezones.ts`.
  - `remote = regions.includes('Remote')`. Signal `hiring`, detail `"YC {batch}, hiring"`, url = the `url` field.
  - Cache the raw JSON in `MetaRepo` under `yc.cache` with a date, refetching at most once a day.
- Produces `productHuntSource: Source`:
  - With `producthunt.token`, POST GraphQL to `https://api.producthunt.com/v2/api/graphql` for `posts(order: NEWEST, postedAfter: now-3d, first: 50) { name tagline website url createdAt }`.
  - Without a token, parse `https://www.producthunt.com/feed`.
  - Signal `launched`, detail `"launched on Product Hunt: {tagline}"`.
- Produces `githubSource: Source`:
  - `GET https://api.github.com/search/repositories?q=created:>{now-30d}+stars:>200&sort=stars&per_page=30`, with a `github.token` bearer if set.
  - Keep owners with `type === 'Organization'`, then `GET /orgs/{login}` and take `blog` as the website. Skip orgs with an empty `blog` or more than 200 public repos (likely not a startup).
  - Signal `launched`, detail `"open-source {repo} gained {stars}★"`.

- [ ] **Step 1: Failing tests:**
  - `yc keeps only active companies from recent batches and maps location`
  - `yc uses cache within same day` (the fake fetch is called once across 2 runs)
  - `ph uses graphql with token`
  - `ph falls back to rss without token`
  - `github keeps org owners with blog and skips users`
- [ ] **Step 2:** Run `npx vitest run tests/main/sources/yc-ph-gh.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: YC, Product Hunt and GitHub sources`.

---

### Task 8: Careers enrichment and web search source

**Files:**
- Create: `src/main/enrich/careers.ts`, `src/main/sources/webSearch.ts`
- Test: `tests/main/enrich/careers.test.ts`, `tests/main/sources/websearch.test.ts`

**Interfaces:**
- Produces `interface OpenRole { title: string; location: string | null; remote: boolean | null; url: string }`.
- Produces `findOpenRoles(fetch: Fetcher, company: { name: string; website: string | null; careersHtml: string | null }): Promise<OpenRole[]>`:
  1. Detect board slugs from links in `careersHtml` (`boards.greenhouse.io/{slug}`, `job-boards.greenhouse.io/{slug}`, `jobs.lever.co/{slug}`, `jobs.ashbyhq.com/{slug}`, `apply.workable.com/{slug}`).
  2. Otherwise try the slug made from the domain label (e.g. `acme` from `acme.ai`).
  3. Query:
     - `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`
     - `https://api.lever.co/v0/postings/{slug}?mode=json`
     - `https://api.ashbyhq.com/posting-api/job-board/{slug}`
     - `https://apply.workable.com/api/v1/widget/accounts/{slug}`

  A 404 means no board, and the first board that answers wins.
- Produces `interface SearchProvider { search(query: string, opts: { days: number; max: number }): Promise<{ title: string; url: string; snippet: string; publishedAt: string | null }[]> }`.
  - `createSearchProvider(kind: 'tavily' | 'brave' | 'exa', apiKey: string, fetch: Fetcher): SearchProvider`:
    - Tavily: POST `https://api.tavily.com/search` with `{ query, max_results, days, topic: 'news' }`.
    - Brave: GET `https://api.search.brave.com/res/v1/web/search?q=&freshness=pw` with header `X-Subscription-Token`.
    - Exa: POST `https://api.exa.ai/search` with `{ query, numResults, startPublishedDate }` and header `x-api-key`.
- Produces `webSearchSource: Source`. It is a no-op returning `[]` when `settings.searchProvider` is null or the key is missing.
  - Queries are built from the profile:
    - `"{role} startup raised seed OR series A {region}"`
    - `"startup hiring {role} {region OR remote}"`
    - `"site:wellfound.com {role} startup"`
    - `"site:crunchbase.com seed round {region}"`
  - Use roles[0..1] and the profile's region, with up to 6 queries, `days: 7`, `max: 10`.
  - The LLM extracts `{ companyName, website|null, signalKind, detail, country|null }` from the titles and snippets only. Result URLs on blocked domains are never fetched; they become the signal `url` only.

- [ ] **Step 1: Failing tests:**
  - `detects lever slug from careers html and returns roles`
  - `falls back to domain-label slug on greenhouse`
  - `404 on all boards returns []`
  - `web search source returns [] without provider`
  - `wellfound result is used as signal url but never fetched`: the fake fetch throws if called with wellfound
- [ ] **Step 2:** Run `npx vitest run tests/main/enrich tests/main/sources/websearch.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: careers job-board enrichment and web search source`.

---

### Task 9: Dedupe, screening, fit scoring and time zones

**Files:**
- Create: `src/main/screening/timezones.ts`, `src/main/screening/screen.ts`, `src/main/screening/fitScore.ts`
- Test: `tests/main/screening/screening.test.ts`

**Interfaces:**
- Produces in `timezones.ts`:
  - `countryFromText(s: string): string | null`, matching country names and common cities to ISO codes, covering at least US, IN, GB, CA, DE, FR, SG, AE, AU, NL, IL, BR.
  - `timezoneFor(country: string | null, city: string | null): string | null`. City wins when known (e.g. San Francisco → America/Los_Angeles, New York → America/New_York, Bengaluru/Bangalore → Asia/Kolkata). Country defaults: US→America/New_York, IN→Asia/Kolkata, GB→Europe/London, CA→America/Toronto, DE→Europe/Berlin, FR→Europe/Paris, SG→Asia/Singapore, AE→Asia/Dubai, AU→Australia/Sydney, NL→Europe/Amsterdam, IL→Asia/Jerusalem, BR→America/Sao_Paulo.
- Produces `dedupe(candidates: Candidate[], existingKeys: Set<string>): { key: string; candidate: Candidate }[]`. It merges candidates with the same `domainKey` (union of signals and emails, first non-null of the other fields). It drops keys in `existingKeys`, which are companies that already have any lead. A name-only candidate whose normalized name equals the name of a website candidate merges into that one.
- Produces `screen(c: Candidate, profile: Profile): { pass: true } | { pass: false; reason: 'excluded' | 'location' | 'stage' }`:
  - `excluded` if any `preferences.exclusions` term appears in the name or description (case-insensitive).
  - `stage` if `c.stage` is known and not in `preferences.stages` (an empty stages list allows all).
  - `location` if `c.remote === false` and `c.country` is known and differs from `homeCountry` and isn't in `preferences.locations`. Unknown location passes.
- Produces `scoreFit(llm, c: Candidate, roles: OpenRole[], profile: Profile): Promise<{ score: number; whyFit: string; couldDoWork: boolean; hiresInRegion: 'yes' | 'no' | 'unknown' }>`. `whyFit` must name one user project or experience and one startup fact. A candidate is kept only if `score >= 60 && couldDoWork && hiresInRegion !== 'no'`.

- [ ] **Step 1: Failing tests:**
  - `dedupe merges www/https/path variants into one` (Review Focus 1)
  - `dedupe drops already-contacted keys`
  - `dedupe merges name-only into website candidate with same name`
  - `screen excludes by term`
  - `screen rejects onsite foreign company, passes remote one, passes unknown`
  - `timezoneFor prefers city`
  - `scoreFit parses LLM result` (fake)
- [ ] **Step 2:** Run `npx vitest run tests/main/screening`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: dedupe, screening, fit scoring, timezones`.

---

### Task 10: Contact finding (published addresses only)

**Files:**
- Create: `src/main/contacts/findContacts.ts`
- Test: `tests/main/contacts/contacts.test.ts`, fixtures `tests/fixtures/site/{home,team,careers}.html`

**Interfaces:**
- Produces `GENERIC_LOCALPARTS` (the list in Global Constraints) and `HIRING_LOCALPARTS = ['jobs','careers','hiring','talent','recruiting','recruitment','hr','work','joinus','join','apply']`.
- Produces `fetchCompanyPages(fetch: Fetcher, website: string): Promise<{ url: string; html: string }[]>`:
  - Paths: `/`, `/about`, `/about-us`, `/team`, `/company`, `/careers`, `/jobs`, `/contact`, all on the same host, at most 8.
  - Errors are skipped, with a 10 s timeout each.
- Produces `findContacts(llm: LlmClient, input: { companyDomain: string | null; sourceEmails: FoundEmail[]; pages: { url: string; html: string }[] }): Promise<Contact[]>`:
  1. Collect addresses from `mailto:` links and from `extractEmails(deobfuscateEmails(text))` of each page, plus `sourceEmails`.
  2. Keep addresses whose domain equals `companyDomain` or a subdomain of it, or that came from `sourceEmails` (posts may list a personal Gmail).
  3. Drop generic local parts.
  4. Classify: a hiring local part becomes `hiring_inbox`; otherwise `person`.
  5. One LLM call over the surrounding page text links each `person` address to a name and role. A role matching `/founder|ceo|cto|co-founder/i` becomes `founder`.
  6. Sort: founder > person > hiring_inbox.
- **Invariant:** every returned `email` appears in the input texts or `sourceEmails` after deobfuscation. Addresses the LLM invents are discarded.

- [ ] **Step 1: Failing tests:**
  - `finds founder email on team page with sourceUrl`
  - `excludes info@ and support@`
  - `classifies careers@ as hiring_inbox`
  - `keeps gmail address only when it came from sourceEmails`
  - `discards an address the LLM invents`: the fake LLM returns `ceo@acme.ai`, which isn't in any page, so it isn't in the result
  - `returns [] when nothing published`
- [ ] **Step 2:** Run `npx vitest run tests/main/contacts`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: published-only contact finding`.

---

### Task 11: Drafting and quality checks

**Files:**
- Create: `src/main/drafting/draftEmail.ts`, `src/main/drafting/checkDraft.ts`
- Test: `tests/main/drafting/drafting.test.ts`

**Interfaces:**
- Produces `type GateFailure = 'length' | 'startup_detail' | 'user_detail' | 'forbidden_term' | 'sign_off' | 'placeholder' | 'subject'`.
- Produces `checkDraft(d: Draft, ctx: { kind: 'first' | 'followup'; rules: Rule[]; signOff: string | null }): { ok: true } | { ok: false; failures: GateFailure[] }`:
  - `length`: word count of `body` is 80–150 for first emails and 20–80 for follow-ups.
  - `startup_detail` / `user_detail`: `startupDetail` and `userDetail` are each non-empty and appear in `body` (case-insensitive, whitespace-collapsed).
  - `forbidden_term`: any `rules[].forbiddenTerms` appears in the subject or body as a whole word, case-insensitive.
  - `sign_off`: when `signOff` is set, the trimmed body ends with it and it occurs exactly once.
  - `placeholder`: the body matches `/\[[^\]]{2,}\]|\{\{|\}\}|<[a-z_ ]+>|lorem ipsum|your name|company name/i`.
  - `subject`: the subject is empty, longer than 80 chars, or contains a placeholder; for follow-ups the subject must equal `"Re: " + original subject`.
- Produces `draftFirstEmail(llm, ctx: { profile: Profile; company: Company; roles: OpenRole[]; contact: Contact; whyFit: string }): Promise<Draft>`. The system prompt sets the voice: short, specific, the user's voice, no buzzwords, 80–150 words, applying `rules` and `signOff`, and citing 1–2 user projects with real numbers from the profile. It mentions visa status only when `preferences.visa` is set and the company is in another country. It regenerates once if `checkDraft` fails, then returns the best attempt (the caller decides what to do).
- Produces `reviseDraft(llm, draft: Draft, instruction: string, ctx: same as above): Promise<Draft>`.
- Produces `draftFollowUp(llm, ctx: { profile: Profile; company: Company; thread: MailMessage[]; n: 1 | 2 | 3 }): Promise<Draft>`. It's written at send time, references the original email, adds one new angle, and #3 is a polite close.

- [ ] **Step 1: Failing tests:**
  - `passes a good first email` (a hand-written 110-word body)
  - `fails length for 40-word first email`
  - `fails forbidden_term for crypto`
  - `fails sign_off when missing or doubled`
  - `fails placeholder for [Company Name]`
  - `fails startup_detail when detail not in body`
  - `draftFirstEmail retries once on gate failure` (fake LLM: bad, then good; 2 calls)
  - `follow-up failing gates is returned with failures` (the caller marks needsApproval in Task 14; this test asserts that `checkDraft` returns `ok:false`) (Review Focus 4)
- [ ] **Step 2:** Run `npx vitest run tests/main/drafting`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: email drafting with quality gates`.

---

### Task 12: SMTP sending, presets and connection test

**Files:**
- Create: `src/main/mail/presets.ts`, `src/main/mail/smtpSender.ts`
- Test: `tests/main/mail/smtp.test.ts` (uses the `smtp-server` dev dependency on an ephemeral port)

**Interfaces:**
- Produces `MAIL_PRESETS: Record<Exclude<MailPreset, 'other'>, Omit<MailSettings, 'address' | 'preset'>>`:
  - gmail: smtp.gmail.com:465, imap.gmail.com:993, sentMailbox `[Gmail]/Sent Mail`
  - zoho: smtp.zoho.com:465, imap.zoho.com:993, `Sent`
  - zoho_in: smtp.zoho.in:465, imap.zoho.in:993, `Sent`
- Produces `presetForAddress(address: string): MailPreset`: `gmail.com`/`googlemail.com` → gmail; `zoho.com` → zoho; `zoho.in` → zoho_in; anything else → `other` (Google Workspace users pick gmail manually).
- Produces `interface OutgoingMail { to: string; subject: string; text: string; inReplyTo: string | null; references: string[]; attachmentPath: string | null }`.
- Produces `interface MailSender { send(m: OutgoingMail): Promise<{ messageId: string; at: string }>; verify(): Promise<void> }`.
  - `createSmtpSender(cfg: MailSettings, password: string, opts?: { tls?: { rejectUnauthorized: boolean } }): MailSender` uses nodemailer. It generates `Message-ID` as `<{uuid}@{sender domain}>` and sets `In-Reply-To`/`References` when given.
  - It sends plain text only, with no tracking pixels or link rewriting.
  - Auth failures (nodemailer `EAUTH` or response code 535) throw `MailAuthError`. Other failures throw `MailSendError`.

- [ ] **Step 1: Failing tests** against a local `smtp-server` (secure false, auth that accepts `pw`):
  - `sends plain text with Message-ID`
  - `follow-up carries In-Reply-To and References`
  - `wrong password throws MailAuthError`
  - `attachment included when attachmentPath set`
  - `presetForAddress maps gmail/zoho/zoho.in/other`
- [ ] **Step 2:** Run `npx vitest run tests/main/mail/smtp.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces. The test passes `opts` for the plain local server.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: SMTP sender with threading headers and presets`.

---

### Task 13: IMAP reading and incoming classification

**Files:**
- Create: `src/main/mail/imapReader.ts`, `src/main/mail/classifyIncoming.ts`
- Test: `tests/main/mail/classify.test.ts`, fixtures `tests/fixtures/mail/{reply.eml,reply-other-sender.eml,bounce-gmail.eml,ooo.eml,unrelated.eml,user-sent.eml}`

**Interfaces:**
- Produces `interface ParsedMail { messageId: string; inReplyTo: string | null; references: string[]; from: string; to: string[]; subject: string; text: string; date: string; headers: Record<string, string>; mailbox: 'inbox' | 'sent' }`.
- Produces `interface MailReader { fetchNew(): Promise<ParsedMail[]>; verify(): Promise<void> }`.
  - `createImapReader(cfg: MailSettings, password: string, meta: MetaRepo): MailReader` uses imapflow and mailparser.
  - It reads INBOX and `cfg.sentMailbox` for UIDs above the last seen one (stored in `MetaRepo` as `imap.lastUid.{mailbox}` along with `uidValidity`; a changed uidValidity resets to the last 7 days).
  - Auth failure throws `MailAuthError` (from Task 12).
- Produces `testMailbox(sender: MailSender, reader: MailReader, address: string): Promise<{ ok: true } | { ok: false; error: string }>` in `imapReader.ts`. It sends "Sidedoor test email" to `address`, then runs `reader.verify()`, returning the first error's message.
- Produces `type Classified = { kind: 'reply' | 'ooo' | 'user'; leadId: number; mail: ParsedMail } | { kind: 'bounce'; leadId: number; failedRecipient: string; mail: ParsedMail } | { kind: 'unrelated' }`.
- Produces `classifyIncoming(mail: ParsedMail, lookup: { byMessageId(mid: string): MailMessage | null; byContactEmail(email: string): Lead[] }, ownOutgoingIds: (mid: string) => boolean): Classified`, applying the first match in order:
  1. `mailbox === 'sent'`: if its `references`/`inReplyTo` hit a known outgoing message and `ownOutgoingIds(messageId)` is false → `user`. Otherwise → `unrelated`.
  2. A bounce: `from` matches `/mailer-daemon|postmaster/i`, or the content type is `multipart/report; report-type=delivery-status`. The failed recipient comes from `X-Failed-Recipients`, or else `Final-Recipient` in the text, and is matched via `byContactEmail`.
  3. Thread match: any of `inReplyTo` and `references` hits `byMessageId` → that lead. Fallback: the `from` address equals a lead's contact email AND the subject starts with `Re:`.
  4. Within a matched thread, it's `ooo` if the `Auto-Submitted` header is set and isn't `no`, or `X-Autoreply`/`X-Autorespond` is present, or `Precedence: auto_reply`, or the subject matches `/out of (the )?office|automatic reply|auto-?reply|on vacation|away from/i`. Otherwise it's `reply`.
  5. Otherwise `unrelated`.

- [ ] **Step 1: Failing tests** (parse the `.eml` fixtures with mailparser into `ParsedMail`):
  - `reply matched by In-Reply-To`
  - `reply from different sender matches by references` (Review Focus 5)
  - `gmail bounce yields failedRecipient and lead`
  - `ooo detected by Auto-Submitted header`
  - `user message in Sent with our references is kind user`
  - `our own sent follow-up is unrelated`
  - `unrelated newsletter is unrelated`
- [ ] **Step 2:** Run `npx vitest run tests/main/mail/classify.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `classifyIncoming`. Implement `createImapReader` as a thin wrapper; it's verified manually in Task 18.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: IMAP reader and incoming mail classification`.

---

### Task 14: Outreach scheduling and engine

**Files:**
- Create: `src/main/outreach/schedule.ts`, `src/main/outreach/engine.ts`
- Test: `tests/main/outreach/schedule.test.ts`, `tests/main/outreach/engine.test.ts`

**Interfaces:**
- Produces `nextSendSlot(at: DateTime, zone: string): DateTime` (Luxon). It returns `at` if it falls Mon–Fri 09:00 ≤ t < 17:00 in `zone`. Otherwise it returns the next weekday at 09:00 in `zone`.
- Produces `followUpDue(lastSentAt: DateTime, followUpsSent: 0 | 1 | 2, zone: string): DateTime`, which is `nextSendSlot(lastSentAt.plus({ days: [3, 4, 5][followUpsSent] }), zone)`.
- Produces `capRemaining(leads: LeadRepo, now: DateTime, userZone: string, dailyCap: number): number`. It counts `firstSentAt` within the user's local calendar day and uses `clampSettings` limits.
- Produces `zoneForLead(company: Company, profile: Profile): string`, which is `timezoneFor(company.country, company.city) ?? profile.timezone`.
- Produces the engine:

```ts
interface EngineDeps {
  repos: { leads: LeadRepo; messages: MessageRepo; companies: CompanyRepo; profile: ProfileRepo; settings: SettingsRepo }
  sender: () => MailSender | null; reader: () => MailReader | null
  llm: () => LlmClient | null; now: () => DateTime; emit: (e: EngineEvent /* src/shared/types.ts */) => void
}
class OutreachEngine {
  constructor(deps: EngineDeps)
  tick(): Promise<void>                 // poll → follow-ups → queued first emails
  poll(): Promise<void>
  approve(leadId: number): void          // drafted → queued (requires contact + draft passing checkDraft)
  skip(leadId: number): void             // → skipped
  cancelFollowUps(leadId: number): void  // status stays 'sent', nextActionAt = null, followUpsSent unchanged
  followUpNow(leadId: number): Promise<void>
  markInterview(leadId: number): void
}
```

- `tick` order is required: `poll()` first, then due follow-ups, then queued first emails. If `settings.paused`, it only polls.
- Applying classifications:
  - `reply` → status `replied`, `nextActionAt=null`, insert an `in` message, emit `reply`.
  - `user` → `nextActionAt=null` (the user took over), status unchanged.
  - `ooo` → `nextActionAt = max(nextActionAt, followUpDue(mail.date, followUpsSent))`.
  - `bounce` → status `bounced`, `nextActionAt=null`, emit `bounce`. Finding another contact is done by the pipeline on the next picks run, which asks the user.
- Sending a first email:
  - Requires status `queued`, `capRemaining > 0`, and `now` inside `nextSendSlot(now, zone)`.
  - It attaches `profile.resumePath` when `settings.attachResume` is true; follow-ups never carry attachments.
  - On success: status `sent`, `firstSentAt=now`, insert an `out` message (`kind:'first'`), `nextActionAt = followUpDue(now, 0, zone)`.
- Sending a follow-up:
  - Draft it with `draftFollowUp`.
  - If `checkDraft(...kind:'followup')` fails or the LLM throws, set `needsApproval=true` and store the draft on the lead (`lead.draft`), don't send, and emit `error`.
  - Otherwise send it with `inReplyTo` = the last message's id and `references` = all thread ids, increment `followUpsSent`, and set `nextActionAt` = the next due date, or `null` after #3.
- `MailAuthError` anywhere: `settings.paused=true`, `pauseReason='mail_auth_failed'`, emit `paused`, and stop this tick. The lead being processed keeps its previous status.

- [ ] **Step 1: Failing schedule tests:**
  - `Saturday 10:00 IST → Monday 09:00 IST`
  - `Friday 17:30 → Monday 09:00`
  - `Tuesday 08:00 → Tuesday 09:00`
  - `Tuesday 10:00 unchanged`
  - `follow-up gaps are 3, 4, 5 days`
  - `capRemaining counts by user's local day across UTC midnight`: user in Asia/Kolkata, one email at 2026-11-02T20:00Z (= Nov 3 01:30 IST), now Nov 3 10:00 IST → 9 remaining with cap 10
- [ ] **Step 2: Failing engine tests** (in-memory repos, fake sender/reader/LLM, fixed clock):
  - `tick polls before sending`: a reader returns a reply for lead A, whose follow-up is overdue, so no follow-up is sent and A is `replied` (Review Focus 2)
  - `auth failure pauses`: the sender throws `MailAuthError`, so settings are paused with `mail_auth_failed`, the lead stays `queued`, and a second tick sends nothing (Review Focus 3)
  - `respects daily cap`: 12 queued, cap 10 → 10 sent
  - `attaches resume only to first email when attachResume`
  - `outside send window sends nothing`
  - `follow-up failing gates needs approval and is not sent`
  - `third follow-up clears nextActionAt`
  - `ooo postpones next follow-up`
  - `bounce marks lead bounced`
  - `paused only polls`
- [ ] **Step 3:** Run `npx vitest run tests/main/outreach`. Expected: FAIL.
- [ ] **Step 4:** Implement per the Interfaces.
- [ ] **Step 5:** Run it again. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: outreach scheduling and engine`.

---

### Task 15: Daily picks pipeline, scheduler, IPC and preload API

**Files:**
- Create: `src/main/pipeline/runPicks.ts`, `src/main/app/scheduler.ts`, `src/main/app/ipc.ts`, `src/main/container.ts`, `src/shared/api.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`
- Test: `tests/main/pipeline/runPicks.test.ts`, `tests/main/app/scheduler.test.ts`

**Interfaces:**
- Produces `ALL_SOURCES: Source[] = [ycSource, rssFundingSource, hnHiringSource, productHuntSource, githubSource, webSearchSource]`.
- Produces `runPicks(deps: { sources: Source[]; ctx: SourceContext; repos; limit: number; maxResearch: number }): Promise<{ picked: number; drafted: number; noContact: number; sourceErrors: { source: string; message: string }[] }>`:
  1. Run `Promise.allSettled` over the sources. Rejections go to `sourceErrors`.
  2. `dedupe` against the keys of companies that have any lead.
  3. `screen`.
  4. Prefer candidates with a `hiring` signal and the newest signal date. Take `maxResearch` (default 20) of them.
  5. For each: `fetchCompanyPages` → `findOpenRoles` (with `careersHtml` from the `/careers` page) → `scoreFit`.
  6. Keep the qualifying ones, sort by score, and take `limit` (= `settings.picksPerDay`).
  7. Upsert each company. If a contact is found, run `draftFirstEmail` and create a lead with status `drafted`. Otherwise create a lead with status `picked`, `contact=null`, `lastError='no published contact found'`.
  8. Bounced leads from earlier runs: retry `findContacts`, excluding the bounced address. If one is found, store it with status `drafted` (a new draft) so the user approves again.
- Produces `Scheduler`, with `start()`, `stop()` and `runNow(kind: 'picks' | 'tick')`:
  - Engine `tick` every 60 s, and immediately on start.
  - `poll` every 10 min (included in tick through a `lastPollAt` guard).
  - Picks when local time ≥ `settings.pickTime` and `meta['picks.lastRunDate']` isn't today. Checked on every tick, so a late start catches up.
  - Ticks never overlap; a single-flight guard is required.
- Produces `src/shared/api.ts`, the `SidedoorApi` exposed as `window.sidedoor`:

```ts
interface SidedoorApi {
  settings: { get(): Promise<Settings>; save(s: Settings): Promise<Settings>; setSecret(k: SecretKey, v: string): Promise<void>; hasSecret(k: SecretKey): Promise<boolean>; testMailbox(): Promise<{ ok: boolean; error?: string }>; testAi(): Promise<{ ok: boolean; error?: string }>; listModels(): Promise<{ models: string[]; error?: string }> }
  profile: { get(): Promise<Profile | null>; importResume(path: string, pastedText: string, links: string[]): Promise<{ profile: Profile; summary: string }>; save(p: Profile): Promise<Profile>; correct(text: string): Promise<Profile>; addRule(text: string): Promise<Profile>; removeRule(topic: string): Promise<Profile> }
  picks: { run(): Promise<{ picked: number; drafted: number; noContact: number; sourceErrors: { source: string; message: string }[] }> }
  leads: { list(status?: LeadStatus[]): Promise<(Lead & { company: Company; messages: MailMessage[] })[]>; approve(id: number): Promise<void>; skip(id: number): Promise<void>; revise(id: number, instruction: string): Promise<Lead>; editDraft(id: number, d: Pick<Draft, 'subject' | 'body'>): Promise<Lead>; setContact(id: number, email: string): Promise<Lead>; followUpNow(id: number): Promise<void>; cancelFollowUps(id: number): Promise<void>; markInterview(id: number): Promise<void> }
  outreach: { pause(): Promise<void>; resume(): Promise<void>; stats(): Promise<{ sentThisWeek: number; replies: number; interviews: number; dueToday: number; capRemaining: number; paused: boolean; pauseReason: Settings['pauseReason'] }> }
  data: { deleteEverything(): Promise<void> }
  onEvent(cb: (e: EngineEvent | { type: 'picks_ready'; drafted: number }) => void): () => void
  pathForFile(f: File): string   // preload wraps webUtils.getPathForFile
}
```

- More rules for the API:
  - `editDraft` sets `startupDetail`/`userDetail` to empty strings, and `approve` then skips those two gates for user-edited text. The user's own words are trusted; length, placeholder and forbidden-term checks still apply.
  - `setContact` accepts only a syntactically valid email, with `kind:'person'` and `sourceUrl:'user-entered'`, then drafts if no draft exists.
  - `importResume` copies the file into `{userData}/resume{ext}` and stores that path.
  - `settings.save` rejects with the `validateAiSettings` message when the AI settings are invalid.
  - `testAi` sends one short prompt ("Reply with the word ok.") through the saved settings and succeeds on any non-empty reply. It returns `LlmAuthError`/`LlmUnavailableError` messages as `error` and never throws.
  - `listModels` returns `{ models: [] }` for openai/anthropic/google, where the user types the model name.

- [ ] **Step 1: Failing tests:**
  - `runPicks creates drafted leads up to limit and skips contacted companies`
  - `runPicks records sourceErrors without failing`
  - `runPicks creates picked lead with lastError when no contact`
  - `scheduler runs picks once per day after pickTime`
  - `scheduler catches up when started after pickTime`
  - `ticks do not overlap`
- [ ] **Step 2:** Run `npx vitest run tests/main/pipeline tests/main/app`. Expected: FAIL.
- [ ] **Step 3:** Implement `runPicks` and `Scheduler`. Then wire `container.ts`, which builds the repos from `{userData}/sidedoor.db`, the secret store from `{userData}/secrets.json` + `safeStorage`, and factories that return `null` when settings or secrets are missing. Wire `ipc.ts` (`ipcMain.handle('sidedoor:<group>.<method>')`), and `preload/index.ts` with `contextBridge.exposeInMainWorld('sidedoor', api)`. Keep `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- [ ] **Step 4:** Run `npx vitest run` (the whole suite) and `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5:** Commit: `feat: daily picks pipeline, scheduler, IPC API`.

---

### Task 16: UI foundation and Settings page

**Files:**
- Create: `src/renderer/src/styles/*`, `src/renderer/src/components/*`, `src/renderer/src/pages/Settings.tsx`, `src/renderer/src/lib/api.ts`
- Modify: `src/renderer/src/App.tsx`
- Test: `tests/renderer/settings.test.tsx`

**Interfaces:**
- Consumes `window.sidedoor` (`SidedoorApi`). `lib/api.ts` re-exports it with a typed `declare global`.
- Produces an app shell with a left menu: **Picks, Leads, Profile, Settings**. Milestone 1 has no Home or Replies pages. The app opens on Picks until a profile exists, and on Profile when none does.
- Produces Settings sections:
  1. **AI:** provider select with the labels OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama (on this computer), Hugging Face, and "Other OpenAI-compatible (OmniRoute, LM Studio, Groq…)".
     - Model text field. Defaults: openai `gpt-4.1-mini`, anthropic `claude-haiku-4-5`, google `gemini-2.5-flash`, openrouter `meta-llama/llama-3.3-70b-instruct:free`, ollama `qwen2.5:7b`, huggingface `meta-llama/Llama-3.3-70B-Instruct`, custom empty. The user can edit them. For openrouter, ollama, huggingface and custom, a **Load models** button fills a pick list from `listModels`; typing stays allowed.
     - Key field: labeled "Hugging Face token" for huggingface, with help text "Create a token with the 'Make calls to Inference Providers' permission at huggingface.co/settings/tokens. Free accounts get a small monthly credit." Labeled "Key (leave empty if your endpoint needs none)" for custom. Hidden for ollama.
     - Base URL field: shown for ollama (optional) and custom (required, placeholder `http://localhost:20128/v1`, help text "The address ending in /v1 that your router or server shows.").
     - For custom, one line: "Your resume and drafts go to this address and to whichever AI service it forwards them to."
     - A **Test AI** button shows ok or the error text from `testAi`.
  2. **Mailbox:** address. The preset is auto-chosen from `presetForAddress` and can be overridden, and the server fields show for `other`. App password field, with help text: "Gmail needs 2-Step Verification on, then create an app password at myaccount.google.com/apppasswords." An Outlook address shows "Outlook accounts aren't supported yet." and disables saving. A **Send test email** button shows ok or the error text.
  3. **Outreach:** daily cap (1–20), picks per day (3–5), pick time, attach resume toggle, Pause/Resume showing `pauseReason`. For `mail_auth_failed` the text is "Paused: your mailbox password stopped working. Re-enter it and press Resume."
  4. **Sources:** search provider + key, Product Hunt token, GitHub token. Each has one line saying what it adds and that it's optional.
  5. **Delete everything:** a button with an inline typed confirmation ("delete"). No browser `confirm()`.

- [ ] **Step 1:** Load the `design-taste-frontend-v1` skill and follow it for the shell, tokens, typography and components.
- [ ] **Step 2: Failing tests** (mock `window.sidedoor`):
  - `outlook address disables save and shows message`
  - `daily cap input refuses 25`
  - `delete everything requires typing delete`
  - `custom provider shows base URL and optional key; save blocked without base URL`
  - `huggingface provider labels the key as Hugging Face token`
  - `load models fills the model list from api`
  - `test email shows error text from api`
- [ ] **Step 3:** Run `npx vitest run tests/renderer/settings.test.tsx`. Expected: FAIL.
- [ ] **Step 4:** Implement the shell and the Settings page.
- [ ] **Step 5:** Run it again. Expected: PASS. Then run `npm run dev`, configure a real AI key and Gmail app password, and press **Send test email**. Expected: "Sidedoor test email" arrives in the inbox.
- [ ] **Step 6:** Commit: `feat: app shell and settings page`.

---

### Task 17: Profile page

**Files:**
- Create: `src/renderer/src/pages/Profile.tsx`
- Test: `tests/renderer/profile.test.tsx`

**Interfaces:**
- Consumes `profile.*`.
- Produces:
  - **Import:** pick a resume file (PDF/DOCX) through an `<input type=file>` and resolve its path with `sidedoor.pathForFile(file)`, a "Paste LinkedIn About + Experience" textarea, and a links list. Show the returned `summary` paragraph at the top. A `ResumeUnreadableError` message appears inline.
  - **Edit:** a form for summary, years of experience, projects, and preferences (roles, locations, remote OK, stages as multi-select chips, visa, salary floor, exclusions), plus sign-off and home city/country.
  - **Corrections:** a single input that calls `profile.correct`.
  - **Rules:** a list with remove buttons, plus an input that calls `profile.addRule`.

- [ ] **Step 1:** Keep following the `design-taste-frontend-v1` skill.
- [ ] **Step 2: Failing tests:**
  - `shows summary after import`
  - `shows unreadable resume message`
  - `adding a rule with same topic replaces it in list`
- [ ] **Step 3:** Run `npx vitest run tests/renderer/profile.test.tsx`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run it again. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: profile page`.

---

### Task 18: Picks and Leads pages, end-to-end check

**Files:**
- Create: `src/renderer/src/pages/Picks.tsx`, `src/renderer/src/pages/Leads.tsx`, `src/renderer/src/components/PickCard.tsx`
- Test: `tests/renderer/picks-leads.test.tsx`

**Interfaces:**
- Consumes `picks.run`, `leads.*`, `outreach.stats`, `onEvent`.
- Produces the **Picks** page:
  - A header showing stats from `outreach.stats` (sent this week, replies, interviews, emails left today), and a **Find picks** button that shows the run summary, including any `sourceErrors` as a quiet line.
  - Cards for leads in `drafted`/`picked`/`queued`. Each card shows:
    - name, one-liner, stage, the newest signal ("raised $2.1M seed · Oct 20 · TechCrunch" with a link)
    - **why you fit**
    - the contact, with kind and a "found on" link
  - Card actions:
    - **Send:** approve → shows "Queued: goes out {time} their time" (computed from `nextActionAt`, or "next send window").
    - **Edit:** an instruction box calling `revise`, plus a direct text edit calling `editDraft`.
    - **Skip**
    - **See email:** expands subject and body.
  - A `picked` card without a contact shows "No published email found" and an input calling `setContact`.
  - A `needsApproval` follow-up shows its draft with Send / Edit / Cancel follow-ups.
- Produces the **Leads** page:
  - A table of startup, contact, status chip, and next step.
  - Next step text by state: drafted → "Waiting for your Send"; queued → "Sends {time}"; sent → "Follow-up {n+1} · {date}"; needsApproval → "Follow-up needs your OK"; replied → "Reply in your inbox"; bounced → "Looking for another contact".
  - Filter chips: All, Drafts, Sent, Following up (`sent` with `followUpsSent>0`), Replied, Bounced.
  - Row actions: Send follow-up now, Cancel follow-ups, Mark interview, open thread (lists messages).
- A `reply` event shows an in-app banner "{Founder} at {Company} replied. Check your inbox." Desktop notifications are Milestone 2.

- [ ] **Step 1:** Keep following the `design-taste-frontend-v1` skill.
- [ ] **Step 2: Failing tests:**
  - `send moves card to queued and shows send time`
  - `no-contact card accepts manual email`
  - `following up filter shows only sent with followUpsSent>0`
  - `reply event shows banner`
- [ ] **Step 3:** Run `npx vitest run tests/renderer/picks-leads.test.tsx`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `npx vitest run` and `npm run typecheck`. Expected: all PASS.
- [ ] **Step 6: Manual end-to-end check** with the owner's real accounts. Use a second address the owner controls as the "founder" by setting it as the contact via `setContact` on one pick.
  1. Import the resume. The summary names real projects.
  2. Find picks: at least 1 drafted card, each with a source link and a "found on" link.
  3. Send the self-test lead. During the window it arrives from the owner's Gmail and shows in Sent.
  4. Reply from the second address. Within 10 minutes the lead shows `replied` with the banner, and no follow-up is scheduled.
  5. Revoke the app password. The next tick shows the paused message.
  6. Delete everything returns the app to empty first-run.

  Record the results in the commit message.
- [ ] **Step 7:** Commit: `feat: picks and leads pages; milestone 1 complete`.
