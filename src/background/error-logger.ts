/**
 * Structured error logger — circular buffer of recent errors for debugging.
 * Replaces bare `catch {}` blocks across the codebase with observable error tracking.
 */

export interface LoggedError {
  timestamp: number
  module: string
  message: string
  stack?: string
}

const MAX_ERRORS = 200
const errorBuffer: LoggedError[] = []

/** Log an error to the circular buffer. */
export function logError(module: string, error: unknown): void {
  const entry: LoggedError = {
    timestamp: Date.now(),
    module,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
  }

  if (errorBuffer.length >= MAX_ERRORS) {
    errorBuffer.shift()
  }
  errorBuffer.push(entry)

  // Also log to console for dev visibility
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
}

/** Format errors as a debug string for copy-to-clipboard. */
export function formatDebugInfo(): string {
  const errors = getRecentErrors(50)
  const lines = errors.map(e => {
    const ts = new Date(e.timestamp).toISOString()
    return `[${ts}] ${e.module}: ${e.message}${e.stack ? '\n  ' + e.stack.split('\n').slice(0, 3).join('\n  ') : ''}`
  })
  return [
    `Orion Debug Report — ${new Date().toISOString()}`,
    `Errors in buffer: ${errorBuffer.length}/${MAX_ERRORS}`,
    `---`,
    ...lines,
  ].join('\n')
}
