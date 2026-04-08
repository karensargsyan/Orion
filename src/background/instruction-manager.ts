/**
 * Permanent user instructions — stored in global_memory, injected into every
 * system prompt regardless of model. Triggered by phrases like "remember",
 * "add to your memory", "from now on", etc.
 */

import { STORE } from '../shared/constants'
import { dbGetAllByIndex, dbPut, dbDelete } from '../shared/idb'
import type { GlobalMemoryEntry } from '../shared/types'

const INSTRUCTION_DOMAIN = 'assistant_instructions'
const TAG_INSTRUCTION = 'user_instruction'
const MAX_INSTRUCTIONS = 40
const MAX_SUMMARY_LEN = 2000

const SAVE_PATTERNS: RegExp[] = [
  /^(?:please\s+)?(?:add\s+this\s+to\s+your\s+(?:permanent\s+)?memory|remember\s+this|store\s+this|save\s+this)[:.\s]+(.+)/is,
  /^(?:remember|memorize)\s+that\s+(.+)/is,
  /^(?:please\s+)?remember\s+to\s+(.+)/is,
  /^(?:from\s+now\s+on|always|I\s+want\s+you\s+to)\s*[,:]?\s*(.+)/is,
  /^(?:add\s+to\s+(?:your\s+)?memory|save\s+to\s+memory)[:.\s]+(.+)/is,
  /^never\s+forget\s*(?:that\s*)?[:.]?\s*(.+)/is,
]

export function tryExtractInstructionToSave(userText: string): string | null {
  const t = userText.trim()
  if (t.length < 12 || t.length > MAX_SUMMARY_LEN + 200) return null

  for (const re of SAVE_PATTERNS) {
    const m = t.match(re)
    if (m?.[1]) {
      const extracted = m[1].trim()
      if (extracted.length >= 8) return extracted.slice(0, MAX_SUMMARY_LEN)
    }
  }

  if (/^(?:remember|store)\s*$/i.test(t.split('\n')[0]?.trim() ?? '') && t.includes('\n')) {
    const rest = t.split('\n').slice(1).join('\n').trim()
    if (rest.length >= 8) return rest.slice(0, MAX_SUMMARY_LEN)
  }

  return null
}

export async function saveUserInstruction(summary: string): Promise<void> {
  const text = summary.trim().slice(0, MAX_SUMMARY_LEN)
  if (text.length < 8) return

  const existing = await getAllUserInstructions()
  const dup = existing.find(e => e.summary === text || similarity(e.summary, text) > 0.85)
  if (dup && dup.id !== undefined) {
    dup.sourceCount += 1
    dup.timestamp = Date.now()
    dup.importance = Math.min(1, dup.importance + 0.05)
    await dbPut(STORE.GLOBAL_MEMORY, dup)
    return
  }

  if (existing.length >= MAX_INSTRUCTIONS) {
    const weakest = [...existing].sort((a, b) => a.importance - b.importance || a.timestamp - b.timestamp)[0]
    if (weakest.id !== undefined) await dbDelete(STORE.GLOBAL_MEMORY, weakest.id)
  }

  const entry: Omit<GlobalMemoryEntry, 'id'> = {
    domain: INSTRUCTION_DOMAIN,
    summary: text,
    tags: [TAG_INSTRUCTION, 'permanent'],
    importance: 0.95,
    timestamp: Date.now(),
    sourceCount: 1,
  }
  await dbPut(STORE.GLOBAL_MEMORY, entry)
}

export async function getAllUserInstructions(): Promise<GlobalMemoryEntry[]> {
  return dbGetAllByIndex<GlobalMemoryEntry>(STORE.GLOBAL_MEMORY, 'by_domain', INSTRUCTION_DOMAIN)
}

export function formatUserInstructionsForPrompt(entries: GlobalMemoryEntry[]): string {
  if (entries.length === 0) return ''

  const sorted = [...entries].sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
  const lines = sorted.map((e, i) => `${i + 1}. ${e.summary}`)

  return `## PERMANENT USER INSTRUCTIONS
The user explicitly asked you to follow these rules on every task. They override generic defaults when they conflict.

${lines.join('\n')}

Honor these instructions first (e.g. if asked to read emails: open each message and read body text, not only subjects).`
}

function similarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / Math.max(wa.size, wb.size, 1)
}
