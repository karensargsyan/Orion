import type { WatchSession, WatchEvent, WatchChangeCategory } from '../shared/types'
import { MSG } from '../shared/constants'

const watchSessions = new Map<number, WatchSession>()
const MAX_EVENTS = 50
const DEFAULT_INTERVAL_SEC = 30

export function startWatch(
  tabId: number,
  selector?: string,
  baseline?: string,
  intervalSec = DEFAULT_INTERVAL_SEC,
): WatchSession {
  // Stop existing watch on this tab
  stopWatch(tabId)

  const alarmName = `watch-${tabId}`
  const session: WatchSession = {
    tabId,
    selector,
    baseline: baseline ?? '',
    startedAt: Date.now(),
    intervalSec,
    alarmName,
    eventCount: 0,
  }
  watchSessions.set(tabId, session)

  chrome.alarms.create(alarmName, { periodInMinutes: intervalSec / 60 })
  return session
}

export function stopWatch(tabId: number): void {
  const session = watchSessions.get(tabId)
  if (session) {
    chrome.alarms.clear(session.alarmName)
    watchSessions.delete(tabId)
    // Clear badge if no more active watch sessions
    if (watchSessions.size === 0) {
      chrome.action.setBadgeText({ text: '' }).catch(() => {})
    }
  }
}

export function getWatchSession(tabId: number): WatchSession | undefined {
  return watchSessions.get(tabId)
}

export function isWatching(tabId: number): boolean {
  return watchSessions.has(tabId)
}

export function getAllWatchSessions(): WatchSession[] {
  return Array.from(watchSessions.values())
}

/**
 * Called on alarm tick — sends WATCH_CHECK to the content script,
 * compares result to baseline, emits WATCH_EVENT if changed.
 */
export async function handleWatchAlarm(tabId: number): Promise<WatchEvent | null> {
  const session = watchSessions.get(tabId)
  if (!session) return null

  // Auto-stop after too many events
  if (session.eventCount >= MAX_EVENTS) {
    stopWatch(tabId)
    return null
  }

  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: MSG.WATCH_CHECK,
      selector: session.selector,
    }) as { ok?: boolean; currentValue?: string }

    if (!resp?.ok || resp.currentValue === undefined) return null

    const currentValue = resp.currentValue
    if (currentValue === session.baseline) return null

    // Classify the change (V3: FR-V3-7)
    const classification = classifyChange(session.baseline, currentValue)

    // Suppress cosmetic changes by default
    if (!classification.isSignificant) return null

    const event: WatchEvent = {
      tabId,
      selector: session.selector,
      oldValue: session.baseline,
      newValue: currentValue,
      timestamp: Date.now(),
      category: classification.category,
      summary: classification.summary,
      numericDelta: classification.numericDelta,
      isSignificant: classification.isSignificant,
    }

    // Update baseline to the new value
    session.baseline = currentValue
    session.eventCount++

    // Fire system notification for the change
    try {
      chrome.notifications.create(`watch-${tabId}-${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Orion: Page Changed',
        message: classification.summary || 'A watched element has changed.',
        priority: classification.category === 'price_change' ? 2 : 1,
      })
      // Update badge with unread change count
      const badgeCount = session.eventCount
      chrome.action.setBadgeText({ text: badgeCount > 0 ? String(badgeCount) : '' })
      chrome.action.setBadgeBackgroundColor({ color: '#7c6ef5' })
    } catch { /* notification permission may not be granted */ }

    return event
  } catch {
    // Tab may have been closed or navigated away
    stopWatch(tabId)
    return null
  }
}

/**
 * Parse a watch alarm name to extract tabId.
 * Returns undefined if the alarm is not a watch alarm.
 */
export function parseWatchAlarmName(name: string): number | undefined {
  if (!name.startsWith('watch-')) return undefined
  const id = parseInt(name.slice(6), 10)
  return isNaN(id) ? undefined : id
}

// ─── Advanced Watch Intelligence (V3: FR-V3-7) ──────────────────────────────

interface ChangeClassification {
  category: WatchChangeCategory
  summary: string
  numericDelta?: number
  isSignificant: boolean
}

const STATUS_KEYWORDS = /\b(in\s*stock|out\s*of\s*stock|available|unavailable|sold\s*out|enabled|disabled|active|inactive|online|offline|open|closed|error|success|failed|pending|approved|rejected|shipped|delivered)\b/i

const NOISE_PATTERNS = [
  /\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?\b/g,    // timestamps
  /\b\d{4}-\d{2}-\d{2}\b/g,                             // ISO dates
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4}\b/gi, // written dates
  /\bads?\s*by\b.*$/gim,                                 // ad attributions
  /\b[a-f0-9]{8,}\b/gi,                                  // hex IDs / tracking tokens
]

function normalizeText(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim().toLowerCase()
  for (const pattern of NOISE_PATTERNS) {
    t = t.replace(pattern, '')
  }
  return t.replace(/\s+/g, ' ').trim()
}

function extractNumbers(text: string): number[] {
  const matches = text.match(/[\$\u20AC\u00A3]?\s*[\d,]+\.?\d*/g) || []
  return matches
    .map(m => parseFloat(m.replace(/[\$\u20AC\u00A3,\s]/g, '')))
    .filter(n => !isNaN(n))
}

function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  const setA = new Set(a.split(/\s+/))
  const setB = new Set(b.split(/\s+/))
  let intersection = 0
  for (const w of setA) { if (setB.has(w)) intersection++ }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 1 : intersection / union
}

function classifyChange(oldValue: string, newValue: string): ChangeClassification {
  const oldNorm = normalizeText(oldValue)
  const newNorm = normalizeText(newValue)

  // If normalized text is identical, this is a cosmetic change
  if (oldNorm === newNorm) {
    return { category: 'cosmetic', summary: 'Cosmetic change (timestamps, IDs)', isSignificant: false }
  }

  // Check for numeric/price changes
  const oldNums = extractNumbers(oldValue)
  const newNums = extractNumbers(newValue)
  if (oldNums.length > 0 && newNums.length > 0) {
    const oldMain = oldNums[0]
    const newMain = newNums[0]
    if (oldMain !== newMain) {
      const delta = newMain - oldMain
      const direction = delta < 0 ? 'dropped' : 'increased'
      const absStr = Math.abs(delta).toFixed(2).replace(/\.?0+$/, '')
      return {
        category: 'price_change',
        summary: `Value ${direction}: ${oldMain} \u2192 ${newMain} (${delta > 0 ? '+' : ''}${absStr})`,
        numericDelta: delta,
        isSignificant: true,
      }
    }
  }

  // Check for status keyword changes
  const oldStatus = oldValue.match(STATUS_KEYWORDS)
  const newStatus = newValue.match(STATUS_KEYWORDS)
  if (newStatus && (!oldStatus || oldStatus[0].toLowerCase() !== newStatus[0].toLowerCase())) {
    return {
      category: 'status_change',
      summary: `Status: ${oldStatus ? oldStatus[0] : '(none)'} \u2192 ${newStatus[0]}`,
      isSignificant: true,
    }
  }

  // Check element state (text appeared/disappeared significantly)
  if (oldNorm.length < 5 && newNorm.length > 20) {
    return { category: 'element_state', summary: 'Content appeared', isSignificant: true }
  }
  if (oldNorm.length > 20 && newNorm.length < 5) {
    return { category: 'element_state', summary: 'Content disappeared', isSignificant: true }
  }

  // High similarity = cosmetic
  const sim = similarity(oldNorm, newNorm)
  if (sim > 0.9) {
    return { category: 'cosmetic', summary: 'Minor text variation', isSignificant: false }
  }

  // Default: meaningful content update
  const preview = newValue.trim().slice(0, 60)
  return {
    category: 'content_update',
    summary: `Content changed: "${preview}${newValue.length > 60 ? '...' : ''}"`,
    isSignificant: true,
  }
}
