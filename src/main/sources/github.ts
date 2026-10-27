import type { Candidate, Signal } from '../../shared/types'
import { isCompanyHost } from './hnHiring'
import { domainKey } from './normalize'
import type { Source } from './types'

const API = 'https://api.github.com'
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_PUBLIC_REPOS = 200

interface Repo {
  name: string
  html_url: string
  description?: string | null
  stargazers_count: number
  created_at?: string
  owner: { login: string; type: string }
}
interface Org { login: string; name?: string | null; description?: string | null; blog?: string | null; public_repos?: number }

// `blog` is free text: normalize to an absolute URL on a company host, else null.
function websiteOf(blog: string | null | undefined): string | null {
  const b = blog?.trim()
  if (!b) return null
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(b) ? b : `https://${b}`
  try {
    return isCompanyHost(new URL(url).hostname.toLowerCase()) ? url : null
  } catch {
    return null
  }
}

export const githubSource: Source = {
  id: 'github',
  label: 'GitHub: trending open source',
  async fetchCandidates(ctx) {
    const since = new Date(ctx.now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10)
    const token = ctx.secrets.get('github.token')
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (token) headers.Authorization = `Bearer ${token}`

    const searchUrl = `${API}/search/repositories?q=created:>${since}+stars:>200&sort=stars&per_page=30`
    const res = await ctx.fetch(searchUrl, { headers })
    if (res.status < 200 || res.status >= 300) throw new Error(`${searchUrl} answered ${res.status}`)
    const repos = (JSON.parse(res.text) as { items?: Repo[] }).items ?? []

    // Group repos by organization owner; user-owned repos are not startups.
    const byOrg = new Map<string, Repo[]>()
    for (const r of repos) {
      if (r.owner.type !== 'Organization') continue
      byOrg.set(r.owner.login, [...(byOrg.get(r.owner.login) ?? []), r])
    }

    const out: Candidate[] = []
    const seen = new Set<string>()
    for (const [login, orgRepos] of byOrg) {
      let org: Org
      try {
        const r = await ctx.fetch(`${API}/orgs/${login}`, { headers })
        if (r.status < 200 || r.status >= 300) continue
        org = JSON.parse(r.text) as Org
      } catch {
        continue // rate limit or network failure for one org is not fatal
      }
      const website = websiteOf(org.blog)
      if (!website || (org.public_repos ?? 0) > MAX_PUBLIC_REPOS) continue
      const name = org.name?.trim() || login
      const key = domainKey(website, name)
      if (seen.has(key)) continue
      seen.add(key)
      const signals: Signal[] = orgRepos.map((r) => ({
        kind: 'launched',
        detail: `open-source ${r.name} gained ${r.stargazers_count}★`,
        date: r.created_at ?? null,
        sourceId: 'github',
        url: r.html_url
      }))
      out.push({
        name,
        website,
        description: (org.description || orgRepos[0].description || '').slice(0, 500),
        signals,
        country: null,
        city: null,
        remote: null,
        stage: null,
        emails: []
      })
    }
    return out
  }
}
