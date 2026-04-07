import { MSG } from '../shared/constants'
import type { FillAssignment, AIAction, PageSnapshot, FieldOption } from '../shared/types'
import { buildSnapshot, snapshotChanged } from './dom-analyzer'
import { fillAssignments, highlightFilledFields, fillField } from './form-filler'
import { setupActionMonitor } from './action-monitor'
import { extractPageText, extractVisibleText, extractSelectedText, extractEmailContent, extractChatContent, isEmailPage, isChatPage } from './page-extractor'
import { setupTextMonitor } from './text-monitor'
import { findLabel, getUniqueSelector } from './dom-analyzer'

// ─── State ────────────────────────────────────────────────────────────────────

let lastSnapshot = buildSnapshot()
let lastPageTextHash = ''
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let userIsInteracting = false
let userIdleTimer: ReturnType<typeof setTimeout> | null = null

const USER_IDLE_TIMEOUT = 2000
const INTERACTION_DEBOUNCE = 200

// ─── User interaction tracking ────────────────────────────────────────────────

function markUserActive(): void {
  userIsInteracting = true
  if (userIdleTimer) clearTimeout(userIdleTimer)
  userIdleTimer = setTimeout(() => { userIsInteracting = false }, USER_IDLE_TIMEOUT)
}

document.addEventListener('mousedown', markUserActive, true)
document.addEventListener('keydown', markUserActive, true)
document.addEventListener('pointerdown', markUserActive, true)

// ─── DOM Observation ──────────────────────────────────────────────────────────

function sendSnapshot(): void {
  const snap = buildSnapshot()
  if (snapshotChanged(lastSnapshot, snap)) {
    lastSnapshot = snap
    chrome.runtime.sendMessage({ type: MSG.PAGE_SNAPSHOT, payload: snap }).catch(() => {})
  }
}

function debouncedSnapshot(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(sendSnapshot, INTERACTION_DEBOUNCE)
}

const observer = new MutationObserver(debouncedSnapshot)

observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['type', 'disabled', 'hidden', 'aria-hidden', 'style', 'class', 'value', 'checked', 'selected'],
})

// ─── Continuous value-change listeners ────────────────────────────────────────

document.addEventListener('input', debouncedSnapshot, true)
document.addEventListener('change', debouncedSnapshot, true)
document.addEventListener('click', debouncedSnapshot, true)

// ─── Periodic page text extraction ────────────────────────────────────────────

function sendPageText(): void {
  const pageText = extractPageText()
  const visibleText = extractVisibleText()

  const hash = simpleHash(pageText)
  if (hash === lastPageTextHash) return
  lastPageTextHash = hash

  const payload: Record<string, string> = { type: MSG.PAGE_TEXT, pageText, visibleText }

  const emailContent = extractEmailContent()
  if (emailContent) payload.emailContent = emailContent

  const chatContent = extractChatContent()
  if (chatContent) payload.chatContent = chatContent

  payload.isEmail = String(isEmailPage())
  payload.isChat = String(isChatPage())

  chrome.runtime.sendMessage(payload).catch(() => {})
}

setInterval(sendPageText, 5000)

// ─── Selection monitoring ─────────────────────────────────────────────────────

let lastSelection = ''
document.addEventListener('selectionchange', () => {
  const text = extractSelectedText()
  if (text && text !== lastSelection && text.length > 3) {
    lastSelection = text
    chrome.runtime.sendMessage({ type: MSG.TEXT_SELECTED, text }).catch(() => {})
  }
})

// ─── Message handler (SW -> Content) ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
  handleContentMessage(msg).then(sendResponse).catch((err: Error) => sendResponse({ ok: false, error: err.message }))
  return true
})

async function handleContentMessage(msg: Record<string, unknown>): Promise<unknown> {
  switch (msg.type) {
    case MSG.PING:
      return { ok: true }

    case MSG.DO_FILL: {
      const assignments = msg.assignments as FillAssignment[]
      const result = await fillAssignments(assignments)
      highlightFilledFields(assignments.map(a => a.selector))
      return { ok: true, ...result }
    }

    case MSG.REQUEST_SNAPSHOT: {
      sendSnapshot()
      return { ok: true }
    }

    case MSG.REQUEST_FRESH_SNAPSHOT: {
      const snap = buildSnapshot()
      lastSnapshot = snap
      return { ok: true, snapshot: snap }
    }

    case MSG.REQUEST_PAGE_TEXT: {
      return { ok: true, pageText: extractPageText(), visibleText: extractVisibleText() }
    }

    case MSG.HIGHLIGHT_FIELD: {
      const el = document.querySelector<HTMLElement>(msg.selector as string)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.focus()
      }
      return { ok: !!el }
    }

    case MSG.EXECUTE_ACTION: {
      const action = msg.action as AIAction
      if (userIsInteracting) {
        return { ok: false, error: 'USER_ACTIVE', userActive: true }
      }
      const result = await executeAction(action)
      const freshSnap = buildSnapshot()
      lastSnapshot = freshSnap
      return { ...result, userActive: userIsInteracting, snapshot: freshSnap }
    }

    default:
      return { ok: false, error: 'Unknown message' }
  }
}

// ─── Action execution ─────────────────────────────────────────────────────────

async function executeAction(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    switch (action.action) {
      case 'click':
        return await handleClick(action)
      case 'type':
        return await handleType(action)
      case 'scroll':
        return handleScroll(action)
      case 'navigate':
        return handleNavigate(action)
      case 'read':
        return handleRead(action)
      case 'select':
        return handleHighlightSelect(action)
      case 'fill_form':
        return await handleFillForm(action)
      case 'select_option':
        return await handleSelectOption(action)
      case 'check':
        return await handleCheck(action)
      case 'clear':
        return await handleClear(action)
      case 'read_options':
        return handleReadOptions(action)
      case 'get_page_state':
        return { ok: true, result: 'Page state returned in snapshot' }
      default:
        return { ok: false, error: `Unknown action: ${action.action}` }
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

async function handleClick(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = document.querySelector<HTMLElement>(action.selector!)
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(300)
  el.click()
  return { ok: true, result: `Clicked: ${el.textContent?.trim().slice(0, 50)}` }
}

async function handleType(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = document.querySelector<HTMLElement>(action.selector!)
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  const inputType = (el as HTMLInputElement).type || el.tagName.toLowerCase()
  const ok = await fillField(el, action.value ?? '', inputType)
  if (!ok) return { ok: false, error: `Could not fill field: ${action.selector}` }
  return { ok: true, result: `Typed into ${action.selector}` }
}

function handleScroll(action: AIAction): { ok: boolean; result?: string } {
  const amount = action.value === 'up' ? -500 : 500
  window.scrollBy({ top: amount, behavior: 'smooth' })
  return { ok: true, result: `Scrolled ${action.value}` }
}

function handleNavigate(action: AIAction): { ok: boolean; result?: string } {
  window.location.href = action.url!
  return { ok: true, result: `Navigating to ${action.url}` }
}

function handleRead(action: AIAction): { ok: boolean; result?: string; error?: string } {
  const el = document.querySelector(action.selector!)
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }
  return { ok: true, result: el.textContent?.trim().slice(0, 2000) ?? '' }
}

function handleHighlightSelect(action: AIAction): { ok: boolean; result?: string; error?: string } {
  const el = document.querySelector<HTMLElement>(action.selector!)
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.style.outline = '3px solid #7c6ef5'
  el.style.outlineOffset = '2px'
  setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = '' }, 3000)
  return { ok: true, result: `Selected: ${el.textContent?.trim().slice(0, 50)}` }
}

async function handleFillForm(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  if (!action.assignments) return { ok: false, error: 'No assignments' }
  const result = await fillAssignments(action.assignments)
  highlightFilledFields(action.assignments.map(a => a.selector))
  return { ok: true, result: `Filled ${result.filled} fields` }
}

async function handleSelectOption(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = document.querySelector<HTMLSelectElement>(action.selector!)
  if (!el || !(el instanceof HTMLSelectElement)) {
    return { ok: false, error: `Select element not found: ${action.selector}` }
  }

  const targetValue = (action.value ?? '').toLowerCase()
  const option = [...el.options].find(o =>
    o.value.toLowerCase() === targetValue || o.text.trim().toLowerCase() === targetValue
  )

  if (!option) {
    const available = [...el.options].map(o => `"${o.text.trim()}" (${o.value})`).slice(0, 10).join(', ')
    return { ok: false, error: `Option "${action.value}" not found. Available: ${available}` }
  }

  el.value = option.value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true, result: `Selected option "${option.text.trim()}" in ${action.selector}` }
}

async function handleCheck(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = document.querySelector<HTMLInputElement>(action.selector!)
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  if (el.type !== 'checkbox' && el.type !== 'radio') {
    return { ok: false, error: `Element is not a checkbox or radio: ${action.selector} (type: ${el.type})` }
  }

  const shouldCheck = action.value?.toLowerCase() !== 'false'
  el.checked = shouldCheck
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('click', { bubbles: true }))
  return { ok: true, result: `${shouldCheck ? 'Checked' : 'Unchecked'} ${action.selector}` }
}

async function handleClear(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = document.querySelector<HTMLElement>(action.selector!)
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }
  const ok = await fillField(el, '', (el as HTMLInputElement).type || 'text')
  return { ok, result: ok ? `Cleared ${action.selector}` : `Could not clear ${action.selector}` }
}

function handleReadOptions(action: AIAction): { ok: boolean; result?: string; error?: string } {
  const el = document.querySelector<HTMLElement>(action.selector!)
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  if (el instanceof HTMLSelectElement) {
    const options: FieldOption[] = [...el.options].map(o => ({
      value: o.value,
      label: o.text.trim(),
      selected: o.selected,
    }))
    return { ok: true, result: JSON.stringify(options) }
  }

  const input = el as HTMLInputElement
  if (input.type === 'radio' || input.type === 'checkbox') {
    if (!input.name) return { ok: true, result: '[]' }
    const group = document.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(input.name)}"]`)
    const options: FieldOption[] = [...group].map(g => ({
      value: g.value,
      label: findLabel(g) || g.value,
      selected: g.checked,
    }))
    return { ok: true, result: JSON.stringify(options) }
  }

  return { ok: false, error: `Element is not a select, radio, or checkbox: ${action.selector}` }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(): void {
  sendSnapshot()
  sendPageText()
  setupActionMonitor()
  setupTextMonitor()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return String(hash)
}
