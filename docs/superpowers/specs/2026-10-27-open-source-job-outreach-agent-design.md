# Open-source startup job outreach agent — design

Date: 2026-10-27
Working name: **Sidedoor** (placeholder; final name not decided)

## 1. Intent and why

[Backdoor](https://backdoorai.app/) is a hosted AI job agent that runs over WhatsApp/iMessage. It finds startups that fit you every morning, finds a founder's email, drafts a short personal note, sends it from your Gmail after you approve, and follows up in the same thread until someone replies. Outreach is paid ($29/month, or from ₹20/day in India).

The owner wants an **open-source, self-hosted alternative**: each job seeker runs their own copy, with their own AI key and their own email account, and none of their data passes through a company server. The owner is the first user and will use it for their own job search.

Who it serves after the owner: students, freshers, and working professionals who want to switch jobs. **Startups (pre-seed to Series C) are the main target**, same as Backdoor.

Reference material:
- Backdoor product behaviour: their home page, `/how-it-works`, `/changelog` and `/llms.txt` (summarised in §5).
- A WhatsApp screenshot of a real Backdoor conversation, provided by the owner. It shows the tone and flow the agent should copy (§4.3).

## 2. Goals, non-goals, anti-goals

**Goals (first version)**
- The full Backdoor loop on the user's own machine: profile → daily picks → founder email → draft → user approves → send from their mailbox → up to 3 follow-ups → stop on reply.
- Works with any AI provider, including a free local model, so a student without money can use it.
- A first-run setup a non-technical fresher can finish in under 10 minutes.
- Open source, so anyone can read exactly what gets sent under their name.

**Non-goals (not in the first version)**
- WhatsApp, iMessage, or any phone channel.
- Voice notes.
- Payments, plans, or accounts of any kind.
- Partner intros or a talent pool (these need a company in the middle).
- The 2,000-contact "LIST" sheet.
- A mobile app.
- Big-company / job-board auto-apply.

**Anti-goals (failure even if it technically works)**
- Any first email leaving without the user's explicit Send. Follow-ups are pre-approved by the first Send (as in Backdoor), but the user can cancel them.
- Mass blasting. There is a daily cap (default 10, max 20) on *new* founders contacted.
- Guessing email addresses from name patterns (e.g. `firstname@company.com`). Only addresses found published somewhere are used.
- Generic "AI slop" emails. Every draft must name something specific about the startup *and* something specific the user has done.
- Logging into LinkedIn or any site as the user, or scraping behind a login.
- User data, keys, or email credentials leaving the user's machine, except calls to the AI provider and email server the user configured, and public web fetches for research.

## 3. Constraints

- Runs entirely locally. There is no backend run by the project.
- Bring your own AI key (or a local Ollama model) and your own mailbox.
- The owner is on Windows 11. Windows is the first platform; macOS and Linux builds should not be blocked by design choices.
- Gmail sending uses a **Gmail app password over SMTP/IMAP**, not the Gmail API. Reason: an open-source app can't realistically pass Google's verification for restricted Gmail scopes, and making every user create their own Google Cloud OAuth project is too hard for freshers. App passwords require 2-step verification on the Google account, so setup must explain this. Any other SMTP/IMAP provider (Outlook, Zoho, etc.) should work with the same settings screen.

## 4. Decided by the owner

### 4.1 Form factor
A **desktop app** (my call: Electron + TypeScript + React; see §6) that keeps running in the **system tray**, so scheduled follow-ups and reply checks happen while the window is closed.

### 4.2 Layout
Chosen from mockups (layout "B + C combined"). Mockups are saved in `.superpowers/brainstorm/50-1793040584/content/layout-v2.html`.

- **Left menu:** Home, Picks (badge count), Leads, Replies (badge count), Profile, Settings.
- **Home is the landing screen.** The app opens on it.
  - Centre: a chat with the agent. Picks and drafts appear in the chat as cards with **Send / Edit / Skip / See email** buttons. The user can also type ("make it shorter and mention my open-source work"), drop a resume file, or ask "how's my search going?".
  - Right side panel: this week's stats (sent, replies, interviews) and "Due today" (follow-ups going out today, new replies).
- **Picks:** today's picks as a grid of cards with the same Send / Edit / Skip actions.
- **Leads:** a table of every startup contacted or drafted. Columns: startup, contact, status, next step. Filter chips: All, Drafts, Sent, Following up, Replied, Bounced.
- **Replies:** founder replies, shown with the thread. The user replies from their own mail client; the app does not reply for them.
- **Profile:** what the agent knows about the user (summary, experience, projects, preferences, rules), all editable.
- **Settings:** AI provider, mailbox, daily cap, schedule, data deletion.
- An **"Ask Backdoor"**-style chat button floats on every non-Home page and opens the same conversation.

### 4.2.1 Visual design (owner's decision)
- The interface **must not look like generic AI-generated UI**.
- All frontend work, both the visual design and the React components, is built by following the **`design-taste-frontend-v1`** skill. The builder loads that skill before writing any UI code and follows its rules for type, colour, spacing, motion and layout.
- The wireframes in `.superpowers/brainstorm/` set **layout and structure only**. Their dark colours and emoji icons are placeholders, not the visual direction.
- This applies to Milestone 1 too. Its UI can be less complete, but not generic-looking.

### 4.3 Agent personality (from the owner's WhatsApp screenshot)
- Casual and short: lowercase, the occasional emoji, never corporate.
- After reading the resume it says specific things back to prove it read it, e.g. "ok aarav: you've shipped a real-time inventory app and a WhatsApp bot".
- It asks **one question at a time** during setup: role, location or remote, stage.
- Each pick shows: number, startup name, a one-line description, stage, funding amount and date, what they need, and **why you fit**, tied to the user's own projects.
- A sample draft shows To, Subject and body. The body is short, mentions the startup's product specifically, and cites 1–2 of the user's projects with real numbers.

## 5. How it behaves (the core loop)

These numbers and rules copy Backdoor's documented behaviour and are decided.

### 5.1 Setup (first run, inside the Home chat)
1. Choose an AI provider and paste a key, pick a detected local Ollama model, paste a Hugging Face token, or enter the address of any OpenAI-compatible endpoint (a local router such as OmniRoute or LM Studio, or a hosted one such as Groq or DeepSeek).
2. Connect a mailbox: email address + app password. The app sends a test email to the user's own address to confirm it works. Mailbox connection can be skipped. Without it the app still researches and drafts, and says so when the user tries to send.
3. Drop a resume (PDF or DOCX). Optionally paste LinkedIn text and links (GitHub, portfolio). LinkedIn is not scraped.
4. The agent summarises the user back to them and asks, one question at a time: target roles, location / remote, stage range, visa status where relevant (e.g. US OPT / STEM OPT / H-1B), salary floor (optional), exclusions.
5. Corrections ("2 years, not 4") and rules ("never mention crypto", a fixed sign-off) are saved to the profile and applied to every later draft. A new rule on the same topic replaces the old one.

### 5.2 Daily picks
- Runs once a day at a user-set time (default 08:00 local), plus on demand ("find more").
- **Coverage is global (owner's decision): Indian startups and US/global startups, including ones hiring remotely.** The owner is based in India (Ahmedabad) and open to remote.
- **Source coverage should match Backdoor's list (owner's decision).** Backdoor's site says: "Every morning, Backdoor searches Y Combinator, Product Hunt, TechCrunch, Crunchbase, Wellfound, GitHub, funding news, careers pages and literally the rest of the internet for startups that just raised, launched or started hiring." The first version covers each of these, by the method below. Each is free and public, or uses the user's own free-tier key:

  | Source | Signal | How (my call) |
  |---|---|---|
  | Y Combinator | new / hiring YC companies | public YC company dataset; "Work at a Startup" listings where public |
  | Product Hunt | just launched | Product Hunt public API (user's free developer token), falling back to its public RSS feed |
  | TechCrunch + other funding news | just raised | RSS: TechCrunch venture; India: Inc42, Entrackr, YourStory funding |
  | Hacker News | started hiring | "Ask HN: Who is hiring?" threads via the HN Algolia API (many remote roles) |
  | GitHub | building in public, hiring | GitHub public API (optional user token): trending repos / orgs of startups, `hiring` mentions in org READMEs |
  | Careers pages | started hiring | public job-board endpoints of common hiring systems (Greenhouse, Lever, Ashby, Workable) for companies already found, plus the company's own `/careers` page |
  | Crunchbase, Wellfound | raised / hiring | **only through their public pages surfaced by web search** (no direct scraping, no login). Optional Crunchbase API if the user has a key. |
  | "The rest of the internet" | any of the above | web search through a user-supplied search API key with a free tier (e.g. Tavily, Brave Search, or Exa), with queries like "seed round" + role + region in the last 7 days |

  - Wellfound and Crunchbase actively block scraping and forbid it in their terms, so the app only reads what a normal web search returns about them.
  - **Without a search API key**, the app still works using the RSS, API and job-board sources. It says that coverage is smaller and suggests adding a free key.
  - Every pick records **which source(s) found it and when**. The "why picked" line can say e.g. "raised $2.1M seed on Oct 20 (TechCrunch)".
  - Sources sit behind one common "source" interface, so adding more is just adding a module.
- **Location screening:** a startup passes if it is in the user's country or city, or its posting or site says it hires remotely in the user's region.
- **Visa:** visa status only matters for users targeting another country. It is a profile field used in screening and drafting, e.g. "no sponsorship needed on OPT".
- **Send timing (my call):** first emails and follow-ups go out between 09:00 and 17:00 on weekdays in the startup's local time zone when its country is known, otherwise in the user's own time zone.
- Before drafting, each candidate is screened:
  - not on the user's exclusion list
  - not already contacted
  - can plausibly hire in the user's location or remotely
  - stage fits the user's range
  - the user could plausibly do the work
- A posted job opening is **not** required.
- Each surviving candidate is scored for fit. The top picks (default 3–5 a day, enough to stay under the send cap) are shown with a one-line "why you fit".

### 5.3 Finding the contact
- Order of preference: a founder's or hiring manager's personal address → a hiring/jobs/careers inbox.
- Exclude generic inboxes (`info@`, `support@`, `sales@`, `hello@`, `noreply@`, etc.).
- Where to look: the source itself (HN posts often include an email) and the company's own site (home, about, team, careers, contact pages).
- **Never guess** addresses from name patterns.
- Every address is shown with **where it was found** (the source URL).
- If none is found, the pick says so and the user can type an address in.

### 5.4 Draft and approve
- The draft is short (roughly 80–150 words), with a specific subject line. It names something concrete about the startup and 1–2 concrete things the user has done, in the user's voice, and applies the user's rules and sign-off.
- **Send:** queues it to go out (still within the daily cap).
- **Edit:** the user gives an instruction ("shorter", "mention X") or edits the text directly.
- **Skip:** removes the pick and remembers the startup so it isn't picked again.
- Optional setting: attach the resume PDF to first emails.
- Daily cap on **new** founders contacted: default 10, user-adjustable up to 20. Follow-ups don't count toward it.

### 5.5 Sending
- Sent through the user's own mailbox over SMTP, so the email sits in their Sent folder and replies land in their inbox.
- Headers must keep threading: store each message's `Message-ID`, and set `In-Reply-To` / `References` on follow-ups. Use clean, normal headers to avoid spam folders.

### 5.6 Follow-ups
- Up to **3** follow-ups in the **same thread**, sent **3, 4 and 5 days** after the previous message.
- Each follow-up is short and written when it is due, not pre-written.
- **Stop conditions:**
  - any reply from anyone in the thread, including a "no"
  - the user writes in the thread themselves
  - the address bounces
  - the user cancels
- Out-of-office auto-replies don't stop the sequence; they postpone the next follow-up.
- Follow-ups can be sent now, rescheduled, or cancelled from the chat or the Leads page.
- One global **Pause** stops all outreach. Resuming keeps the schedule.

### 5.7 Replies and bounces
- Poll the mailbox over IMAP on a schedule (my call: every 10 minutes while running). Match incoming mail to threads by `In-Reply-To` / `References`, falling back to sender address.
- A founder reply triggers a desktop notification and a message in the Home chat with a short summary. The lead moves to Replied. The user answers from their own mail client.
- A bounce closes that contact. The app looks for the next contact for that startup and asks before writing again.
- "How's my search going?" returns counts (sent, replies, interviews, upcoming follow-ups). Interviews are marked by the user on a lead.

### 5.8 Data and control
- Everything is stored locally: profile, leads, messages, settings.
- Secrets (AI key, app password) are kept with the OS's secure storage, not in plain text.
- **Delete everything**: one action, with a confirmation, wipes all local data and stored secrets.
- Missed schedules (laptop asleep) catch up on next wake: overdue follow-ups go out then, still respecting the stop conditions.

## 6. How it gets made (my calls; owner delegated the stack)

- **Electron + TypeScript + React**, packaged as one Windows installer first. Reason: one download, no terminal; the tray keeps the scheduler alive; the same web UI could later be served as a local web app.
- **SQLite** in the user's app-data folder for all records.
- **Provider-agnostic LLM layer** (e.g. Vercel AI SDK) supporting OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama, Hugging Face Inference Providers (`https://router.huggingface.co/v1` with an HF token), and any custom OpenAI-compatible endpoint (base URL + optional key, e.g. a localhost OmniRoute router), with tool-calling for the agent. Extraction steps (resume → profile, page → contacts, candidate → fit score) use structured JSON output.
- **SMTP / IMAP** client libraries for mail (e.g. nodemailer and an IMAP client).
- **Launch at login** is an opt-in setting.
- License: **MIT** (my call; matches REA and most similar tools).

### 6.1 Agent architecture: fixed pipeline, not a free-roaming agent (my call)
- **Pipeline:** discovery → screen → contact finding → draft → follow-up is a fixed pipeline. Code drives each step; the model only fills structured slots (JSON) and writes prose.
- **Home chat:** handles a known set of intents:
  - setup questions
  - corrections and rules
  - send / edit / skip
  - "find more"
  - status
  - pause / resume
  - follow-up controls
  - delete everything

  Anything else gets a plain conversational answer with no actions.
  Reason: this works on small local models, which are unreliable at open-ended tool-calling.
- **Hard checks before anything is sent,** first emails and follow-ups alike:
  - length limits
  - the email names something specific about the startup
  - it names something specific about the user
  - it applies the user's rules and sign-off
  - no placeholder text left in

  A follow-up that fails the checks is not sent automatically. It is shown to the user for approval instead.
- **Models:**
  - Local models are supported on a best-effort basis. The minimum to test against is a ~7–8B instruct model through Ollama (e.g. Qwen 2.5 7B or Llama 3.1 8B).
  - For free use without a GPU, setup points users to free-tier cloud options, such as Gemini's free API tier or OpenRouter's free models.

### 6.2 Mail providers (my call)
- **First version:** Gmail with an app password, plus any provider that still allows SMTP/IMAP password login. Setup gives one-click presets for Gmail and Zoho, and has an "other" option for manual server settings.
- **Outlook.com / Microsoft 365** need OAuth, so they are out of scope for the first version. Setup detects these addresses and says they aren't supported yet.
- **Google Workspace** accounts where the admin has turned off app passwords fail the connection test, and setup explains why.

### 6.3 Distribution (my call)
- Releases go on GitHub Releases as an **unsigned** Windows installer at first. The README and the download page explain the SmartScreen "More info → Run anyway" step.
- Code signing comes later if the project gets users.
- No auto-update in the first version. There's an optional "check for updates" button that only reads the public GitHub Releases page. That request sends no user data, so it is added to the allowed network calls in §2.

## 7. Build order (owner's decision: ship something for the owner's own job search first)

There's no fixed date, but the owner wants to start using it for their own job search as early as possible. So the work ships in two milestones.

**Milestone 1 — usable for the owner's own search (rough UI is fine)**
- Settings:
  - AI provider + key, or Ollama, or a Hugging Face token, or a custom OpenAI-compatible address (+ optional key)
  - mailbox + app password, with a test send
  - daily cap
- Profile: resume upload, plus pasted LinkedIn text and links. The agent summarises it back, and preferences and rules are editable as a form.
- Daily picks from all sources in §5.2, run on demand ("find picks" button) and once a day while the app is open.
- Contact finding (§5.3), drafting with Send / Edit / Skip (§5.4), sending (§5.5).
- Follow-ups (§5.6), and reply / bounce / out-of-office detection (§5.7), while the app is running.
- A basic Leads table with statuses and next steps.
- Local storage, secure secrets, and delete everything (§5.8).
- The quality checks before sending (§6.1).

**Milestone 2 — the full app described in §4**
- The chat-first Home screen with the side panel, the one-question-at-a-time setup conversation, and the agent personality (§4.3).
- Picks and Replies pages, badge counts, and the floating chat button.
- System tray + launch at login, so scheduling runs with the window closed, plus catch-up after sleep.
- Desktop notifications.
- A packaged installer on GitHub Releases (§6.3).

Milestone 1 should already use the same database, pipeline and mail code that Milestone 2 builds on. Only the UI is rough, so nothing gets rewritten.

## 8. Left to the builder

- Exact libraries, folder structure, and the database schema.
- Prompt wording, the fit-scoring method, and how many candidates to research per day.
- The data model for statuses, as long as it covers: picked, drafted, skipped, sent, follow-up 1–3, replied, bounced, closed, interview.
- Visual styling details beyond the layout in §4.2, within the rules of the `design-taste-frontend-v1` skill (§4.2.1).
- Test strategy. Email sending must be testable against a local fake SMTP/IMAP server, without real mail.

## 9. Calls I made that the owner should check

- Working name "Sidedoor" (placeholder). The app should not use the Backdoor name or branding.
- Gmail app password (SMTP/IMAP) instead of the Gmail API.
- MIT license.
- 3–5 picks a day by default; IMAP check every 10 minutes; default pick time 08:00.
- Follow-ups pre-approved by the first Send, matching Backdoor, except that a follow-up failing the quality checks needs approval (§6.1).
- Fixed pipeline + a known set of chat intents instead of an open-ended agent, so small local models work (§6.1).
- Outlook / Microsoft 365 not supported in the first version (§6.2).
- Unsigned Windows installer on GitHub Releases, no auto-update (§6.3).
- India sources: Inc42 / Entrackr / YourStory funding feeds (§5.2).
- How each Backdoor source is reached (§5.2 table), especially Crunchbase and Wellfound only through web search results, and an optional user-supplied search API key for "the rest of the internet".
- Sending window: 09:00–17:00 on weekdays, in the startup's local time zone (§5.2).
- What goes into Milestone 1 vs Milestone 2 (§7).
