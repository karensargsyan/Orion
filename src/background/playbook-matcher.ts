import type { LearnedPlaybook, Settings } from '../shared/types'
import { getAllPlaybooks, getPlaybooksByDomain, savePlaybook } from './memory-manager'
import { mempalaceEnabled, searchMempalace } from './mempalace-client'

export interface PlaybookMatch {
  playbook: LearnedPlaybook
  score: number
}

const MIN_MATCH_SCORE = 0.35

export async function findMatchingPlaybook(
  userInput: string,
  domain: string,
  settings: Settings
): Promise<PlaybookMatch | null> {
  const candidates = await gatherCandidates(domain)
  if (candidates.length === 0) return null

  const inputLower = userInput.toLowerCase().trim()
  const inputWords = toWords(inputLower)

  let bestMatch: PlaybookMatch | null = null

  for (const playbook of candidates) {
    const score = scoreTriggerMatch(inputWords, inputLower, playbook)
    if (score > MIN_MATCH_SCORE && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { playbook, score }
    }
  }

  if (!bestMatch && mempalaceEnabled(settings)) {
    bestMatch = await semanticFallback(userInput, candidates, settings)
  }

  return bestMatch
}

export async function recordPlaybookOutcome(
  playbookId: string,
  success: boolean,
  allPlaybooks?: LearnedPlaybook[]
): Promise<void> {
  const playbooks = allPlaybooks ?? await getAllPlaybooks()
  const pb = playbooks.find(p => p.id === playbookId)
  if (!pb) return

  if (success) {
    pb.successCount++
    pb.confidence = Math.min(1, pb.confidence + 0.05)
  } else {
    pb.failureCount++
    pb.confidence = Math.max(0, pb.confidence - 0.1)
  }
  pb.updatedAt = Date.now()

  await savePlaybook(pb)
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreTriggerMatch(
  inputWords: string[],
  inputLower: string,
  playbook: LearnedPlaybook
): number {
  let bestScore = 0

  for (const trigger of playbook.triggers) {
    const triggerLower = trigger.toLowerCase().trim()
    const triggerWords = toWords(triggerLower)

    if (inputLower === triggerLower) return 1.0

    if (inputLower.includes(triggerLower) || triggerLower.includes(inputLower)) {
      const overlapRatio = Math.min(inputLower.length, triggerLower.length) /
        Math.max(inputLower.length, triggerLower.length)
      bestScore = Math.max(bestScore, 0.7 + overlapRatio * 0.3)
      continue
    }

    const overlap = wordOverlap(inputWords, triggerWords)
    bestScore = Math.max(bestScore, overlap)
  }

  return bestScore * playbook.confidence
}

function wordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let common = 0
  for (const w of setA) {
    if (setB.has(w)) common++
  }
  return (2 * common) / (setA.size + setB.size)
}

function toWords(text: string): string[] {
  return text.split(/\s+/).filter(w => w.length > 1)
}

// ─── Candidate Gathering ─────────────────────────────────────────────────────

async function gatherCandidates(domain: string): Promise<LearnedPlaybook[]> {
  const [domainSpecific, all] = await Promise.all([
    getPlaybooksByDomain(domain),
    getAllPlaybooks(50),
  ])

  const seen = new Set<string>()
  const combined: LearnedPlaybook[] = []

  for (const pb of domainSpecific) {
    seen.add(pb.id)
    combined.push(pb)
  }
  for (const pb of all) {
    if (!seen.has(pb.id)) combined.push(pb)
  }

  return combined
}

// ─── Semantic Fallback ───────────────────────────────────────────────────────

async function semanticFallback(
  userInput: string,
  candidates: LearnedPlaybook[],
  settings: Settings
): Promise<PlaybookMatch | null> {
  try {
    const resultText = await searchMempalace(settings, userInput, { limit: 3 })
    if (!resultText || resultText.length === 0) return null

    const lower = resultText.toLowerCase()

    for (const pb of candidates) {
      for (const trigger of pb.triggers) {
        if (lower.includes(trigger.toLowerCase())) {
          return { playbook: pb, score: 0.4 * pb.confidence }
        }
      }
    }
  } catch { /* mempalace not available */ }

  return null
}
