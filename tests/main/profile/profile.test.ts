import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { extractResumeText, ResumeUnreadableError } from '../../../src/main/profile/resumeText'
import { buildProfile, summarizeBack } from '../../../src/main/profile/profileBuilder'
import { addRule, applyCorrection } from '../../../src/main/profile/rules'
import { createFakeLlm } from '../llm/fakeLlm'
import type { Profile, Rule } from '../../../src/shared/types'

const fx = (f: string): string => join(__dirname, '../../fixtures', f)

const extracted = {
  name: 'Priya Raman',
  email: 'priya.raman@example.com',
  summary: 'Full-stack engineer.',
  yearsExperience: 4,
  skills: ['TypeScript', 'React'],
  projects: [
    { name: 'TrailNotes', detail: 'Offline hiking journal', metrics: '1,200 MAU' },
    { name: 'QuickInvoice', detail: 'Open source invoicing', metrics: '340 stars' },
    { name: 'Scratch', detail: 'No metrics here', metrics: null }
  ],
  experience: [
    { company: 'Lumen Analytics', title: 'Software Engineer', start: '2023-01', end: null }
  ],
  homeCountry: 'IN',
  homeCity: 'Pune'
}

function profile(over: Partial<Profile> = {}): Profile {
  return {
    ...extracted,
    links: [],
    preferences: {
      roles: ['Full-stack'],
      locations: [],
      remoteOk: true,
      stages: ['seed'],
      visa: null,
      salaryFloor: null,
      exclusions: []
    },
    rules: [],
    signOff: 'Best, Priya',
    timezone: 'Asia/Kolkata',
    resumePath: 'C:/r.pdf',
    rawText: 'raw',
    ...over
  }
}

describe('extractResumeText', () => {
  it('extracts text from pdf and docx fixtures', async () => {
    const pdf = await extractResumeText(fx('resume.pdf'))
    const docx = await extractResumeText(fx('resume.docx'))
    expect(pdf).toContain('Priya Raman')
    expect(pdf).toContain('TrailNotes')
    expect(docx).toContain('Priya Raman')
    expect(docx).toContain('QuickInvoice')
  })

  it('scanned pdf throws ResumeUnreadableError', async () => {
    const p = extractResumeText(fx('scanned.pdf'))
    await expect(p).rejects.toBeInstanceOf(ResumeUnreadableError)
    await expect(p).rejects.toThrow(
      'This resume looks like a scanned image. Export it as a text PDF or paste your experience instead.'
    )
  })

  it('rejects unsupported extensions', async () => {
    await expect(extractResumeText(fx('resume.txt'))).rejects.toThrow(/PDF or DOCX/)
  })
})

describe('buildProfile', () => {
  it('keeps previous rules and preferences', async () => {
    const previous = profile({
      rules: [{ topic: 'crypto', text: 'never mention crypto', forbiddenTerms: ['crypto'] }]
    })
    const llm = createFakeLlm([JSON.stringify({ ...extracted, yearsExperience: 5 })])
    const p = await buildProfile(llm, {
      resumeText: 'resume body',
      pastedText: 'linkedin body',
      links: ['https://github.com/x'],
      previous,
      timezone: 'Europe/Berlin'
    })
    expect(p.yearsExperience).toBe(5)
    expect(p.rules).toEqual(previous.rules)
    expect(p.preferences).toEqual(previous.preferences)
    expect(p.signOff).toBe('Best, Priya')
    expect(p.resumePath).toBe('C:/r.pdf')
    expect(p.timezone).toBe('Europe/Berlin')
    expect(p.links).toEqual(['https://github.com/x'])
    expect(p.rawText).toContain('resume body')
    expect(p.rawText).toContain('linkedin body')
    expect(llm.calls[0].prompt).toContain('linkedin body')
  })

  it('uses empty defaults for a first-time profile', async () => {
    const llm = createFakeLlm([JSON.stringify(extracted)])
    const p = await buildProfile(llm, {
      resumeText: 'r',
      pastedText: '',
      links: [],
      previous: null,
      timezone: 'UTC'
    })
    expect(p.rules).toEqual([])
    expect(p.signOff).toBeNull()
    expect(p.resumePath).toBeNull()
    expect(p.preferences).toEqual({
      roles: [],
      locations: [],
      remoteOk: false,
      stages: [],
      visa: null,
      salaryFloor: null,
      exclusions: []
    })
  })
})

describe('summarizeBack', () => {
  it('names latest title, company, years and two metric projects', () => {
    const s = summarizeBack(profile())
    expect(s).toContain('Software Engineer')
    expect(s).toContain('Lumen Analytics')
    expect(s).toContain('4 years')
    expect(s).toContain('TrailNotes (1,200 MAU)')
    expect(s).toContain('QuickInvoice (340 stars)')
    expect(s).not.toContain('Scratch')
  })

  it('handles a profile with no projects or experience', () => {
    const s = summarizeBack(profile({ projects: [], experience: [], yearsExperience: null }))
    expect(s).toContain('Priya Raman')
    expect(s).not.toMatch(/undefined|null/)
  })
})

describe('addRule', () => {
  it('replaces same topic', async () => {
    const llm = createFakeLlm([
      JSON.stringify({ topic: 'Crypto', forbiddenTerms: ['crypto'] }),
      JSON.stringify({ topic: 'crypto', forbiddenTerms: ['crypto', 'web3'] })
    ])
    let rules: Rule[] = []
    rules = await addRule(llm, rules, 'never mention crypto')
    rules = await addRule(llm, rules, "don't mention crypto or web3")
    expect(rules).toHaveLength(1)
    expect(rules[0].forbiddenTerms).toEqual(['crypto', 'web3'])
    expect(rules[0].text).toBe("don't mention crypto or web3")
  })
})

describe('applyCorrection', () => {
  it('updates yearsExperience', async () => {
    const llm = createFakeLlm([JSON.stringify({ ...extracted, yearsExperience: 2 })])
    const before = profile()
    const after = await applyCorrection(llm, before, '2 years, not 4')
    expect(after.yearsExperience).toBe(2)
    expect(after.rules).toEqual(before.rules)
    expect(after.signOff).toBe(before.signOff)
    expect(after.rawText).toBe(before.rawText)
    expect(after.timezone).toBe(before.timezone)
  })
})
