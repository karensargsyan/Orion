/**
 * CDP Session Manager — keeps the Chrome DevTools Protocol debugger attached
 * for the duration of an automation sequence instead of attach/detach per call.
 *
 * This eliminates ~100ms attach overhead per action and prevents UI banner flicker.
 */

const CDP_VERSION = '1.3'

/** Domains enabled on session start — kept alive for the session lifetime. */
const REQUIRED_DOMAINS = ['DOM', 'Accessibility', 'Page', 'Input'] as const

/** Auto-release after 5 minutes of inactivity. */
const SESSION_TIMEOUT_MS = 5 * 60_000

export interface CDPSession {
  tabId: number
  createdAt: number
  lastUsed: number
}

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<number, CDPSession>()
const sessionTimers = new Map<number, ReturnType<typeof setTimeout>>()

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Attach debugger and enable required domains. Returns session or null. */
export async function acquireSession(tabId: number): Promise<CDPSession | null> {
  // Re-use existing session
  const existing = activeSessions.get(tabId)
  if (existing) {
    existing.lastUsed = Date.now()
    resetTimer(tabId)
    return existing
  }

  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION)
  } catch {
    // May already be attached by another caller or restricted page
    return null
  }

  // Enable all required domains
  for (const domain of REQUIRED_DOMAINS) {
    try {
      await chrome.debugger.sendCommand.call(chrome.debugger, { tabId }, `${domain}.enable`)
    } catch {
      // Some domains may fail on restricted pages — continue anyway
    }
  }

  // Get initial document (required for DOM queries)
  try {
    await chrome.debugger.sendCommand.call(chrome.debugger, { tabId }, 'DOM.getDocument', { depth: 0 })
  } catch { /* ok */ }

  const session: CDPSession = {
    tabId,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  }
  activeSessions.set(tabId, session)
  resetTimer(tabId)
  return session
}

/** Detach debugger and clean up. */
export async function releaseSession(tabId: number): Promise<void> {
  clearSessionTimer(tabId)
  activeSessions.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch { /* already detached */ }
}

/** Is a CDP session currently active for this tab? */
export function isSessionActive(tabId: number): boolean {
  return activeSessions.has(tabId)
}

/** Send a CDP command. Throws on failure. */
export async function cdpSend<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const session = activeSessions.get(tabId)
  if (session) session.lastUsed = Date.now()
  // Must use .call() to preserve `this` binding — without it,
  // chrome.debugger.sendCommand throws "Illegal invocation" for
  // certain CDP methods like Input.insertText and Input.dispatchKeyEvent.
  return chrome.debugger.sendCommand.call(
    chrome.debugger,
    { tabId },
    method,
    params ?? {},
  ) as unknown as Promise<T>
}

/**
 * Convenience wrapper: acquire session, run fn, release on completion.
 * Returns null if session cannot be acquired.
 */
export async function withCDP<T>(
  tabId: number,
  fn: (session: CDPSession) => Promise<T>,
): Promise<T | null> {
  const session = await acquireSession(tabId)
  if (!session) return null
  try {
    return await fn(session)
  } finally {
    await releaseSession(tabId)
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function resetTimer(tabId: number): void {
  clearSessionTimer(tabId)
  sessionTimers.set(tabId, setTimeout(() => {
    releaseSession(tabId).catch(() => {})
  }, SESSION_TIMEOUT_MS))
}

function clearSessionTimer(tabId: number): void {
  const timer = sessionTimers.get(tabId)
  if (timer) {
    clearTimeout(timer)
    sessionTimers.delete(tabId)
  }
}

// Auto-cleanup on debugger detach (user closed DevTools, tab crashed, etc.)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    clearSessionTimer(source.tabId)
    activeSessions.delete(source.tabId)
  }
})

// Auto-cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  clearSessionTimer(tabId)
  activeSessions.delete(tabId)
})
