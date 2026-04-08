import { MSG, STORE, DEFAULTS } from '../shared/constants'
import { getRecentEvents } from './action-recorder'
import { dbPut, dbGet } from '../shared/idb'
import type { LearningSession, LearningSnapshot, Settings } from '../shared/types'

let activeSession: LearningSession | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
const MAX_SNAPSHOTS = 120

export function isLearningActive(): boolean {
  return activeSession !== null
}

export function getActiveSession(): LearningSession | null {
  return activeSession
}

export async function startLearning(tabId: number, settings: Settings): Promise<LearningSession> {
  if (activeSession) await stopLearning(settings)

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  const domain = extractDomain(url)

  activeSession = {
    id: `learn_${Date.now()}`,
    startedAt: Date.now(),
    tabId,
    domain,
    snapshots: [],
  }

  const intervalSec = settings.learningSnapshotIntervalSec ?? DEFAULTS.LEARNING_SNAPSHOT_INTERVAL_SEC
  intervalId = setInterval(() => {
    captureSnapshot(tabId).catch(() => {})
  }, intervalSec * 1000)

  await captureSnapshot(tabId)
  return activeSession
}

export async function stopLearning(_settings: Settings): Promise<LearningSession | null> {
  if (!activeSession) return null

  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }

  await captureSnapshot(activeSession.tabId)

  activeSession.endedAt = Date.now()
  const session = { ...activeSession }

  await dbPut<LearningSession>(STORE.LEARNING_SESSIONS, session)
  activeSession = null
  return session
}

async function captureSnapshot(tabId: number): Promise<void> {
  if (!activeSession) return
  if (activeSession.snapshots.length >= MAX_SNAPSHOTS) return

  let screenshot: string | undefined
  try {
    screenshot = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 40 })
  } catch { /* restricted tab */ }

  let pageTitle = ''
  let accessibilityTree = ''
  let visibleText = ''
  let url = ''

  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: MSG.INJECT_MARKERS }) as {
      ok: boolean; accessibilityTree?: string
    }
    if (result?.ok && result.accessibilityTree) {
      accessibilityTree = result.accessibilityTree
    }
    await chrome.tabs.sendMessage(tabId, { type: MSG.REMOVE_MARKERS }).catch(() => {})
  } catch { /* content script not available */ }

  try {
    const stateResult = await chrome.tabs.sendMessage(tabId, { type: MSG.REQUEST_PAGE_TEXT }) as {
      ok: boolean; pageText?: string; visibleText?: string
    }
    if (stateResult?.ok) {
      visibleText = (stateResult.visibleText ?? stateResult.pageText ?? '').slice(0, 2000)
    }
  } catch { /* content script not available */ }

  if (!url) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      url = tab?.url ?? ''
      pageTitle = tab?.title ?? ''
    } catch { /* no active tab */ }
  }

  const recentActions = getRecentEvents(tabId, 30)

  const snapshot: LearningSnapshot = {
    timestamp: Date.now(),
    url,
    domain: extractDomain(url),
    screenshot,
    pageTitle,
    accessibilityTree: accessibilityTree.slice(0, 5000),
    recentActions: recentActions.slice(-20),
    visibleText,
  }

  activeSession.snapshots.push(snapshot)

  if (activeSession.domain !== snapshot.domain && snapshot.domain) {
    activeSession.domain = snapshot.domain
  }
}

export async function getLearningSessions(limit = 10): Promise<LearningSession[]> {
  try {
    const all = await import('../shared/idb').then(m =>
      m.dbGetByIndexRange<LearningSession>(STORE.LEARNING_SESSIONS, 'by_started', IDBKeyRange.lowerBound(0), limit)
    )
    return all
  } catch {
    return []
  }
}

export async function getLearningSession(id: string): Promise<LearningSession | undefined> {
  return dbGet<LearningSession>(STORE.LEARNING_SESSIONS, id)
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
