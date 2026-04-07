import { dbPut, dbGetAll, dbGetByIndexRange } from '../shared/idb'
import { STORE } from '../shared/constants'
import { getRecentSessionMemory, addGlobalMemory } from './memory-manager'
import { callAI } from './ai-client'
import type { Settings, SessionMemoryEntry } from '../shared/types'

interface HabitPattern {
  id?: number
  domain: string
  pattern: string
  frequency: number
  lastSeen: number
  timestamp: number
  confidence: number
}

export async function analyzeHabits(settings: Settings): Promise<void> {
  const recent = await getRecentSessionMemory(200)
  if (recent.length < 20) return

  const domainFreqs = buildDomainFrequency(recent)
  const timePatterns = buildTimePatterns(recent)
  const workflows = detectWorkflows(recent)

  const patterns = [...domainFreqs, ...timePatterns, ...workflows]

  for (const p of patterns) {
    await dbPut(STORE.HABIT_PATTERNS, p)
  }

  if (patterns.length > 0) {
    const summary = patterns.slice(0, 5).map(p => p.pattern).join('; ')
    await addGlobalMemory({
      domain: 'habits',
      summary: `Detected patterns: ${summary}`,
      tags: ['habit', 'pattern'],
      importance: 0.6,
      timestamp: Date.now(),
      sourceCount: patterns.length,
    })
  }
}

function buildDomainFrequency(entries: SessionMemoryEntry[]): HabitPattern[] {
  const freq = new Map<string, { count: number; lastSeen: number }>()

  for (const e of entries) {
    if (!e.domain) continue
    const existing = freq.get(e.domain)
    if (existing) {
      existing.count++
      existing.lastSeen = Math.max(existing.lastSeen, e.timestamp)
    } else {
      freq.set(e.domain, { count: 1, lastSeen: e.timestamp })
    }
  }

  return [...freq.entries()]
    .filter(([, v]) => v.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([domain, data]) => ({
      domain,
      pattern: `Visits ${domain} frequently (${data.count} times)`,
      frequency: data.count,
      lastSeen: data.lastSeen,
      timestamp: Date.now(),
      confidence: Math.min(data.count / 20, 1),
    }))
}

function buildTimePatterns(entries: SessionMemoryEntry[]): HabitPattern[] {
  const hourBuckets = new Map<string, { domain: string; hour: number; count: number }>()

  for (const e of entries) {
    if (!e.domain) continue
    const hour = new Date(e.timestamp).getHours()
    const key = `${e.domain}:${hour}`
    const existing = hourBuckets.get(key)
    if (existing) {
      existing.count++
    } else {
      hourBuckets.set(key, { domain: e.domain, hour, count: 1 })
    }
  }

  return [...hourBuckets.values()]
    .filter(b => b.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(b => ({
      domain: b.domain,
      pattern: `Usually visits ${b.domain} around ${b.hour}:00 (${b.count} times)`,
      frequency: b.count,
      lastSeen: Date.now(),
      timestamp: Date.now(),
      confidence: Math.min(b.count / 10, 1),
    }))
}

function detectWorkflows(entries: SessionMemoryEntry[]): HabitPattern[] {
  const transitions = new Map<string, number>()
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp)

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].domain
    const curr = sorted[i].domain
    if (!prev || !curr || prev === curr) continue
    if (sorted[i].timestamp - sorted[i - 1].timestamp > 300_000) continue

    const key = `${prev}->${curr}`
    transitions.set(key, (transitions.get(key) ?? 0) + 1)
  }

  return [...transitions.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([transition, count]) => {
      const [from, to] = transition.split('->')
      return {
        domain: from,
        pattern: `Often goes from ${from} to ${to} (${count} times)`,
        frequency: count,
        lastSeen: Date.now(),
        timestamp: Date.now(),
        confidence: Math.min(count / 8, 1),
      }
    })
}

export async function getHabitPatterns(limit = 20): Promise<HabitPattern[]> {
  return dbGetByIndexRange<HabitPattern>(
    STORE.HABIT_PATTERNS, 'by_timestamp', IDBKeyRange.lowerBound(0), limit
  )
}

export async function generateHabitSuggestions(settings: Settings): Promise<string> {
  const patterns = await getHabitPatterns(10)
  if (patterns.length === 0) return ''

  const patternText = patterns.map(p => p.pattern).join('\n')
  return callAI([
    {
      role: 'system',
      content: 'Based on the user\'s browsing habits, generate 2-3 short, actionable suggestions. Be concise.',
    },
    {
      role: 'user',
      content: `My browsing habits:\n${patternText}\n\nWhat do you suggest?`,
    },
  ], settings, 256)
}
