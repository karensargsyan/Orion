/**
 * Structured debug logger — circular buffers for errors, actions, tab events,
 * and AI rounds. Provides a comprehensive debug report for troubleshooting.
 */

export interface LoggedError {
  timestamp: number
  module: string
  message: string
  stack?: string
}

export interface LoggedAction {
  timestamp: number
  round: number
  action: string
  params: string
  success: boolean
  result: string
  tabId: number
}

export interface LoggedTabEvent {
  timestamp: number
  event: 'created' | 'closed' | 'navigated' | 'duplicate_blocked' | 'auto_closed' | 'limit_evicted'
  tabId: number
  url: string
  source: string  // 'research' | 'workflow' | 'telegram' | 'navigate' | 'click_popup' | 'user'
}

export interface LoggedAIRound {
  timestamp: number
  round: number
  maxRounds: number
  tabId: number
  actionCount: number
  actions: string
  allSucceeded: boolean
  intent?: string
}

const MAX_ERRORS = 200
const MAX_ACTIONS = 100
const MAX_TAB_EVENTS = 100
const MAX_AI_ROUNDS = 50

const errorBuffer: LoggedError[] = []
const actionBuffer: LoggedAction[] = []
const tabEventBuffer: LoggedTabEvent[] = []
const aiRoundBuffer: LoggedAIRound[] = []

// ─── Error logging ──────────────────────────────────────────────────────────

/** Log an error to the circular buffer. */
export function logError(module: string, error: unknown): void {
  const entry: LoggedError = {
    timestamp: Date.now(),
    module,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
  }

  if (errorBuffer.length >= MAX_ERRORS) errorBuffer.shift()
  errorBuffer.push(entry)

  console.warn(`[Orion:${module}]`, entry.message)
}

/** Get recent errors (newest first). */
export function getRecentErrors(limit = 50): LoggedError[] {
  return errorBuffer.slice(-limit).reverse()
}

/** Get error count. */
export function getErrorCount(): number {
  return errorBuffer.length
}

/** Clear error buffer. */
export function clearErrors(): void {
  errorBuffer.length = 0
  actionBuffer.length = 0
  tabEventBuffer.length = 0
  aiRoundBuffer.length = 0
}

// ─── Action logging ─────────────────────────────────────────────────────────

/** Log an executed action for debug visibility. */
export function logAction(entry: Omit<LoggedAction, 'timestamp'>): void {
  if (actionBuffer.length >= MAX_ACTIONS) actionBuffer.shift()
  actionBuffer.push({ ...entry, timestamp: Date.now() })
}

export function getRecentActions(limit = 50): LoggedAction[] {
  return actionBuffer.slice(-limit).reverse()
}

// ─── Tab event logging ──────────────────────────────────────────────────────

/** Log a tab lifecycle event. */
export function logTabEvent(
  event: LoggedTabEvent['event'],
  tabId: number,
  url: string,
  source: LoggedTabEvent['source'],
): void {
  if (tabEventBuffer.length >= MAX_TAB_EVENTS) tabEventBuffer.shift()
  tabEventBuffer.push({ timestamp: Date.now(), event, tabId, url, source })
}

export function getRecentTabEvents(limit = 50): LoggedTabEvent[] {
  return tabEventBuffer.slice(-limit).reverse()
}

// ─── AI round logging ───────────────────────────────────────────────────────

/** Log an AI execution round. */
export function logAIRound(entry: Omit<LoggedAIRound, 'timestamp'>): void {
  if (aiRoundBuffer.length >= MAX_AI_ROUNDS) aiRoundBuffer.shift()
  aiRoundBuffer.push({ ...entry, timestamp: Date.now() })
}

export function getRecentAIRounds(limit = 20): LoggedAIRound[] {
  return aiRoundBuffer.slice(-limit).reverse()
}

// ─── Debug report ───────────────────────────────────────────────────────────

/** Format a comprehensive debug report for copy-to-clipboard. */
export function formatDebugInfo(): string {
  const sections: string[] = []

  sections.push(`Orion Debug Report — ${new Date().toISOString()}`)
  sections.push(`Errors: ${errorBuffer.length}/${MAX_ERRORS} | Actions: ${actionBuffer.length}/${MAX_ACTIONS} | Tab events: ${tabEventBuffer.length}/${MAX_TAB_EVENTS} | AI rounds: ${aiRoundBuffer.length}/${MAX_AI_ROUNDS}`)
  sections.push('---')

  // AI Rounds (most recent first)
  const rounds = getRecentAIRounds(15)
  if (rounds.length > 0) {
    sections.push('')
    sections.push('## AI Rounds (recent)')
    for (const r of rounds) {
      const ts = new Date(r.timestamp).toISOString().slice(11, 19)
      sections.push(`[${ts}] Round ${r.round}/${r.maxRounds} tab=${r.tabId} actions=${r.actionCount} ${r.allSucceeded ? 'OK' : 'FAILED'}: ${r.actions}${r.intent ? ` (intent: ${r.intent})` : ''}`)
    }
  }

  // Tab Events (most recent first)
  const tabs = getRecentTabEvents(30)
  if (tabs.length > 0) {
    sections.push('')
    sections.push('## Tab Events (recent)')
    for (const t of tabs) {
      const ts = new Date(t.timestamp).toISOString().slice(11, 19)
      sections.push(`[${ts}] ${t.event.toUpperCase()} tab=${t.tabId} src=${t.source} url=${t.url.slice(0, 80)}`)
    }
  }

  // Actions (most recent first)
  const actions = getRecentActions(30)
  if (actions.length > 0) {
    sections.push('')
    sections.push('## Actions (recent)')
    for (const a of actions) {
      const ts = new Date(a.timestamp).toISOString().slice(11, 19)
      const resultSnippet = a.result.slice(0, 100).replace(/\n/g, ' ')
      sections.push(`[${ts}] R${a.round} tab=${a.tabId} ${a.action}(${a.params}) ${a.success ? 'OK' : 'FAIL'}: ${resultSnippet}`)
    }
  }

  // Errors (most recent first)
  const errors = getRecentErrors(20)
  if (errors.length > 0) {
    sections.push('')
    sections.push('## Errors (recent)')
    for (const e of errors) {
      const ts = new Date(e.timestamp).toISOString().slice(11, 19)
      sections.push(`[${ts}] ${e.module}: ${e.message}${e.stack ? '\n  ' + e.stack.split('\n').slice(0, 2).join('\n  ') : ''}`)
    }
  }

  if (errorBuffer.length === 0 && actionBuffer.length === 0 && tabEventBuffer.length === 0 && aiRoundBuffer.length === 0) {
    sections.push('\n(No events recorded yet — interact with the extension first)')
  }

  return sections.join('\n')
}
