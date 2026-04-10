/**
 * Local Memory System — replaces MemPalace with a self-contained IDB-based
 * memory store. No external server required.
 *
 * Uses TF-IDF keyword matching for retrieval instead of semantic search.
 * Always available, enabled by default.
 */

import { STORE } from '../shared/constants'
import type { LocalMemoryEntry, LocalMemoryCategory, AIActionResult, Settings } from '../shared/types'
import { dbGetAll, dbPut, dbDelete, dbCount } from '../shared/idb'
import { getAllSettings } from './memory-manager'

// ─── Settings check ─────────────────────────────────────────────────────────

export function localMemoryEnabled(settings: Settings): boolean {
  return settings.localMemoryEnabled !== false
}

// ─── Stop words (excluded from keyword extraction) ──────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into', 'over',
  'after', 'and', 'but', 'or', 'not', 'no', 'so', 'if', 'then', 'than',
  'too', 'very', 'just', 'that', 'this', 'it', 'its', 'i', 'my', 'me',
  'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'also', 'as',
])

// ─── Keyword extraction ─────────────────────────────────────────────────────

function extractKeywords(text: string): string[] {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  return [...new Set(words)]
}

// ─── TF-IDF scoring ─────────────────────────────────────────────────────────

function scoreTfIdf(queryKeywords: string[], entries: LocalMemoryEntry[]): Array<{ entry: LocalMemoryEntry; score: number }> {
  if (entries.length === 0) return []

  // Build document frequency: how many entries contain each keyword
  const df = new Map<string, number>()
  for (const entry of entries) {
    const keySet = new Set(entry.keywords)
    for (const kw of keySet) {
      df.set(kw, (df.get(kw) ?? 0) + 1)
    }
  }

  const N = entries.length
  const scored = entries.map(entry => {
    const entryKeySet = new Set(entry.keywords)
    let score = 0
    for (const qkw of queryKeywords) {
      if (entryKeySet.has(qkw)) {
        const idf = Math.log(1 + N / (1 + (df.get(qkw) ?? 0)))
        // TF = 1 (boolean presence)
        score += idf
      }
    }
    // Boost recent entries slightly
    const ageHours = (Date.now() - entry.timestamp) / 3_600_000
    const recencyBoost = 1 / (1 + Math.log1p(ageHours / 24))
    score *= (1 + recencyBoost * 0.2)
    return { entry, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
}

// ─── Core CRUD ──────────────────────────────────────────────────────────────

export async function storeLocalMemory(
  category: LocalMemoryCategory,
  domain: string,
  content: string,
  source: string,
): Promise<void> {
  const entry: LocalMemoryEntry = {
    category,
    domain,
    content: content.slice(0, 3000),
    source,
    keywords: extractKeywords(content),
    timestamp: Date.now(),
    accessCount: 0,
    lastAccessed: Date.now(),
  }
  await dbPut(STORE.LOCAL_MEMORY, entry)

  // Auto-prune if over limit
  const settings = await getAllSettings().catch(() => null)
  const maxEntries = settings?.localMemoryMaxEntries ?? 500
  const count = await dbCount(STORE.LOCAL_MEMORY)
  if (count > maxEntries) {
    await pruneLocalMemory(maxEntries)
  }
}

export async function searchLocalMemory(
  query: string,
  options?: { category?: LocalMemoryCategory; domain?: string; limit?: number },
): Promise<string> {
  const allEntries = await dbGetAll<LocalMemoryEntry>(STORE.LOCAL_MEMORY)

  // Filter by category and domain if specified
  let candidates = allEntries
  if (options?.category) candidates = candidates.filter(e => e.category === options.category)
  if (options?.domain) candidates = candidates.filter(e => e.domain === options.domain || e.domain === '*')

  // Score and rank
  const queryKeywords = extractKeywords(query)
  if (queryKeywords.length === 0) return ''

  const scored = scoreTfIdf(queryKeywords, candidates)
  const limit = options?.limit ?? 5
  const topResults = scored.slice(0, limit)

  if (topResults.length === 0) return ''

  // Update access counts
  for (const { entry } of topResults) {
    entry.accessCount++
    entry.lastAccessed = Date.now()
    await dbPut(STORE.LOCAL_MEMORY, entry).catch(() => {})
  }

  return topResults
    .map(({ entry, score }) => {
      const age = Math.round((Date.now() - entry.timestamp) / 3_600_000)
      const ageStr = age < 1 ? 'just now' : age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`
      return `[${entry.category}] (${ageStr}, ${entry.domain}) ${entry.content.slice(0, 500)}`
    })
    .join('\n\n')
}

// ─── High-level recording (mirrors mempalace-learner API) ───────────────────

export async function recallLocalMemories(query: string, domain: string): Promise<string> {
  const parts: string[] = []

  // Search errors for this domain
  const errors = await searchLocalMemory(query, { category: 'error', domain, limit: 3 })
  if (errors) parts.push('Past errors:\n' + errors)

  // Search lessons
  const lessons = await searchLocalMemory(query, { category: 'lesson', limit: 3 })
  if (lessons) parts.push('Learned lessons:\n' + lessons)

  // Search domain knowledge
  const domainKnowledge = await searchLocalMemory(query, { category: 'domain_knowledge', domain, limit: 2 })
  if (domainKnowledge) parts.push('Domain knowledge:\n' + domainKnowledge)

  // Search successes
  const successes = await searchLocalMemory(query, { category: 'success', domain, limit: 2 })
  if (successes) parts.push('Past successes:\n' + successes)

  return parts.length > 0 ? parts.join('\n\n') : ''
}

export async function recordLocalFailure(
  result: AIActionResult,
  context: { url: string; domain: string; userGoal?: string; attempt?: string },
): Promise<void> {
  const content = [
    `Action: ${result.action}`,
    `Error: ${result.error ?? 'unknown'}`,
    context.userGoal ? `Goal: ${context.userGoal}` : '',
    context.attempt ? `Attempt: ${context.attempt}` : '',
    `URL: ${context.url}`,
  ].filter(Boolean).join('\n')

  await storeLocalMemory('error', context.domain, content, `error:${context.domain}`)
}

export async function recordLocalSuccess(
  result: AIActionResult,
  context: { url: string; domain: string; userGoal?: string; approach?: string },
): Promise<void> {
  const content = [
    `Action: ${result.action}`,
    `Result: ${result.result ?? 'success'}`,
    context.userGoal ? `Goal: ${context.userGoal}` : '',
    context.approach ? `Approach: ${context.approach}` : '',
    `URL: ${context.url}`,
  ].filter(Boolean).join('\n')

  await storeLocalMemory('success', context.domain, content, `success:${context.domain}`)
}

export async function recordLocalLesson(
  lesson: string,
  meta: { source: string; domain?: string },
): Promise<void> {
  await storeLocalMemory('lesson', meta.domain ?? '*', lesson, meta.source)
}

export async function recordLocalDomainKnowledge(
  domain: string,
  knowledge: string,
): Promise<void> {
  await storeLocalMemory('domain_knowledge', domain, knowledge, `domain:${domain}`)
}

// ─── Maintenance ────────────────────────────────────────────────────────────

async function pruneLocalMemory(maxEntries: number): Promise<void> {
  const all = await dbGetAll<LocalMemoryEntry>(STORE.LOCAL_MEMORY)
  if (all.length <= maxEntries) return

  // Sort: keep most-accessed and most-recent, delete the rest
  all.sort((a, b) => {
    // Primary: access count (more accessed = more valuable)
    if (a.accessCount !== b.accessCount) return b.accessCount - a.accessCount
    // Secondary: recency
    return b.timestamp - a.timestamp
  })

  const toDelete = all.slice(maxEntries)
  for (const entry of toDelete) {
    if (entry.id !== undefined) {
      await dbDelete(STORE.LOCAL_MEMORY, entry.id).catch(() => {})
    }
  }
}

export async function clearLocalMemory(): Promise<void> {
  const all = await dbGetAll<LocalMemoryEntry>(STORE.LOCAL_MEMORY)
  for (const entry of all) {
    if (entry.id !== undefined) {
      await dbDelete(STORE.LOCAL_MEMORY, entry.id).catch(() => {})
    }
  }
}

export async function getLocalMemoryStats(): Promise<{ total: number; byCategory: Record<string, number> }> {
  const all = await dbGetAll<LocalMemoryEntry>(STORE.LOCAL_MEMORY)
  const byCategory: Record<string, number> = {}
  for (const entry of all) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1
  }
  return { total: all.length, byCategory }
}
