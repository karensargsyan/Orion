/**
 * Permanent user instructions — stored in global_memory, injected into every
 * system prompt regardless of model. Triggered by phrases like "remember",
 * "add to your memory", "from now on", etc.
 *
 * v2: Instructions are prompt-engineered before storage — cleaned, formatted,
 * and optionally rewritten by LLM for maximum clarity. Domain-tagged when
 * saved on a specific page type. Grouped by domain tag in prompt output.
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

/**
 * Format instructions for prompt — groups by domain tag, prioritizes current page domain.
 */
export function formatUserInstructionsForPrompt(entries: GlobalMemoryEntry[], currentPageType?: string): string {
  if (entries.length === 0) return ''

  const sorted = [...entries].sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)

  // Separate domain-tagged from general instructions
  const domainTagRe = /^\[(\w+)]\s*/
  const tagged: Record<string, string[]> = {}
  const general: string[] = []

  for (const e of sorted) {
    const match = e.summary.match(domainTagRe)
    if (match) {
      const domain = match[1].toLowerCase()
      if (!tagged[domain]) tagged[domain] = []
      tagged[domain].push(e.summary.replace(domainTagRe, '').trim())
    } else {
      general.push(e.summary)
    }
  }

  const lines: string[] = []
  let idx = 1

  // Current page domain instructions first (if any match)
  if (currentPageType && tagged[currentPageType]) {
    lines.push(`**${currentPageType.charAt(0).toUpperCase() + currentPageType.slice(1)}-specific:**`)
    for (const inst of tagged[currentPageType]) {
      lines.push(`${idx++}. ${inst}`)
    }
  }

  // General instructions
  if (general.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('**General:**')
    for (const inst of general) {
      lines.push(`${idx++}. ${inst}`)
    }
  }

  // Other domain instructions
  for (const [domain, insts] of Object.entries(tagged)) {
    if (domain === currentPageType) continue
    lines.push('')
    lines.push(`**${domain.charAt(0).toUpperCase() + domain.slice(1)}-specific:**`)
    for (const inst of insts) {
      lines.push(`${idx++}. ${inst}`)
    }
  }

  return `## PERMANENT USER INSTRUCTIONS
The user explicitly asked you to follow these rules on every task. They override generic defaults when they conflict.

${lines.join('\n')}

Honor these instructions first (e.g. if asked to read emails: open each message and read body text, not only subjects).`
}

// ─── Prompt engineering for stored instructions ─────────────────────────────

/** Filler words to strip from instruction text. */
const FILLER_RE = /^\s*(please\s+)?(I\s+want\s+you\s+to|you\s+should|I\s+would\s+like\s+you\s+to|bitte|ich\s+möchte\s+dass\s+du|du\s+sollst)\s*/i

/** Convert user text into a clean, imperative instruction suitable for LLM consumption. */
export function formatInstructionForStorage(rawText: string, pageType?: string): string {
  let text = rawText.trim()

  // 1. Strip filler words
  text = text.replace(FILLER_RE, '')

  // 2. Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()

  // 3. Capitalize first letter
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1)
  }

  // 4. Ensure ends with period
  if (text.length > 0 && !/[.!?]$/.test(text)) {
    text += '.'
  }

  // 5. Imperative conversion for common patterns
  text = text
    .replace(/^I\s+prefer\s+/i, 'Always prefer ')
    .replace(/^I\s+like\s+/i, 'Always use ')
    .replace(/^I\s+always\s+/i, 'Always ')
    .replace(/^I\s+never\s+/i, 'Never ')
    .replace(/^I\s+don'?t\s+want\s+/i, 'Never ')
    .replace(/^My\s+preferred?\s+/i, 'Preferred ')
    .replace(/^Ich\s+bevorzuge\s+/i, 'Bevorzuge immer ')
    .replace(/^Ich\s+mag\s+/i, 'Verwende immer ')
    .replace(/^Ich\s+will\s+nicht\s+/i, 'Niemals ')

  // 6. Domain tag if on specific page type
  if (pageType && pageType !== 'general') {
    // Check if instruction seems domain-specific (mentions domain-related terms)
    const domainKeywords: Record<string, RegExp> = {
      travel: /\b(flight|airport|airline|hotel|booking|travel|flug|flughafen|reise|buchen)\b/i,
      shopping: /\b(product|price|cart|order|ship|buy|produkt|preis|warenkorb|bestell|kauf)\b/i,
      email: /\b(email|mail|inbox|compose|reply|send)\b/i,
      finance: /\b(bank|payment|transfer|balance|account|konto|zahlung|überweisung)\b/i,
      food: /\b(restaurant|order|delivery|food|recipe|essen|bestell|lieferung)\b/i,
    }
    const domainRe = domainKeywords[pageType]
    if (domainRe && domainRe.test(text)) {
      text = `[${pageType.charAt(0).toUpperCase() + pageType.slice(1)}] ${text}`
    }
  }

  return text.slice(0, MAX_SUMMARY_LEN)
}

/**
 * LLM-assisted instruction formatting. Rewrites the raw user instruction into
 * a clear, concise, actionable rule. Falls back to rules-based formatting if
 * the AI is unavailable.
 */
export async function promptEngineerInstruction(
  rawText: string,
  pageType: string | undefined,
  callAIFn: (messages: Array<{ role: string; content: string }>, maxTokens: number) => Promise<string>,
): Promise<string> {
  // Rules-based as fallback
  const rulesBased = formatInstructionForStorage(rawText, pageType)

  try {
    const messages = [
      {
        role: 'system',
        content: 'You are a prompt engineer. Rewrite the user\'s instruction as a clear, concise, actionable rule for an AI browser assistant. Keep the original meaning exactly. Use imperative form. Max 1-2 sentences. Return ONLY the rewritten instruction, nothing else.',
      },
      {
        role: 'user',
        content: `Rewrite this instruction:\n"${rawText.slice(0, 500)}"${pageType && pageType !== 'general' ? `\n\nContext: user is on a ${pageType} page.` : ''}`,
      },
    ]

    const result = await callAIFn(messages, 256)
    if (result && result.length >= 10 && result.length <= MAX_SUMMARY_LEN) {
      let formatted = result.trim()
      // Strip quotes if AI wrapped it
      formatted = formatted.replace(/^["']|["']$/g, '').trim()
      // Add domain tag if applicable
      if (pageType && pageType !== 'general') {
        const domainKeywords: Record<string, RegExp> = {
          travel: /\b(flight|airport|airline|hotel|booking|travel|flug)\b/i,
          shopping: /\b(product|price|cart|order|ship|buy|produkt)\b/i,
          email: /\b(email|mail|inbox|compose|reply)\b/i,
          finance: /\b(bank|payment|transfer|balance|account)\b/i,
        }
        const re = domainKeywords[pageType]
        if (re && re.test(formatted) && !formatted.startsWith('[')) {
          formatted = `[${pageType.charAt(0).toUpperCase() + pageType.slice(1)}] ${formatted}`
        }
      }
      return formatted
    }
  } catch { /* AI unavailable, use rules-based */ }

  return rulesBased
}

function similarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / Math.max(wa.size, wb.size, 1)
}
