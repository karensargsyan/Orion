/**
 * Smart Auto-Collection — monitors user form input, sends to LLM for analysis,
 * extracts reusable personal data (name, email, phone, address, card, etc.),
 * and stores it in the encrypted vault automatically.
 *
 * Users see auto-collected data in the Vault tab with an "Auto-collected" badge
 * and can approve, edit, or dismiss entries.
 *
 * Pipeline:
 *   action-monitor.ts (content script, captures input events with field labels)
 *     → MSG.USER_ACTION → service-worker.ts → bufferUserInput()
 *       → On trigger (submit / idle 30s / tab close):
 *         → flushAndExtract() → callAI() → parseExtractionResult()
 *           → storeAutoCollected() (encrypted via crypto-manager)
 *             → Vault UI shows with "Auto-collected" badge
 */

import type { Settings, VaultEntry, VaultCategory } from '../shared/types'
import { callAI } from './ai-client'
import { getAllSettings } from './memory-manager'
import { vaultList, vaultSet } from './memory-manager'
import { encryptData, isSessionUnlocked } from './crypto-manager'

// ─── Buffer state ───────────────────────────────────────────────────────────

interface BufferedInput {
  /** Human-readable field label (from <label>, placeholder, aria-label, or name attr) */
  label: string
  /** CSS selector for deduplication */
  selector: string
  /** HTML input type (text, email, tel, etc.) */
  inputType: string
  /** What the user typed */
  value: string
  timestamp: number
}

interface TabBuffer {
  tabId: number
  domain: string
  url: string
  inputs: BufferedInput[]
  lastInputTime: number
  flushTimer: ReturnType<typeof setTimeout> | null
  flushing: boolean
}

const tabBuffers = new Map<number, TabBuffer>()

/** Idle timeout: flush after 30s of no input */
const IDLE_FLUSH_MS = 30_000

/** Valid vault categories for extracted entries */
const VALID_CATEGORIES: VaultCategory[] = ['contact', 'address', 'card', 'credential', 'identity', 'custom']

// ─── Public API ─────────────────────────────────────────────────────────────

/** Check if auto-collection is enabled */
export function autoCollectEnabled(settings: Settings): boolean {
  return settings.autoCollectEnabled !== false
}

/**
 * Buffer a user input event. Called from service-worker MSG.USER_ACTION handler.
 * Only buffers meaningful form inputs — skips passwords, search, redacted values.
 */
export function bufferUserInput(
  tabId: number,
  domain: string,
  url: string,
  event: {
    type: string
    selector?: string
    value?: string
    tagName?: string
    inputType?: string
    fieldLabel?: string
  },
): void {
  // Only buffer text input/change events
  if (event.type !== 'input' && event.type !== 'change') return

  // Skip empty or tiny values
  if (!event.value || event.value.length < 2) return

  // Skip redacted values (passwords already masked by content script)
  if (event.value === '[redacted]') return

  // Skip password fields
  if (event.inputType === 'password') return

  // Skip search fields
  const selectorLower = (event.selector ?? '').toLowerCase()
  const labelLower = (event.fieldLabel ?? '').toLowerCase()
  if (event.inputType === 'search' ||
      selectorLower.includes('search') ||
      labelLower.includes('search')) return

  // Skip hidden/captcha/token fields
  if (event.inputType === 'hidden' || selectorLower.includes('captcha') ||
      selectorLower.includes('token') || selectorLower.includes('csrf')) return

  let buffer = tabBuffers.get(tabId)
  if (!buffer) {
    buffer = { tabId, domain, url, inputs: [], lastInputTime: 0, flushTimer: null, flushing: false }
    tabBuffers.set(tabId, buffer)
  }

  // Build human-readable field label
  const fieldLabel = event.fieldLabel ?? extractLabelFromSelector(event.selector ?? '')

  // Update existing input for same field, or add new
  const existingIdx = buffer.inputs.findIndex(i => i.selector === (event.selector ?? ''))
  const entry: BufferedInput = {
    label: fieldLabel,
    selector: event.selector ?? 'unknown',
    inputType: event.inputType ?? 'text',
    value: event.value.slice(0, 300), // cap to prevent huge values
    timestamp: Date.now(),
  }

  if (existingIdx >= 0) {
    buffer.inputs[existingIdx] = entry
  } else {
    buffer.inputs.push(entry)
  }

  buffer.lastInputTime = Date.now()
  buffer.domain = domain
  buffer.url = url

  // Reset idle timer
  if (buffer.flushTimer) clearTimeout(buffer.flushTimer)
  buffer.flushTimer = setTimeout(() => {
    triggerFlush(tabId).catch(() => {})
  }, IDLE_FLUSH_MS)
}

/**
 * Force flush on form submit or navigation.
 */
export async function triggerFlush(tabId: number): Promise<void> {
  const buffer = tabBuffers.get(tabId)
  if (!buffer || buffer.inputs.length === 0 || buffer.flushing) return

  const settings = await getAllSettings().catch(() => null)
  if (!settings || !autoCollectEnabled(settings)) return

  const minFields = settings.autoCollectMinFields ?? 3
  if (buffer.inputs.length < minFields) return

  // Check excluded domains
  const excluded = settings.autoCollectExcludeDomains ?? []
  if (excluded.some(d => buffer.domain.includes(d))) return

  // Check vault is unlocked (encryption requires active key)
  const unlocked = await isSessionUnlocked().catch(() => false)
  if (!unlocked) {
    console.warn('[AutoCollect] Vault locked — skipping extraction (data will be lost)')
    return
  }

  buffer.flushing = true
  if (buffer.flushTimer) { clearTimeout(buffer.flushTimer); buffer.flushTimer = null }

  try {
    await flushAndExtract(buffer, settings)
  } finally {
    buffer.flushing = false
    // Clear buffer after processing
    buffer.inputs = []
  }
}

/** Clean up buffer when tab is closed */
export function clearBuffer(tabId: number): void {
  const buffer = tabBuffers.get(tabId)
  if (buffer?.flushTimer) clearTimeout(buffer.flushTimer)
  tabBuffers.delete(tabId)
}

// ─── LLM Extraction ────────────────────────────────────────────────────────

async function flushAndExtract(buffer: TabBuffer, settings: Settings): Promise<void> {
  // Filter out empty/irrelevant inputs
  const meaningful = buffer.inputs.filter(i =>
    i.value && i.value.length >= 2 && i.value !== '[redacted]'
  )

  if (meaningful.length === 0) return

  // Build the extraction prompt with human-readable labels
  const inputLines = meaningful
    .map(i => {
      const label = i.label || i.selector
      return `- "${label}" (type: ${i.inputType}): "${i.value}"`
    })
    .join('\n')

  const prompt = `Analyze these form inputs the user just entered on ${buffer.domain}. Extract any reusable personal information that could be useful for auto-filling other forms in the future.

Return ONLY a valid JSON array. Each item must have:
- "type": one of "contact", "address", "card", "credential", "identity"
- "label": short description (e.g. "Work Email", "Home Address", "Personal Phone")
- "fields": object with the extracted data fields

Field mappings by type:
- contact: { firstName, lastName, email, phone, company, birthday }
- address: { firstName, lastName, street, city, state, zip, country, phone }
- card: { cardholderName, number, expiry, cvv, billingZip }
- credential: { username, password, url, notes }
- identity: { firstName, lastName, email, phone, birthday }

Rules:
1. Combine related fields into ONE entry when possible (e.g. first name + last name + email → one "contact" entry).
2. Only include fields that have actual user-entered values. Skip empty/placeholder values.
3. Recognize common form patterns: "First Name"="John" + "Last Name"="Doe" + "Email"="john@example.com" → contact entry.
4. Phone numbers, emails, and addresses are high-value — always extract them.
5. If the data doesn't contain any reusable personal info, return an empty array: []
6. Do NOT create entries from single-word inputs or obvious non-personal data (page navigation, button text, etc.)

User inputs on ${buffer.domain} (${buffer.url}):
${inputLines}

JSON array:`

  try {
    const response = await callAI(
      [{ role: 'user' as const, content: prompt }],
      settings,
      1024
    )
    if (!response) return

    const entries = parseExtractionResult(response)
    if (entries.length === 0) return

    // Deduplicate against existing vault entries before storing
    await storeAutoCollected(entries, buffer.domain)
    console.warn(`[AutoCollect] Extracted ${entries.length} entries from ${buffer.domain}`)
  } catch (err) {
    console.warn('[AutoCollect] Extraction failed:', err)
  }
}

interface ExtractedEntry {
  type: string
  label: string
  fields: Record<string, string>
}

function parseExtractionResult(response: string): ExtractedEntry[] {
  // Try to extract JSON array from the response (LLMs sometimes add text around it)
  const jsonMatch = response.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedEntry[]
    if (!Array.isArray(parsed)) return []

    // Validate and clean entries
    return parsed.filter(entry => {
      if (!entry.type || !entry.label || !entry.fields) return false
      if (typeof entry.fields !== 'object') return false

      // Validate category
      if (!VALID_CATEGORIES.includes(entry.type as VaultCategory)) return false

      // Must have at least one non-empty field value
      const fieldValues = Object.values(entry.fields).filter(v => v && String(v).trim().length > 0)
      if (fieldValues.length === 0) return false

      // Sanitize: convert all field values to strings
      for (const [k, v] of Object.entries(entry.fields)) {
        entry.fields[k] = String(v ?? '').trim()
        if (!entry.fields[k]) delete entry.fields[k]
      }

      return true
    })
  } catch {
    return []
  }
}

async function storeAutoCollected(
  entries: ExtractedEntry[],
  domain: string,
): Promise<void> {
  // Get existing vault entries to avoid duplicates
  const existing = await vaultList().catch(() => [] as VaultEntry[])

  for (const entry of entries) {
    // Smart duplicate check: same category + overlapping field values
    const isDuplicate = existing.some(v => {
      if (v.category !== entry.type) return false
      // Label-based dedup
      if (v.label.toLowerCase() === entry.label.toLowerCase()) return true
      // We can't easily compare encrypted fields to new fields,
      // but we can skip if there's an auto-collected entry from the same domain
      // with the same category (user probably filled the same form)
      if (v.autoCollected && v.sourceDomain === domain && v.category === entry.type) return true
      return false
    })
    if (isDuplicate) continue

    // Encrypt the extracted fields
    const encrypted = await encryptData(JSON.stringify(entry.fields)).catch(() => null)
    if (!encrypted) {
      console.warn('[AutoCollect] Encryption failed — vault may be locked')
      continue
    }

    const vaultEntry: VaultEntry = {
      id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      category: entry.type as VaultCategory,
      label: entry.label,
      encryptedData: encrypted,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autoCollected: true,
      sourceDomain: domain,
    }

    await vaultSet(vaultEntry).catch(err => {
      console.warn('[AutoCollect] Failed to store entry:', err)
    })
  }
}

// ─── Vault helpers for auto-collected entries ───────────────────────────────

/** Get count of pending auto-collected items (for badge display) */
export async function getAutoCollectedCount(): Promise<number> {
  const all = await vaultList().catch(() => [] as VaultEntry[])
  return all.filter(v => v.autoCollected).length
}

/** Approve an auto-collected entry (removes the flag — becomes permanent) */
export async function approveAutoCollected(id: string): Promise<void> {
  const all = await vaultList().catch(() => [] as VaultEntry[])
  const entry = all.find(v => v.id === id)
  if (entry) {
    entry.autoCollected = false
    entry.updatedAt = Date.now()
    await vaultSet(entry)
  }
}

/** Approve all pending auto-collected entries */
export async function approveAllAutoCollected(): Promise<number> {
  const all = await vaultList().catch(() => [] as VaultEntry[])
  const pending = all.filter(v => v.autoCollected)
  for (const entry of pending) {
    entry.autoCollected = false
    entry.updatedAt = Date.now()
    await vaultSet(entry)
  }
  return pending.length
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Attempt to extract a readable label from a CSS selector as last resort */
function extractLabelFromSelector(selector: string): string {
  // Try to pull a name/id from the selector
  const idMatch = selector.match(/#([a-zA-Z][\w-]*)/)
  if (idMatch) {
    return idMatch[1]
      .replace(/[_-]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase())
  }
  const nameMatch = selector.match(/\[name="([^"]+)"\]/)
  if (nameMatch) {
    return nameMatch[1]
      .replace(/[_-]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase())
  }
  // Class-based fallback
  const classMatch = selector.match(/\.([a-zA-Z][\w-]*(?:input|field|name|email|phone|address)[\w-]*)/i)
  if (classMatch) {
    return classMatch[1]
      .replace(/[_-]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase())
  }
  return selector.slice(0, 60)
}
