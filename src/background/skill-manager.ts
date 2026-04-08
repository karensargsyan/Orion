import { STORE } from '../shared/constants'
import { dbGetAllByIndex, dbPut, dbDelete } from '../shared/idb'
import type { DomainSkill } from '../shared/types'
import type { AIActionResult } from '../shared/types'

interface ParsedAction {
  action: string
  params: Record<string, string>
}

const MAX_SEQUENCE_LENGTH = 500
const MAX_SKILLS_PER_DOMAIN = 15

export function extractTaskPattern(userMessage: string): string {
  return userMessage
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim()
    .slice(0, 100)
}

export function buildCompactSequence(actions: ParsedAction[], results: AIActionResult[]): string {
  const parts: string[] = []
  for (let i = 0; i < actions.length && i < results.length; i++) {
    if (!results[i].success) continue
    const a = actions[i]
    const target = a.params.selector ?? a.params.value ?? a.params.url ?? a.params.key ?? ''
    const shortTarget = target.slice(0, 60)
    parts.push(`${a.action.toUpperCase()}${shortTarget ? ` "${shortTarget}"` : ''}`)
  }
  return parts.join(' -> ').slice(0, MAX_SEQUENCE_LENGTH)
}

export async function saveOrReinforceSkill(skill: Omit<DomainSkill, 'id'>): Promise<void> {
  const existing = await dbGetAllByIndex<DomainSkill>(STORE.DOMAIN_SKILLS, 'by_domain', skill.domain)
  const match = findMatchingSkill(existing, skill.taskPattern)

  if (match) {
    match.successCount += 1
    match.lastUsed = Date.now()
    if (skill.actionSequence.length < match.actionSequence.length) {
      match.actionSequence = skill.actionSequence
    }
    await dbPut(STORE.DOMAIN_SKILLS, match)
  } else {
    if (existing.length >= MAX_SKILLS_PER_DOMAIN) {
      const oldest = existing.sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (oldest.id !== undefined) await dbDelete(STORE.DOMAIN_SKILLS, oldest.id)
    }
    await dbPut(STORE.DOMAIN_SKILLS, skill)
  }
}

export async function recordSkillFailure(domain: string, taskPattern: string): Promise<void> {
  const existing = await dbGetAllByIndex<DomainSkill>(STORE.DOMAIN_SKILLS, 'by_domain', domain)
  const match = findMatchingSkill(existing, taskPattern)
  if (!match) return

  match.failureCount += 1
  if (match.failureCount > match.successCount * 2 && match.id !== undefined) {
    await dbDelete(STORE.DOMAIN_SKILLS, match.id)
  } else {
    await dbPut(STORE.DOMAIN_SKILLS, match)
  }
}

export async function getSkillsForDomain(domain: string, limit = 10): Promise<DomainSkill[]> {
  const all = await dbGetAllByIndex<DomainSkill>(STORE.DOMAIN_SKILLS, 'by_domain', domain)
  return all
    .filter(s => s.successCount > s.failureCount)
    .sort((a, b) => b.successCount - a.successCount)
    .slice(0, limit)
}

export function formatSkillsForPrompt(skills: DomainSkill[]): string {
  if (skills.length === 0) return ''

  const lines = skills.map(s =>
    `- **${s.taskPattern}** (used ${s.successCount}x): ${s.actionSequence}`
  )

  return `## LEARNED SKILLS FOR THIS DOMAIN
You have successfully performed these actions on this site before. Use these proven patterns instead of guessing:
${lines.join('\n')}
Prefer these proven approaches. Adapt them if the page structure has changed.`
}

function findMatchingSkill(skills: DomainSkill[], taskPattern: string): DomainSkill | undefined {
  const exact = skills.find(s => s.taskPattern === taskPattern)
  if (exact) return exact

  const words = taskPattern.split(/\s+/).filter(w => w.length > 3)
  if (words.length === 0) return undefined

  return skills.find(s => {
    const matchCount = words.filter(w => s.taskPattern.includes(w)).length
    return matchCount >= Math.ceil(words.length * 0.6)
  })
}
