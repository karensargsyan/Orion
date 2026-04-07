/**
 * Action Monitor — captures user interactions and sends to service worker.
 */

import { MSG } from '../shared/constants'
import type { UserActionEvent, ActionType } from '../shared/types'
import { getUniqueSelector } from './dom-analyzer'

let lastUrl = location.href

function isSensitive(el: HTMLElement): boolean {
  const input = el as HTMLInputElement
  return input.type === 'password' || input.autocomplete === 'current-password' ||
    input.autocomplete === 'new-password'
}

function getElementText(el: HTMLElement): string {
  return (el.textContent?.trim() || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').slice(0, 80)
}

let sendTimeout: ReturnType<typeof setTimeout> | null = null
const pendingActions: UserActionEvent[] = []

function queueAction(event: UserActionEvent): void {
  pendingActions.push(event)
  if (sendTimeout) return
  sendTimeout = setTimeout(() => {
    sendTimeout = null
    const batch = [...pendingActions]
    pendingActions.length = 0
    for (const e of batch) {
      chrome.runtime.sendMessage({ type: MSG.USER_ACTION, event: e }).catch(() => {})
    }
  }, 100)
}

function makeEvent(type: ActionType, el: HTMLElement, extra?: Partial<UserActionEvent>): UserActionEvent {
  return {
    type,
    selector: getUniqueSelector(el),
    tagName: el.tagName.toLowerCase(),
    url: location.href,
    timestamp: Date.now(),
    ...extra,
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onClickCapture(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest('a, button, [role="button"], input[type="submit"]') as HTMLElement | null
  if (!el) return
  queueAction(makeEvent('click', el, { text: getElementText(el) }))
}

let inputDebounce: ReturnType<typeof setTimeout> | null = null
function onInputCapture(e: Event): void {
  const el = e.target as HTMLInputElement
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) return
  if (inputDebounce) clearTimeout(inputDebounce)
  inputDebounce = setTimeout(() => {
    const value = isSensitive(el) ? '[redacted]' : el.value?.slice(0, 100) ?? ''
    queueAction(makeEvent('input', el, { value }))
  }, 800)
}

function onSubmitCapture(e: Event): void {
  const form = e.target as HTMLFormElement
  queueAction(makeEvent('submit', form))
}

function onFocusCapture(e: FocusEvent): void {
  const el = e.target as HTMLElement
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') return
  queueAction(makeEvent('focus', el, { text: (el as HTMLInputElement).placeholder?.slice(0, 60) }))
}

// ─── URL change detection ─────────────────────────────────────────────────────

function checkUrlChange(): void {
  if (location.href !== lastUrl) {
    lastUrl = location.href
    queueAction({
      type: 'navigate',
      selector: 'window',
      tagName: 'window',
      url: location.href,
      timestamp: Date.now(),
    })
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

export function setupActionMonitor(): void {
  document.addEventListener('click', onClickCapture, true)
  document.addEventListener('input', onInputCapture, true)
  document.addEventListener('submit', onSubmitCapture, true)
  document.addEventListener('focusin', onFocusCapture, true)

  // Poll for SPA navigation (history API changes)
  setInterval(checkUrlChange, 1000)
}
