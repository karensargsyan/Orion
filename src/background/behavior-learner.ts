/**
 * Behavior Learner — continuously observes user actions and distills them
 * into reusable behavioral knowledge. Model-agnostic: knowledge persists
 * in IndexedDB and is injected into whatever model is active.
 */

import { STORE } from '../shared/constants'
import { dbGetAllByIndex, dbPut, dbDelete } from '../shared/idb'
import type { UserActionEvent, UserBehavior, BehaviorCategory } from '../shared/types'

const MAX_BEHAVIORS_PER_DOMAIN = 30
const CONFIDENCE_DECAY_DAYS = 30
const MIN_OCCURRENCES_TO_KEEP = 2

// ─── Learn from a batch of user actions ────────────────────────────────────────

export async function learnFromActions(events: UserActionEvent[], domain: string): Promise<void> {
  if (events.length === 0) return

  const discoveries: Omit<UserBehavior, 'id'>[] = []

  discoveries.push(...detectClickPatterns(events, domain))
  discoveries.push(...detectNavigationPatterns(events, domain))
  discoveries.push(...detectFormHabits(events, domain))
  discoveries.push(...detectInteractionStyle(events, domain))
  discoveries.push(...detectPointerAndScrollPatterns(events, domain))

  for (const d of discoveries) {
    await mergeOrCreate(d)
  }

  await pruneStale(domain)
}

// ─── Pattern detectors ─────────────────────────────────────────────────────────

function detectClickPatterns(events: UserActionEvent[], domain: string): Omit<UserBehavior, 'id'>[] {
  const results: Omit<UserBehavior, 'id'>[] = []
  const clickTargets = events.filter(e => e.type === 'click' && e.text)

  const freq = new Map<string, number>()
  for (const e of clickTargets) {
    const key = e.text!.slice(0, 60)
    freq.set(key, (freq.get(key) ?? 0) + 1)
  }

  for (const [text, count] of freq) {
    if (count >= 2) {
      results.push(makeBehavior(domain, 'shortcut', `Frequently clicks "${text}"`, `Clicked ${count}x in this session`, count))
    }
  }

  return results
}

function detectNavigationPatterns(events: UserActionEvent[], domain: string): Omit<UserBehavior, 'id'>[] {
  const results: Omit<UserBehavior, 'id'>[] = []
  const navEvents = events.filter(e => e.type === 'navigate')

  if (navEvents.length >= 2) {
    const sequence = navEvents.map(e => extractPath(e.url)).filter(p => p.length > 1)
    if (sequence.length >= 2) {
      const desc = `Navigation pattern: ${sequence.slice(0, 4).join(' -> ')}`
      results.push(makeBehavior(domain, 'navigation', desc, `${sequence.length} page transitions`, sequence.length))
    }
  }

  const pageCounts = new Map<string, number>()
  for (const e of navEvents) {
    const path = extractPath(e.url)
    pageCounts.set(path, (pageCounts.get(path) ?? 0) + 1)
  }

  for (const [path, count] of pageCounts) {
    if (count >= 2) {
      results.push(makeBehavior(domain, 'navigation', `Frequently visits ${path}`, `Visited ${count}x`, count))
    }
  }

  return results
}

function detectFormHabits(events: UserActionEvent[], domain: string): Omit<UserBehavior, 'id'>[] {
  const results: Omit<UserBehavior, 'id'>[] = []
  const inputs = events.filter(e => e.type === 'input')
  const submits = events.filter(e => e.type === 'submit')

  if (inputs.length >= 2) {
    const fieldSequence = inputs.map(e => e.selector.split('>').pop()?.trim() ?? e.tagName).slice(0, 5)
    results.push(makeBehavior(domain, 'form_habit', `Form filling order: ${fieldSequence.join(', ')}`, `Filled ${inputs.length} fields`, inputs.length))
  }

  if (submits.length > 0) {
    results.push(makeBehavior(domain, 'form_habit', `Submits forms on this page`, `${submits.length} submission(s)`, submits.length))
  }

  return results
}

function detectInteractionStyle(events: UserActionEvent[], domain: string): Omit<UserBehavior, 'id'>[] {
  const results: Omit<UserBehavior, 'id'>[] = []

  if (events.length < 3) return results

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(sorted[i].timestamp - sorted[i - 1].timestamp)
  }

  if (intervals.length >= 2) {
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length
    if (avgMs < 1000) {
      results.push(makeBehavior(domain, 'interaction_style', 'Fast-paced interaction style on this site', `Avg ${Math.round(avgMs)}ms between actions`, events.length))
    } else if (avgMs > 10000) {
      results.push(makeBehavior(domain, 'interaction_style', 'Reads content carefully before acting on this site', `Avg ${Math.round(avgMs / 1000)}s between actions`, events.length))
    }
  }

  const actionTypes = new Set(events.map(e => e.type))
  if (actionTypes.size >= 3 && events.length >= 5) {
    const workflow = sorted.slice(0, 6).map(e => e.type).join(' -> ')
    results.push(makeBehavior(domain, 'workflow', `Typical workflow: ${workflow}`, `${events.length} actions in sequence`, events.length))
  }

  return results
}

function detectPointerAndScrollPatterns(
  events: UserActionEvent[],
  domain: string
): Omit<UserBehavior, 'id'>[] {
  const results: Omit<UserBehavior, 'id'>[] = []
  const moves = events.filter(e => e.type === 'move')
  const wheels = events.filter(e => e.type === 'wheel')
  const scrolls = events.filter(e => e.type === 'scroll')

  if (moves.length >= 12) {
    const regions = new Map<string, number>()
    for (const e of moves) {
      const key = e.selector.split('>').pop()?.trim().slice(0, 48) ?? e.tagName
      regions.set(key, (regions.get(key) ?? 0) + 1)
    }
    const top = [...regions.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top) {
      results.push(
        makeBehavior(
          domain,
          'interaction_style',
          `Explores UI with the pointer; often hovers near "${top[0]}"`,
          `${moves.length} move samples in batch`,
          Math.min(moves.length, 20)
        )
      )
    }
  }

  if (wheels.length + scrolls.length >= 8) {
    results.push(
      makeBehavior(
        domain,
        'interaction_style',
        'Heavy scrolling / wheel use on this page or site',
        `${wheels.length} wheel + ${scrolls.length} scroll events`,
        wheels.length + scrolls.length
      )
    )
  }

  return results
}

// ─── Cross-domain pattern detection ────────────────────────────────────────────

export async function detectCrossDomainPatterns(events: UserActionEvent[]): Promise<void> {
  const domains = new Set(events.map(e => extractDomain(e.url)).filter(Boolean))
  if (domains.size < 2) return

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
  const transitions: string[] = []

  for (let i = 1; i < sorted.length; i++) {
    const prev = extractDomain(sorted[i - 1].url)
    const curr = extractDomain(sorted[i].url)
    if (prev !== curr && prev && curr) {
      if (sorted[i].timestamp - sorted[i - 1].timestamp < 60_000) {
        transitions.push(`${prev} -> ${curr}`)
      }
    }
  }

  const freq = new Map<string, number>()
  for (const t of transitions) {
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }

  for (const [transition, count] of freq) {
    if (count >= 2) {
      const [from] = transition.split(' -> ')
      await mergeOrCreate(makeBehavior(
        from, 'workflow',
        `Cross-site pattern: ${transition}`,
        `${count}x in recent sessions`,
        count
      ))
    }
  }
}

// ─── Merge or create behavior ──────────────────────────────────────────────────

async function mergeOrCreate(behavior: Omit<UserBehavior, 'id'>): Promise<void> {
  const existing = await dbGetAllByIndex<UserBehavior>(STORE.USER_BEHAVIORS, 'by_domain', behavior.domain)
  const match = findSimilar(existing, behavior.description, behavior.category)

  if (match) {
    match.occurrences += behavior.occurrences
    match.confidence = Math.min(1, match.confidence + 0.1)
    match.lastSeen = Date.now()
    if (behavior.evidence.length > match.evidence.length) {
      match.evidence = behavior.evidence
    }
    await dbPut(STORE.USER_BEHAVIORS, match)
  } else {
    if (existing.length >= MAX_BEHAVIORS_PER_DOMAIN) {
      const weakest = existing.sort((a, b) => a.confidence - b.confidence)[0]
      if (weakest.id !== undefined && weakest.confidence < behavior.confidence) {
        await dbDelete(STORE.USER_BEHAVIORS, weakest.id)
      } else {
        return
      }
    }
    await dbPut(STORE.USER_BEHAVIORS, behavior)
  }
}

function findSimilar(behaviors: UserBehavior[], description: string, category: BehaviorCategory): UserBehavior | undefined {
  const exact = behaviors.find(b => b.description === description && b.category === category)
  if (exact) return exact

  const words = description.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  if (words.length < 2) return undefined

  return behaviors.find(b => {
    if (b.category !== category) return false
    const bWords = b.description.toLowerCase().split(/\s+/)
    const overlap = words.filter(w => bWords.includes(w)).length
    return overlap >= Math.ceil(words.length * 0.5)
  })
}

// ─── Prune stale behaviors ─────────────────────────────────────────────────────

async function pruneStale(domain: string): Promise<void> {
  const all = await dbGetAllByIndex<UserBehavior>(STORE.USER_BEHAVIORS, 'by_domain', domain)
  const now = Date.now()
  const cutoff = now - CONFIDENCE_DECAY_DAYS * 24 * 60 * 60 * 1000

  for (const b of all) {
    if (b.lastSeen < cutoff && b.occurrences < MIN_OCCURRENCES_TO_KEEP && b.id !== undefined) {
      await dbDelete(STORE.USER_BEHAVIORS, b.id)
      continue
    }

    if (b.lastSeen < cutoff) {
      b.confidence = Math.max(0.1, b.confidence - 0.2)
      await dbPut(STORE.USER_BEHAVIORS, b)
    }
  }
}

// ─── Retrieve knowledge for prompt injection ───────────────────────────────────

export async function getBehaviorsForDomain(domain: string, limit = 15): Promise<UserBehavior[]> {
  const domainBehaviors = await dbGetAllByIndex<UserBehavior>(STORE.USER_BEHAVIORS, 'by_domain', domain)
  const globalBehaviors = await dbGetAllByIndex<UserBehavior>(STORE.USER_BEHAVIORS, 'by_domain', '_global')

  const all = [...domainBehaviors, ...globalBehaviors]
  return all
    .filter(b => b.confidence >= 0.2)
    .sort((a, b) => b.confidence * b.occurrences - a.confidence * a.occurrences)
    .slice(0, limit)
}

export function formatBehaviorsForPrompt(behaviors: UserBehavior[]): string {
  if (behaviors.length === 0) return ''

  const grouped = new Map<BehaviorCategory, UserBehavior[]>()
  for (const b of behaviors) {
    const list = grouped.get(b.category) ?? []
    list.push(b)
    grouped.set(b.category, list)
  }

  const sections: string[] = []

  const categoryLabels: Record<BehaviorCategory, string> = {
    workflow: 'Workflows',
    preference: 'Preferences',
    shortcut: 'Frequently Used Actions',
    site_pattern: 'Site Patterns',
    form_habit: 'Form Habits',
    navigation: 'Navigation Habits',
    interaction_style: 'Interaction Style',
  }

  for (const [category, items] of grouped) {
    const label = categoryLabels[category]
    const lines = items.map(b => `- ${b.description} (confidence: ${Math.round(b.confidence * 100)}%, seen ${b.occurrences}x)`)
    sections.push(`### ${label}\n${lines.join('\n')}`)
  }

  return `## USER BEHAVIOR KNOWLEDGE
The following patterns were learned from observing this user's real actions. Use this knowledge to anticipate their intent, suggest faster paths, and match their style. This knowledge persists across model changes.

${sections.join('\n\n')}

Apply these patterns: if the user's request aligns with a known workflow, follow the learned pattern. If they frequently click certain items, prioritize those in your actions.`
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeBehavior(
  domain: string, category: BehaviorCategory,
  description: string, evidence: string, occurrences: number
): Omit<UserBehavior, 'id'> {
  return {
    domain,
    category,
    description,
    evidence,
    confidence: Math.min(1, 0.3 + occurrences * 0.1),
    occurrences,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

function extractPath(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}
