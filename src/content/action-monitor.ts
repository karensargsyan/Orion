/**
 * Action Monitor — captures user interactions (clicks, typing, pointer, wheel,
 * scroll, navigation keys) and sends them to the service worker. High-frequency
 * events are throttled to avoid flooding the extension or local model.
 */

import { MSG } from '../shared/constants'
import type { UserActionEvent, ActionType } from '../shared/types'
import { getUniqueSelector } from './dom-analyzer'
import { safeSendMessage } from './runtime-safe'

const CLICK_SELECTORS =
  'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
  'input[type="submit"], input[type="button"], input[type="reset"], input[type="checkbox"], input[type="radio"], ' +
  'label, summary, [data-action], [data-click], [onclick]'

let lastUrl = location.href

function isSensitive(el: HTMLElement): boolean {
  const input = el as HTMLInputElement
  return (
    input.type === 'password' ||
    input.autocomplete === 'current-password' ||
    input.autocomplete === 'new-password'
  )
}

function getElementText(el: HTMLElement): string {
  return (
    el.textContent?.trim() ||
    (el as HTMLInputElement).value ||
    el.getAttribute('aria-label') ||
    ''
  ).slice(0, 80)
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
      safeSendMessage({ type: MSG.USER_ACTION, event: e })
    }
  }, 100)
}

function makeEvent(type: ActionType, el: Element, extra?: Partial<UserActionEvent>): UserActionEvent {
  return {
    type,
    selector: getUniqueSelector(el),
    tagName: el.tagName.toLowerCase(),
    url: location.href,
    timestamp: Date.now(),
    ...extra,
  }
}

function elementFromClientSafe(x: number, y: number): Element {
  return document.elementFromPoint(x, y) ?? document.body
}

// ─── Click / form ─────────────────────────────────────────────────────────────

function onClickCapture(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest(CLICK_SELECTORS) as HTMLElement | null
  if (!el) return
  queueAction(makeEvent('click', el, { text: getElementText(el) }))
}

/** Per-field debounce map to avoid cancelling inputs across different fields */
const inputDebouncers = new Map<string, ReturnType<typeof setTimeout>>()

function onInputCapture(e: Event): void {
  const el = e.target as HTMLInputElement
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) return

  const fieldKey = getUniqueSelector(el)
  const prev = inputDebouncers.get(fieldKey)
  if (prev) clearTimeout(prev)

  inputDebouncers.set(fieldKey, setTimeout(() => {
    inputDebouncers.delete(fieldKey)
    // Send actual values — background handles encryption for sensitive fields
    const value = el.value?.slice(0, 500) ?? ''
    const inputType = el.type ?? (el.isContentEditable ? 'contenteditable' : 'textarea')
    const fieldLabel = extractFieldLabel(el)
    queueAction(makeEvent('input', el, {
      value,
      inputType,
      fieldLabel: fieldLabel || undefined,
      detail: [
        (el as HTMLInputElement).name || '',
        (el as HTMLInputElement).autocomplete || '',
      ].filter(Boolean).join('|') || undefined,
    }))
  }, 800))
}

/** Extract a human-readable label for a form field */
function extractFieldLabel(el: HTMLElement): string {
  // 1. Check for associated <label> element
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (label?.textContent?.trim()) return label.textContent.trim().slice(0, 60)
    }
    // Check parent <label>
    const parentLabel = el.closest('label')
    if (parentLabel?.textContent?.trim()) {
      const labelText = parentLabel.textContent.replace(el.value ?? '', '').trim()
      if (labelText) return labelText.slice(0, 60)
    }
  }
  // 2. aria-label
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel?.trim()) return ariaLabel.trim().slice(0, 60)
  // 3. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const referenced = document.getElementById(labelledBy)
    if (referenced?.textContent?.trim()) return referenced.textContent.trim().slice(0, 60)
  }
  // 4. placeholder
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder?.trim()) return el.placeholder.trim().slice(0, 60)
  }
  // 5. title attribute
  const title = el.getAttribute('title')
  if (title?.trim()) return title.trim().slice(0, 60)
  // 6. name or id attribute (last resort)
  const name = el.getAttribute('name') ?? el.id ?? ''
  if (name) {
    // Convert camelCase/snake_case to human readable: firstName -> First Name
    return name.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60)
  }
  return ''
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

// ─── Pointer / move / wheel / scroll (throttled) ───────────────────────────────

const MOVE_THROTTLE_MS = 420
const MOVE_MIN_DIST = 36
const POINTER_THROTTLE_MS = 320
const WHEEL_THROTTLE_MS = 480
const SCROLL_THROTTLE_MS = 450
const KEY_NAV_THROTTLE_MS = 380

let lastMoveAt = 0
let lastMoveX = 0
let lastMoveY = 0
let lastMoveSel = ''

function onPointerMoveCapture(e: PointerEvent): void {
  const now = Date.now()
  if (now - lastMoveAt < MOVE_THROTTLE_MS) return
  const dx = e.clientX - lastMoveX
  const dy = e.clientY - lastMoveY
  if (lastMoveAt > 0 && dx * dx + dy * dy < MOVE_MIN_DIST * MOVE_MIN_DIST) return

  const el = elementFromClientSafe(e.clientX, e.clientY)
  const sel = getUniqueSelector(el)
  if (sel === lastMoveSel && now - lastMoveAt < MOVE_THROTTLE_MS * 2) return

  lastMoveAt = now
  lastMoveX = e.clientX
  lastMoveY = e.clientY
  lastMoveSel = sel

  queueAction(
    makeEvent('move', el, {
      detail: `${Math.round(e.clientX)},${Math.round(e.clientY)}`,
      text: getElementText(el as HTMLElement).slice(0, 40) || undefined,
    })
  )
}

let lastPointerAt = 0
let lastPointerSel = ''

function onPointerDownCapture(e: PointerEvent): void {
  const now = Date.now()
  const el = (e.target as HTMLElement).closest(CLICK_SELECTORS) ?? (e.target as Element)
  const sel = getUniqueSelector(el)
  if (now - lastPointerAt < POINTER_THROTTLE_MS && sel === lastPointerSel) return
  lastPointerAt = now
  lastPointerSel = sel
  queueAction(
    makeEvent('pointer', el, {
      detail: `${e.pointerType}:${Math.round(e.clientX)},${Math.round(e.clientY)}`,
    })
  )
}

let lastWheelAt = 0
let lastWheelSel = ''

function onWheelCapture(e: WheelEvent): void {
  const now = Date.now()
  const el = e.target as Element
  const sel = getUniqueSelector(el)
  if (now - lastWheelAt < WHEEL_THROTTLE_MS && sel === lastWheelSel) return
  lastWheelAt = now
  lastWheelSel = sel
  const dir = e.deltaY > 0 ? 'down' : e.deltaY < 0 ? 'up' : 'none'
  queueAction(makeEvent('wheel', el, { detail: `${dir}|${Math.round(Math.abs(e.deltaY))}` }))
}

let lastScrollAt = 0
let lastScrollY = -1

function onWindowScroll(): void {
  const now = Date.now()
  const y = window.scrollY
  if (now - lastScrollAt < SCROLL_THROTTLE_MS && Math.abs(y - lastScrollY) < 80) return
  lastScrollAt = now
  lastScrollY = y
  const el = document.scrollingElement ?? document.documentElement
  queueAction(makeEvent('scroll', el, { detail: `y=${Math.round(y)}` }))
}

const NAV_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const lastKeyAtByField = new Map<string, number>()

function onKeyDownCapture(e: KeyboardEvent): void {
  if (!NAV_KEYS.has(e.key)) return
  const t = e.target as HTMLElement
  if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && !t.isContentEditable) return
  if (isSensitive(t as HTMLInputElement)) return

  const fieldKey = getUniqueSelector(t)
  const now = Date.now()
  const prev = lastKeyAtByField.get(fieldKey) ?? 0
  if (now - prev < KEY_NAV_THROTTLE_MS) return
  lastKeyAtByField.set(fieldKey, now)
  if (lastKeyAtByField.size > 80) {
    const oldest = [...lastKeyAtByField.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) lastKeyAtByField.delete(oldest[0])
  }

  queueAction(makeEvent('keydown', t, { detail: e.key }))
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

  document.addEventListener('pointermove', onPointerMoveCapture, true)
  document.addEventListener('pointerdown', onPointerDownCapture, true)
  document.addEventListener('wheel', onWheelCapture, { capture: true, passive: true })
  document.addEventListener('keydown', onKeyDownCapture, true)

  window.addEventListener('scroll', onWindowScroll, { passive: true })

  setInterval(checkUrlChange, 1000)
}
