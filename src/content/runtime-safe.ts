/**
 * After an extension reload/update, injected content scripts keep running but
 * `chrome.runtime` is invalid; `sendMessage` throws synchronously.
 * `.catch()` on the returned promise does not catch that throw.
 */

export function safeSendMessage(message: object): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    /* extension context invalidated */
  }
}

export async function safeSendMessageAsync<T = unknown>(message: object): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T
  } catch {
    return null
  }
}
