import { MSG, STORE } from '../shared/constants'
import { getRecentEvents } from './action-recorder'
import { dbPut } from '../shared/idb'
import type {
  SupervisedSession, SupervisedInteraction, LearningSnapshot, UserActionEvent,
} from '../shared/types'

let activeSession: SupervisedSession | null = null
let snapshotIntervalId: ReturnType<typeof setInterval> | null = null
let currentInteraction: SupervisedInteraction | null = null
let bufferedActions: UserActionEvent[] = []

const MAX_SNAPSHOTS_PER_INTERACTION = 60
const SNAPSHOT_INTERVAL_MS = 1500
const MAX_BUFFERED_ACTIONS = 200

// ─── Public API ──────────────────────────────────────────────────────────────

export function isSupervisedActive(): boolean {
  return activeSession !== null
}

export function getActiveSupervisedSession(): SupervisedSession | null {
  return activeSession
}

export function getCurrentInteraction(): SupervisedInteraction | null {
  return currentInteraction
}

export function getSupervisedActionCount(): number {
  const completed = activeSession?.interactions.reduce((sum, interaction) => sum + interaction.actions.length, 0) ?? 0
  const current = currentInteraction?.actions.length ?? 0
  return completed + current + bufferedActions.length
}

export async function startSupervisedSession(tabId: number): Promise<SupervisedSession> {
  if (activeSession) await stopSupervisedSession()

  bufferedActions = []
  const domain = await resolveTabDomain(tabId)

  activeSession = {
    id: `supervised_${Date.now()}`,
    startedAt: Date.now(),
    tabId,
    domain,
    interactions: [],
  }

  startSnapshotTimer()

  return activeSession
}

export async function stopSupervisedSession(): Promise<SupervisedSession | null> {
  if (!activeSession) return null

  if (currentInteraction) {
    finalizeCurrentInteraction()
  } else if (bufferedActions.length > 0) {
    currentInteraction = {
      command: '(observed actions)',
      actions: [...bufferedActions],
      snapshots: [],
      startedAt: activeSession.startedAt,
    }
    finalizeCurrentInteraction()
  }

  clearSnapshotTimer()
  bufferedActions = []
  activeSession.endedAt = Date.now()
  const session = { ...activeSession, interactions: [...activeSession.interactions] }

  await dbPut<SupervisedSession>(STORE.SUPERVISED_SESSIONS, session)
  activeSession = null
  return session
}

export function beginInteraction(command: string): void {
  if (!activeSession) return

  if (currentInteraction) {
    finalizeCurrentInteraction()
  }

  currentInteraction = {
    command,
    actions: [...bufferedActions],
    snapshots: [],
    startedAt: Date.now(),
  }
  bufferedActions = []
}

export function addVoiceSegment(transcript: string): void {
  if (!currentInteraction) return
  currentInteraction.command += (currentInteraction.command ? ' ' : '') + transcript
}

export async function completeInteraction(): Promise<SupervisedInteraction | null> {
  if (!activeSession || !currentInteraction) return null

  clearSnapshotTimer()
  await captureSnapshot(activeSession.tabId)

  finalizeCurrentInteraction()
  startSnapshotTimer()
  return activeSession.interactions[activeSession.interactions.length - 1] ?? null
}

export function feedUserEvent(event: UserActionEvent): void {
  if (!activeSession) return

  if (currentInteraction) {
    currentInteraction.actions.push(event)
  } else {
    if (bufferedActions.length >= MAX_BUFFERED_ACTIONS) {
      bufferedActions.shift()
    }
    bufferedActions.push(event)
  }
}

// ─── Snapshot Capture ────────────────────────────────────────────────────────

function startSnapshotTimer(): void {
  clearSnapshotTimer()
  if (!activeSession) return

  captureSnapshot(activeSession.tabId).catch(() => {})

  snapshotIntervalId = setInterval(() => {
    if (!activeSession) return
    captureSnapshot(activeSession.tabId).catch(() => {})
  }, SNAPSHOT_INTERVAL_MS)
}

function clearSnapshotTimer(): void {
  if (snapshotIntervalId !== null) {
    clearInterval(snapshotIntervalId)
    snapshotIntervalId = null
  }
}

async function captureSnapshot(tabId: number): Promise<void> {
  if (!activeSession) return

  const targetInteraction = currentInteraction
  const snapshotList = targetInteraction?.snapshots

  if (snapshotList && snapshotList.length >= MAX_SNAPSHOTS_PER_INTERACTION) return

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

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    url = tab?.url ?? ''
    pageTitle = tab?.title ?? ''
  } catch { /* no active tab */ }

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

  if (targetInteraction) {
    targetInteraction.snapshots.push(snapshot)
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

function finalizeCurrentInteraction(): void {
  if (!activeSession || !currentInteraction) return

  currentInteraction.endedAt = Date.now()
  activeSession.interactions.push({ ...currentInteraction })
  currentInteraction = null
}

async function resolveTabDomain(_tabId: number): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return extractDomain(tab?.url ?? '')
  } catch {
    return ''
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
