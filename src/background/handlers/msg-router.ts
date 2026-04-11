/**
 * Message Router — thin dispatch layer for chrome.runtime.onMessage handlers.
 * Modules register handlers via `registerHandler()`, and `routeMessage()`
 * dispatches to the correct handler. Returns undefined if no handler matched.
 *
 * This enables the service worker to be decomposed into feature modules
 * while keeping a single message listener.
 */

export type MessageHandler = (
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
) => Promise<unknown> | unknown

const handlers = new Map<string, MessageHandler>()

/** Register a handler for a specific message type. */
export function registerHandler(type: string, handler: MessageHandler): void {
  if (handlers.has(type)) {
    console.warn(`[MsgRouter] Handler for "${type}" is being overwritten`)
  }
  handlers.set(type, handler)
}

/** Register multiple handlers at once. */
export function registerHandlers(map: Record<string, MessageHandler>): void {
  for (const [type, handler] of Object.entries(map)) {
    registerHandler(type, handler)
  }
}

/**
 * Route a message to its registered handler.
 * Returns the handler's response, or undefined if no handler matched.
 */
export async function routeMessage(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<unknown | undefined> {
  const type = msg.type as string
  if (!type) return undefined

  const handler = handlers.get(type)
  if (!handler) return undefined

  return handler(msg, sender)
}

/** Check if a handler is registered for a given message type. */
export function hasHandler(type: string): boolean {
  return handlers.has(type)
}

/** Get count of registered handlers (for debug). */
export function getHandlerCount(): number {
  return handlers.size
}
