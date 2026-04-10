/**
 * Smart Auto-Collection — monitors user form input, sends to LLM for analysis,
 * extracts reusable personal data (name, email, phone, address, card, etc.),
 * and stores it in the encrypted vault automatically.
 *
 * Users see auto-collected data in the Vault tab with an "Auto-collected" badge
 * and can approve, edit, or dismiss entries.
 */

import type { Settings, VaultEntry } from '../shared/types'
import { callAI } from './ai-client'
import { getAllSettings } from './memory-manager'
import { vaultList, vaultSet } from './memory-manager'
import { encryptData } from './crypto-manager'

// ─── Buffer state ───────────────────────────────────────────────────────────

interface BufferedInput {
  field: string     // field name/label/selector
  type: string      // input type (text, email, tel, etc.)
  value: string     // what user typed
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

// ─── Public API ─────────────────────────────────────────────────────────────

/** Check if auto-collection is enabled */
export function autoCollectEnabled(settings: Settings): boolean {
  return settings.autoCollectEnabled !== false
}

/**
 * Buffer a user input event. Called from service-worker MSG.USER_ACTION handler.
 * Only buffers meaningful form inputs (not clicks, scrolls, etc.)
 */
export function bufferUserInput(
  tabId: number,
  domain: string,
  url: string,
  event: { type: string; selector?: string; value?: string; tagName?: string; inputType?: string },
): void {
  // Only buffer text input events
  if (event.type !== 'input' && event.type !== 'change') return
  if (!event.value || event.value.length < 2) return

  // Skip password fields
  if (event.inputType === 'password') return

  // Skip search boxes
  if (event.selector?.includes('search') || event.inputType === 'search') return

  let buffer = tabBuffers.get(tabId)
  if (!buffer) {
    buffer = { tabId, domain, url, inputs: [], lastInputTime: 0, flushTimer: null, flushing: false }
    tabBuffers.set(tabId, buffer)
  }

  // Update or add input
  const existingIdx = buffer.inputs.findIndex(i => i.field === (event.selector ?? ''))
  const entry: BufferedInput = {
    field: event.selector ?? 'unknown',
    type: event.inputType ?? 'text',
    value: event.value,
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
  // Build the extraction prompt
  const inputLines = buffer.inputs
    .filter(i => i.value && i.value.length >= 2)
    .map(i => `- Field "${i.field}" (type: ${i.type}): "${i.value}"`)
    .join('\n')

  if (!inputLines) return

  const prompt = `Analyze these form inputs the user just entered on ${buffer.domain}. Extract any reusable personal information that could be useful for auto-filling other forms in the future.

Return ONLY a valid JSON array. Each item must have:
- "type": one of "contact", "address", "card", "credential", "identity"
- "label": short description (e.g. "Work Email", "Home Address")
- "fields": object with the extracted data

Field mappings by type:
- contact: { firstName, lastName, email, phone, company, birthday }
- address: { firstName, lastName, street, city, state, zip, country, phone }
- card: { cardholderName, number, expiry, cvv, billingZip }
- credential: { username, password, url, notes }
- identity: { firstName, lastName, email, phone, birthday, address }

Combine related fields into ONE entry when possible (e.g. first name + last name + email = one contact entry).
Only include fields that have actual values. Skip empty or placeholder values.
If the data doesn't contain any reusable personal info, return an empty array: []

User inputs on ${buffer.domain}:
${inputLines}

JSON array:`

  const messages = [
    { role: 'user' as const, content: prompt },
  ]

  try {
    const response = await callAI(messages, settings, 1024)
    if (!response) return

    const entries = parseExtractionResult(response)
    if (entries.length === 0) return

    await storeAutoCollected(entries, buffer.domain, settings)
    console.log(`[LocalAI] Auto-collected ${entries.length} entries from ${buffer.domain}`)
  } catch (err) {
    console.warn('[LocalAI] Auto-collection extraction failed:', err)
  }
}

interface ExtractedEntry {
  type: string
  label: string
  fields: Record<string, string>
}

function parseExtractionResult(response: string): ExtractedEntry[] {
  // Try to extract JSON array from the response
  const jsonMatch = response.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedEntry[]
    if (!Array.isArray(parsed)) return []

    // Validate entries
    return parsed.filter(entry =>
      entry.type && entry.label && entry.fields &&
      typeof entry.fields === 'object' &&
      Object.keys(entry.fields).length > 0 &&
      ['contact', 'address', 'card', 'credential', 'identity'].includes(entry.type),
    )
  } catch {
    return []
  }
}

async function storeAutoCollected(
  entries: ExtractedEntry[],
  domain: string,
  settings: Settings,
): Promise<void> {
  // Get existing vault entries to avoid duplicates
  const existing = await vaultList().catch(() => [])

  for (const entry of entries) {
    // Check for duplicates: same category + similar label
    const isDuplicate = existing.some(v =>
      v.category === entry.type &&
      v.label.toLowerCase() === entry.label.toLowerCase() &&
      v.autoCollected,
    )
    if (isDuplicate) continue

    // Encrypt the extracted fields
    const encrypted = await encryptData(JSON.stringify(entry.fields)).catch(() => null)
    if (!encrypted) continue

    const vaultEntry: VaultEntry = {
      id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      category: entry.type as VaultEntry['category'],
      label: entry.label,
      encryptedData: encrypted,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autoCollected: true,
      sourceDomain: domain,
    }

    await vaultSet(vaultEntry).catch(err => {
      console.warn('[LocalAI] Failed to store auto-collected entry:', err)
    })
  }
}

// ─── Vault helpers for auto-collected entries ───────────────────────────────

/** Get count of pending auto-collected items (for badge display) */
export async function getAutoCollectedCount(): Promise<number> {
  const all = await vaultList().catch(() => [])
  return all.filter(v => v.autoCollected).length
}

/** Approve an auto-collected entry (removes the flag) */
export async function approveAutoCollected(id: string): Promise<void> {
  const all = await vaultList().catch(() => [])
  const entry = all.find(v => v.id === id)
  if (entry) {
    entry.autoCollected = false
    entry.updatedAt = Date.now()
    await vaultSet(entry)
  }
}

/** Approve all pending auto-collected entries */
export async function approveAllAutoCollected(): Promise<number> {
  const all = await vaultList().catch(() => [])
  const pending = all.filter(v => v.autoCollected)
  for (const entry of pending) {
    entry.autoCollected = false
    entry.updatedAt = Date.now()
    await vaultSet(entry)
  }
  return pending.length
}
