/**
 * MemPalace Learner — the extension's permanent learning system.
 *
 * Every action result (success or failure), every AI insight, every corrected
 * mistake is written to the MemPalace palace via the local HTTP bridge.
 * On next retrieval the AI sees its own past mistakes and the correct approach.
 *
 * Palace layout used:
 *   wing_action_learning / hall_errors    — failures with context
 *   wing_action_learning / hall_successes — verified successes with approach
 *   wing_action_learning / hall_lessons   — distilled lessons (AI-generated)
 *   wing_browser_assistant / <domain>     — domain-specific patterns
 */

import type { Settings, AIActionResult } from '../shared/types'
import {
  mempalaceEnabled,
  storeMempalace,
  storeMempalaceBatch,
  searchMempalace,
  type PalaceMemory,
} from './mempalace-client'

const WING_LEARN = 'wing_action_learning'
const WING_BROWSER = 'wing_browser_assistant'

// ── Store an action failure ─────────────────────────────────────────────────────

export async function recordActionFailure(
  settings: Settings,
  result: AIActionResult,
  context: { url: string; domain: string; userGoal?: string; attempt?: string }
): Promise<void> {
  if (!mempalaceEnabled(settings)) return

  const ts = new Date().toISOString()
  const lines = [
    `[ERROR] ${ts}`,
    `Action: ${result.action}`,
    `Selector: ${result.result ?? 'n/a'}`,
    `Error: ${result.error ?? 'unknown failure'}`,
    `URL: ${context.url}`,
    `Domain: ${context.domain}`,
  ]
  if (context.userGoal) lines.push(`User goal: ${context.userGoal}`)
  if (context.attempt) lines.push(`Attempt detail: ${context.attempt}`)

  await storeMempalace(settings, {
    wing: WING_LEARN,
    room: 'hall_errors',
    content: lines.join('\n'),
    source: `error:${context.domain}`,
  }).catch(() => {})
}

// ── Store a verified success ────────────────────────────────────────────────────

export async function recordActionSuccess(
  settings: Settings,
  result: AIActionResult,
  context: { url: string; domain: string; userGoal?: string; approach?: string }
): Promise<void> {
  if (!mempalaceEnabled(settings)) return

  const ts = new Date().toISOString()
  const lines = [
    `[SUCCESS] ${ts}`,
    `Action: ${result.action}`,
    `Result: ${(result.result ?? 'completed').slice(0, 400)}`,
    `URL: ${context.url}`,
    `Domain: ${context.domain}`,
  ]
  if (context.userGoal) lines.push(`User goal: ${context.userGoal}`)
  if (context.approach) lines.push(`Approach: ${context.approach}`)

  await storeMempalace(settings, {
    wing: WING_LEARN,
    room: 'hall_successes',
    content: lines.join('\n'),
    source: `success:${context.domain}`,
  }).catch(() => {})
}

// ── Store a distilled lesson ────────────────────────────────────────────────────

export async function recordLesson(
  settings: Settings,
  lesson: string,
  meta: { domain?: string; source?: string }
): Promise<void> {
  if (!mempalaceEnabled(settings)) return

  const ts = new Date().toISOString()
  const content = `[LESSON] ${ts}\n${lesson.slice(0, 2000)}`

  await storeMempalace(settings, {
    wing: WING_LEARN,
    room: 'hall_lessons',
    content,
    source: meta.source ?? `lesson:${meta.domain ?? 'general'}`,
  }).catch(() => {})
}

// ── Store domain-specific knowledge ─────────────────────────────────────────────

export async function recordDomainKnowledge(
  settings: Settings,
  domain: string,
  knowledge: string
): Promise<void> {
  if (!mempalaceEnabled(settings)) return

  const room = domain.replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'general'
  await storeMempalace(settings, {
    wing: WING_BROWSER,
    room,
    content: knowledge.slice(0, 3000),
    source: `domain:${domain}`,
  }).catch(() => {})
}

// ── Batch push session memory entries to palace ─────────────────────────────────

export async function pushSessionMemoryToPalace(
  settings: Settings,
  memories: Array<{ type: string; domain: string; content: string; url: string }>
): Promise<number> {
  if (!mempalaceEnabled(settings) || memories.length === 0) return 0

  const entries: PalaceMemory[] = memories.map(m => ({
    wing: WING_BROWSER,
    room: m.domain.replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'general',
    content: `[${m.type}] ${m.content}`.slice(0, 3000),
    source: `session:${m.domain}`,
  }))

  return storeMempalaceBatch(settings, entries)
}

// ── Recall past mistakes and lessons for a given context ────────────────────────

export async function recallRelevantMemories(
  settings: Settings,
  query: string,
  domain: string
): Promise<string> {
  if (!mempalaceEnabled(settings) || !query.trim()) return ''

  const [errors, lessons, domainMem] = await Promise.all([
    searchMempalace(settings, `error failure: ${query}`, {
      wing: WING_LEARN,
      room: 'hall_errors',
      limit: 3,
    }),
    searchMempalace(settings, `lesson correct approach: ${query}`, {
      wing: WING_LEARN,
      room: 'hall_lessons',
      limit: 3,
    }),
    domain
      ? searchMempalace(settings, query, {
          wing: WING_BROWSER,
          room: domain.replace(/[^a-z0-9-]/gi, '-').slice(0, 40),
          limit: 3,
        })
      : Promise.resolve(''),
  ])

  const parts: string[] = []
  if (errors) parts.push(`### Past mistakes (avoid repeating)\n${errors}`)
  if (lessons) parts.push(`### Learned lessons\n${lessons}`)
  if (domainMem) parts.push(`### Domain knowledge (${domain})\n${domainMem}`)

  return parts.join('\n\n').slice(0, 4500)
}

// ── AI-powered lesson distillation ──────────────────────────────────────────────

export function buildLessonDistillationPrompt(
  recentErrors: string,
  recentSuccesses: string
): Array<{ role: string; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You are a learning analyst for a browser automation AI agent. ' +
        'Given recent errors and successes, distill 2-5 concrete LESSONS the agent should remember permanently. ' +
        'Each lesson must be actionable: "When X, do Y instead of Z" or "On site X, element Y is found by Z". ' +
        'Plain text bullet list only. No JSON, no preamble.',
    },
    {
      role: 'user',
      content:
        `Recent ERRORS:\n${recentErrors || '(none)'}\n\n` +
        `Recent SUCCESSES:\n${recentSuccesses || '(none)'}\n\n` +
        'Distill the key lessons:',
    },
  ]
}
