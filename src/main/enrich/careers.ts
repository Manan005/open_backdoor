import type { Fetcher } from '../net/http'

export interface OpenRole { title: string; location: string | null; remote: boolean | null; url: string }

type Ats = 'greenhouse' | 'lever' | 'ashby' | 'workable'
interface BoardRef { ats: Ats; slug: string }

const ALL_ATS: Ats[] = ['greenhouse', 'lever', 'ashby', 'workable']

const BOARD_LINKS: { ats: Ats; re: RegExp }[] = [
  { ats: 'greenhouse', re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?!embed\b)([a-z0-9][\w-]*)/gi },
  // embed widgets name the board in a query parameter: boards.greenhouse.io/embed/job_board?for=acme
  { ats: 'greenhouse', re: /greenhouse\.io\/embed\/job_board[^"'\s>]*?[?&;]for=([a-z0-9][\w-]*)/gi },
  { ats: 'lever', re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9][\w-]*)/gi },
  { ats: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9][\w%-]*)/gi },
  { ats: 'workable', re: /apply\.workable\.com\/(?!api\b|j\b)([a-z0-9][\w-]*)/gi }
]

export function detectBoards(html: string): BoardRef[] {
  const out: BoardRef[] = []
  for (const { ats, re } of BOARD_LINKS) {
    for (const m of html.matchAll(re)) {
      const slug = m[1].toLowerCase()
      if (!out.some((b) => b.ats === ats && b.slug === slug)) out.push({ ats, slug })
    }
  }
  return out
}

// "acme" from https://www.acme.ai/about; handles simple second-level suffixes like co.uk.
export function domainLabel(website: string | null): string | null {
  if (!website) return null
  let host: string
  try {
    host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase()
  } catch {
    return null
  }
  const parts = host.replace(/^www\./, '').split('.')
  if (parts.length < 2) return null
  const label = parts.length >= 3 && ['co', 'com', 'org', 'net', 'ac'].includes(parts[parts.length - 2])
    ? parts[parts.length - 3]
    : parts[parts.length - 2]
  return /^[a-z0-9][a-z0-9-]*$/.test(label) ? label : null
}

function boardUrl({ ats, slug }: BoardRef): string {
  const s = encodeURIComponent(slug)
  switch (ats) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`
    case 'lever': return `https://api.lever.co/v0/postings/${s}?mode=json`
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${s}`
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${s}`
  }
}

type Json = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const remoteFromText = (loc: string | null): boolean | null => (loc && /remote/i.test(loc) ? true : null)

function mapRoles(ats: Ats, data: unknown): OpenRole[] {
  const roles: OpenRole[] = []
  const push = (title: unknown, location: string | null, remote: boolean | null, url: unknown): void => {
    const t = str(title)
    const u = str(url)
    if (t && u) roles.push({ title: t, location, remote, url: u })
  }
  if (ats === 'greenhouse') {
    for (const j of ((data as Json)?.jobs as Json[] | undefined) ?? []) {
      const loc = str((j.location as Json | undefined)?.name)
      push(j.title, loc, remoteFromText(loc), j.absolute_url)
    }
  } else if (ats === 'lever') {
    for (const j of Array.isArray(data) ? (data as Json[]) : []) {
      const loc = str((j.categories as Json | undefined)?.location)
      const wt = str(j.workplaceType)?.toLowerCase()
      const remote = wt === 'remote' ? true : wt === 'onsite' || wt === 'hybrid' ? false : remoteFromText(loc)
      push(j.text, loc, remote, j.hostedUrl)
    }
  } else if (ats === 'ashby') {
    for (const j of ((data as Json)?.jobs as Json[] | undefined) ?? []) {
      if (j.isListed === false) continue
      const loc = str(j.location)
      push(j.title, loc, typeof j.isRemote === 'boolean' ? j.isRemote : remoteFromText(loc), j.jobUrl)
    }
  } else {
    for (const j of ((data as Json)?.jobs as Json[] | undefined) ?? []) {
      const loc = [str(j.city), str(j.country)].filter(Boolean).join(', ') || null
      push(j.title, loc, typeof j.telecommuting === 'boolean' ? j.telecommuting : null, j.url)
    }
  }
  return roles
}

async function queryBoard(fetch: Fetcher, board: BoardRef): Promise<OpenRole[] | null> {
  let res
  try {
    res = await fetch(boardUrl(board))
  } catch {
    return null // network failure counts as no board
  }
  if (res.status < 200 || res.status >= 300) return null // 404 and other errors: try the next board
  try {
    return mapRoles(board.ats, JSON.parse(res.text))
  } catch {
    return null
  }
}

// Looks up open roles through the public job-board APIs. The first board that answers wins.
export async function findOpenRoles(
  fetch: Fetcher,
  company: { name: string; website: string | null; careersHtml: string | null }
): Promise<OpenRole[]> {
  let boards = company.careersHtml ? detectBoards(company.careersHtml) : []
  if (boards.length === 0) {
    const label = domainLabel(company.website)
    boards = label ? ALL_ATS.map((ats) => ({ ats, slug: label })) : []
  }
  for (const board of boards) {
    const roles = await queryBoard(fetch, board)
    if (roles) return roles
  }
  return []
}
