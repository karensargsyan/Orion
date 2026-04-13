/**
 * Input Journal — Total Recall for form inputs.
 *
 * Captures all meaningful form inputs (emails, passwords, usernames, addresses, etc.)
 * into a dedicated IndexedDB store. Passwords and card data are encrypted using the
 * session AES-GCM key. Everything else is stored in plaintext for fast search.
 *
 * Integrated as a search source in handleAIMemorySearch() so the user can recall
 * any data they ever typed in the browser via natural language.
 */

import { STORE } from '../shared/constants'
import { openDB, dbPut } from '../shared/idb'
import type { InputJournalEntry, InputFieldType, Settings } from '../shared/types'
import { encryptData, decryptData, isSessionUnlocked } from './crypto-manager'
import { getSetting } from './memory-manager'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Field types whose values are encrypted before storage. */
const ENCRYPTED_FIELD_TYPES = new Set<InputFieldType>([
  'password', 'cardNumber', 'cardCvv', 'cardExpiry',
])

/** Field types we skip entirely (too noisy, low value). */
const IGNORE_FIELD_TYPES = new Set<InputFieldType>(['unknown'])

/** Dedup window: same (domain, fieldType, value) within this many ms is ignored. */
const DEDUP_WINDOW_MS = 5 * 60_000 // 5 minutes

/** Minimum value length to bother storing. */
const MIN_VALUE_LENGTH = 2

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Record a form input in the journal.
 * Handles dedup, encryption, and settings check internally.
 */
export async function journalInput(
  entry: Omit<InputJournalEntry, 'id'>
): Promise<void> {
  try {
    // Check if feature is enabled
    const enabled = await getSetting('inputJournalEnabled')
    if (enabled === false) return // default is true when undefined

    // Skip unclassified fields
    if (IGNORE_FIELD_TYPES.has(entry.fieldType)) return

    // Skip empty / too short
    const trimmed = entry.value?.trim()
    if (!trimmed || trimmed.length < MIN_VALUE_LENGTH) return

    // Dedup: check if same (domain, fieldType, value) exists within window
    const isDup = await isDuplicate(entry.domain, entry.fieldType, trimmed)
    if (isDup) return

    // Encrypt sensitive fields if session is unlocked
    let storedValue = trimmed
    let encrypted = false

    if (ENCRYPTED_FIELD_TYPES.has(entry.fieldType)) {
      const unlocked = await isSessionUnlocked()
      if (unlocked) {
        try {
          const blob = await encryptData(trimmed)
          storedValue = JSON.stringify(blob)
          encrypted = true
        } catch {
          // Can't encrypt — store redacted placeholder so we know it exists
          storedValue = '[encrypted-unavailable]'
          encrypted = false
        }
      } else {
        // Session locked — store redacted so we at least know it was entered
        storedValue = '[session-locked]'
        encrypted = false
      }
    }

    await dbPut<InputJournalEntry>(STORE.INPUT_JOURNAL, {
      fieldType: entry.fieldType,
      fieldLabel: entry.fieldLabel.slice(0, 120),
      value: storedValue,
      encrypted,
      domain: entry.domain,
      url: entry.url,
      inputType: entry.inputType,
      timestamp: entry.timestamp || Date.now(),
      source: entry.source,
    })
  } catch (err) {
    console.warn('[InputJournal] Failed to journal input:', err)
  }
}

/**
 * Search the input journal. Returns a formatted string for AI context.
 * Decrypts encrypted values if the session is unlocked.
 */
export async function searchInputJournal(
  query: string,
  limit = 20
): Promise<string> {
  const db = await openDB()
  const tx = db.transaction(STORE.INPUT_JOURNAL, 'readonly')
  const store = tx.objectStore(STORE.INPUT_JOURNAL)
  const index = store.index('by_timestamp')

  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1)
  if (terms.length === 0) return ''

  const results: InputJournalEntry[] = []
  const unlocked = await isSessionUnlocked()

  return new Promise<string>((resolve, reject) => {
    const req = index.openCursor(null, 'prev') // newest first
    let scanned = 0

    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || results.length >= limit) {
        resolve(formatResults(results))
        return
      }

      scanned++
      // Safety: don't scan more than 2000 entries
      if (scanned > 2000) {
        resolve(formatResults(results))
        return
      }

      const entry = cursor.value as InputJournalEntry
      const matchesQuery = matchEntry(entry, terms, unlocked)
      if (matchesQuery) {
        results.push(entry)
      }
      cursor.continue()
    }

    req.onerror = () => reject(req.error)
  })
}

/**
 * Get recent journal entries for browsing (no search filter).
 */
export async function getRecentJournalEntries(limit = 50): Promise<InputJournalEntry[]> {
  const db = await openDB()
  const tx = db.transaction(STORE.INPUT_JOURNAL, 'readonly')
  const store = tx.objectStore(STORE.INPUT_JOURNAL)
  const index = store.index('by_timestamp')

  return new Promise<InputJournalEntry[]>((resolve, reject) => {
    const results: InputJournalEntry[] = []
    const req = index.openCursor(null, 'prev')

    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || results.length >= limit) {
        resolve(results)
        return
      }
      results.push(cursor.value as InputJournalEntry)
      cursor.continue()
    }

    req.onerror = () => reject(req.error)
  })
}

/**
 * Decrypt a journal entry's value if it's encrypted and session is unlocked.
 */
export async function decryptJournalValue(entry: InputJournalEntry): Promise<string> {
  if (!entry.encrypted) return entry.value
  try {
    const blob = JSON.parse(entry.value) as { iv: string; ct: string }
    return await decryptData(blob)
  } catch {
    return '[encrypted]'
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function isDuplicate(
  domain: string,
  fieldType: InputFieldType,
  value: string
): Promise<boolean> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE.INPUT_JOURNAL, 'readonly')
    const store = tx.objectStore(STORE.INPUT_JOURNAL)
    const index = store.index('by_fieldType_domain')
    const cutoff = Date.now() - DEDUP_WINDOW_MS

    return new Promise<boolean>((resolve) => {
      const req = index.openCursor(IDBKeyRange.only([fieldType, domain]), 'prev')
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) { resolve(false); return }
        const entry = cursor.value as InputJournalEntry
        // Only check recent entries
        if (entry.timestamp < cutoff) { resolve(false); return }
        // For non-encrypted entries, compare plaintext
        if (!entry.encrypted && entry.value === value) { resolve(true); return }
        cursor.continue()
      }
      req.onerror = () => resolve(false)
    })
  } catch {
    return false
  }
}

function matchEntry(
  entry: InputJournalEntry,
  terms: string[],
  unlocked: boolean
): boolean {
  // Build searchable text from entry fields
  const parts = [
    entry.fieldLabel,
    entry.fieldType,
    entry.domain,
    entry.inputType,
  ]

  // Include plaintext values in search
  if (!entry.encrypted) {
    parts.push(entry.value)
  }
  // We could decrypt here, but it's expensive per-entry.
  // For encrypted fields, match on metadata only (domain, fieldType, label).

  const searchText = parts.join(' ').toLowerCase()
  return terms.every(t => searchText.includes(t))
}

function formatResults(entries: InputJournalEntry[]): string {
  if (entries.length === 0) return ''

  return entries.map(e => {
    const date = new Date(e.timestamp).toLocaleString()
    const displayValue = e.encrypted ? '[encrypted]' : e.value
    return `[${e.domain}] ${e.fieldLabel || e.fieldType}: ${displayValue} (${e.fieldType}, ${date})`
  }).join('\n')
}
