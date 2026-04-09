import { MSG, DEFAULTS } from '../shared/constants'
import type { FillAssignment, AIAction, PageSnapshot, FieldOption } from '../shared/types'
import { buildSnapshot, snapshotChanged } from './dom-analyzer'
import { fillAssignments, highlightFilledFields, fillField } from './form-filler'
import { setupActionMonitor } from './action-monitor'
import { startCoach, type CoachField } from './form-coach'
import { extractPageText, extractVisibleText, extractCompletePageText, extractSelectedText, extractStructuredContent, extractSemanticLandmarks } from './page-extractor'
import { setupTextMonitor } from './text-monitor'
import { findLabel, getUniqueSelector } from './dom-analyzer'
import { injectMarkers, removeMarkers, buildAccessibilityTree, setLastMarkedElements, findElementByMarkerId, findElementByAIId, isControlElement, findNearbyControl, recoverStaleElement } from './element-markers'
import { applySafetyBorderMessage } from './safety-border'
import { setupComposeAssistant } from './compose-assistant'
import { analyzeFileFromUrl, findAttachmentLinks, type FileAnalysisResult } from './file-analyzer'
import { safeSendMessage } from './runtime-safe'
import { showClickEffect } from './click-effects'

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
    safeSendMessage({ type: MSG.PAGE_SNAPSHOT, payload: snap })
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

document.addEventListener('input', debouncedSnapshot, true)
document.addEventListener('change', debouncedSnapshot, true)
document.addEventListener('click', debouncedSnapshot, true)

// ─── Periodic page text extraction ────────────────────────────────────────────

function sendPageText(): void {
  const pageText = extractPageText(12_000)
  const visibleText = extractVisibleText(6000)
  const completePageText = extractCompletePageText(100_000)

  const hash = simpleHash(pageText + completePageText.slice(0, 2000))
  if (hash === lastPageTextHash) return
  lastPageTextHash = hash

  const payload: Record<string, string> = { type: MSG.PAGE_TEXT, pageText, visibleText, completePageText }

  const structuredContent = extractStructuredContent()
  if (structuredContent) payload.structuredContent = structuredContent

  const landmarks = extractSemanticLandmarks()
  if (landmarks.length > 0) {
    payload.landmarks = landmarks.map(l => `${l.type}(${l.count})`).join(', ')
  }

  safeSendMessage(payload)
}

setInterval(sendPageText, 2500)

// ─── Selection monitoring ─────────────────────────────────────────────────────

let lastSelection = ''
document.addEventListener('selectionchange', () => {
  const text = extractSelectedText()
  if (text && text !== lastSelection && text.length > 3) {
    lastSelection = text
    safeSendMessage({ type: MSG.TEXT_SELECTED, text })
  }
})

// ─── Message handler (SW -> Content) ──────────────────────────────────────────

try {
  chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
    handleContentMessage(msg).then(sendResponse).catch((err: Error) => sendResponse({ ok: false, error: err.message }))
    return true
  })
} catch {
  // Extension context invalidated after reload/update — content script is stale
}

async function handleContentMessage(msg: Record<string, unknown>): Promise<unknown> {
  switch (msg.type) {
    case MSG.PING:
      return { ok: true }

    case MSG.SET_SAFETY_BORDER: {
      applySafetyBorderMessage(msg)
      return { ok: true }
    }

    case MSG.SHOW_CLICK_EFFECT: {
      const x = msg.x as number
      const y = msg.y as number
      if (typeof x === 'number' && typeof y === 'number') {
        showClickEffect(x, y)
      }
      return { ok: true }
    }

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

    case MSG.FORM_COACH_START: {
      const fields = msg.fields as CoachField[]
      startCoach(fields, (summary) => {
        // Notify service worker that coaching is done
        chrome.runtime.sendMessage({
          type: MSG.FORM_COACH_DONE,
          ...summary,
        }).catch(() => {})
      })
      return { ok: true }
    }

    case MSG.SHOW_ACTIVITY_BORDER: {
      showActivityBorder()
      return { ok: true }
    }

    case MSG.HIDE_ACTIVITY_BORDER: {
      hideActivityBorder()
      return { ok: true }
    }

    case MSG.INJECT_MARKERS: {
      const elements = injectMarkers()
      setLastMarkedElements(elements)
      const tree = buildAccessibilityTree(elements)
      return { ok: true, elements, accessibilityTree: tree }
    }

    case MSG.REMOVE_MARKERS: {
      removeMarkers()
      return { ok: true }
    }

    case MSG.CLICK_MARKER: {
      const markerId = msg.markerId as number
      let el = findElementByMarkerId(markerId)
      if (!el) {
        const recovered = recoverStaleElement(markerId)
        if (recovered) {
          el = recovered.element
        } else {
          return { ok: false, error: `Marker ${markerId} not found on page (recovery failed). Use [ACTION:READ_PAGE filter="interactive"] to get fresh element IDs.` }
        }
      }
      return await handleClickElement(el)
    }

    case MSG.EXECUTE_BY_AI_ID: {
      const aiId = msg.aiId as number
      const actionType = msg.actionType as string
      const value = msg.value as string | undefined
      let el = findElementByAIId(aiId)

      // Staleness recovery: if element not found, re-inject markers and find by role+name
      if (!el) {
        const recovered = recoverStaleElement(aiId)
        if (recovered) {
          el = recovered.element
        } else {
          return { ok: false, error: `AI element ${aiId} not found on page (recovery failed). Use [ACTION:READ_PAGE filter="interactive"] to get fresh element IDs.` }
        }
      }

      if (userIsInteracting) return { ok: false, error: 'USER_ACTIVE', userActive: true }
      return await executeAIIdAction(el, actionType, value)
    }

    case MSG.ANALYZE_FILE: {
      const url = msg.url as string
      if (!url) return { ok: false, error: 'No file URL' }
      const r = await analyzeFileFromUrl(url)
      if (!r.ok) return { ok: false, error: r.error ?? 'Failed' }
      return { ok: true, result: formatFileAnalysisResult(r) }
    }

    case MSG.READ_PAGE: {
      const filter = (msg.filter as string) || 'all'
      return handleReadPage(filter)
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

// ─── Read Page (Claude-style page understanding) ────────────────────────────

function handleReadPage(filter: string): { ok: boolean; result: string; snapshot: ReturnType<typeof buildSnapshot> } {
  const snapshot = buildSnapshot()
  lastSnapshot = snapshot
  const parts: string[] = [`Page: ${snapshot.url}`, `Title: ${snapshot.title}`, '']

  if (filter === 'interactive' || filter === 'all') {
    const elements = injectMarkers()
    setLastMarkedElements(elements)
    const tree = buildAccessibilityTree(elements)
    removeMarkers()
    parts.push(`## Interactive Elements (${elements.length} found)`)
    parts.push(tree)
    parts.push('')
  }

  if (filter === 'forms' || filter === 'all') {
    if (snapshot.forms.length > 0) {
      parts.push(`## Forms (${snapshot.forms.length})`)
      for (const form of snapshot.forms) {
        parts.push(`Form: ${form.selector} (${form.method} ${form.action})`)
        for (const field of form.fields) {
          const opts = field.options?.map(o => `"${o.label}"`).join(', ') ?? ''
          const state = field.checked !== undefined ? (field.checked ? ' [checked]' : ' [unchecked]') : ''
          parts.push(`  [ref] [${field.type}] "${field.label || field.name}" ${field.required ? '[required]' : ''} ${field.value ? `[value: "${field.value}"]` : ''}${state} ${opts ? `[options: ${opts}]` : ''}`)
        }
      }
      parts.push('')
    }
  }

  if (filter === 'text' || filter === 'all') {
    const visText = extractVisibleText(4000)
    parts.push('## Visible Text')
    parts.push(visText)
    parts.push('')

    if (snapshot.headings.length > 0) {
      parts.push('## Headings')
      parts.push(snapshot.headings.join('\n'))
      parts.push('')
    }

    const landmarks = extractSemanticLandmarks()
    if (landmarks.length > 0) {
      parts.push('## Landmarks')
      parts.push(landmarks.map(l => `${l.type}(${l.count})`).join(', '))
      parts.push('')
    }
  }

  return { ok: true, result: parts.join('\n'), snapshot }
}

// ─── Action execution ─────────────────────────────────────────────────────────

async function executeAction(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    switch (action.action) {
      case 'click':       return await handleClick(action)
      case 'type':        return await handleType(action)
      case 'scroll':      return handleScroll(action)
      case 'navigate':    return handleNavigate(action)
      case 'read':        return handleRead(action)
      case 'select':      return handleHighlightSelect(action)
      case 'fill_form':   return await handleFillForm(action)
      case 'select_option': return await handleSelectOption(action)
      case 'check':       return await handleCheck(action)
      case 'clear':       return await handleClear(action)
      case 'read_options': return handleReadOptions(action)
      case 'get_page_state': return { ok: true, result: 'Page state returned in snapshot' }
      case 'hover':       return await handleHover(action)
      case 'doubleclick': return await handleDoubleClick(action)
      case 'keypress':    return handleKeypress(action)
      case 'focus':       return await handleFocus(action)
      case 'back':        return handleBack()
      case 'forward':     return handleForward()
      case 'scroll_to':   return await handleScrollTo(action)
      case 'select_text': return handleSelectText(action)
      case 'batch_read': return handleBatchRead(action)
      case 'analyze_file': return await handleAnalyzeFile(action)
      case 'toggle':      return await handleToggle(action)
      default:
        return { ok: false, error: `Unknown action: ${action.action}` }
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

async function executeAIIdAction(
  el: HTMLElement,
  actionType: string,
  value?: string
): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    switch (actionType) {
      case 'click':       return await handleClickElement(el)
      case 'type':        return await aiIdType(el, value ?? '')
      case 'hover':       return await aiIdHover(el)
      case 'doubleclick': return await aiIdDoubleClick(el)
      case 'focus':       return aiIdFocus(el)
      case 'check':       return aiIdCheck(el, value)
      case 'toggle':      return aiIdToggle(el)
      case 'select_option': return await aiIdSelectOption(el, value ?? '')
      case 'clear':       return aiIdClear(el)
      case 'scroll_to': {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return { ok: true, result: `Scrolled to element` }
      }
      default:
        return { ok: false, error: `Unsupported AI ID action: ${actionType}` }
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

async function aiIdType(el: HTMLElement, text: string): Promise<{ ok: boolean; result?: string; error?: string }> {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(150)
  el.focus()
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el.isContentEditable) {
    el.textContent = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    return { ok: false, error: 'Element is not a text input' }
  }
  return { ok: true, result: `Typed "${text.slice(0, 30)}" into element` }
}

async function aiIdHover(el: HTMLElement): Promise<{ ok: boolean; result?: string }> {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(100)
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  return { ok: true, result: `Hovered element` }
}

async function aiIdDoubleClick(el: HTMLElement): Promise<{ ok: boolean; result?: string }> {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(150)
  el.focus()
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  return { ok: true, result: `Double-clicked element` }
}

function aiIdFocus(el: HTMLElement): { ok: boolean; result?: string } {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.focus()
  return { ok: true, result: `Focused element` }
}

function aiIdCheck(el: HTMLElement, value?: string): { ok: boolean; result?: string } {
  const target = isControlElement(el) ? el : findNearbyControl(el) ?? el
  const wantChecked = !value || value === 'true' || value === 'on'
  if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
    target.checked = wantChecked
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, result: `Set ${target.type} to ${wantChecked ? 'checked' : 'unchecked'}` }
  }
  target.click()
  return { ok: true, result: `Clicked to check element` }
}

function aiIdToggle(el: HTMLElement): { ok: boolean; result?: string } {
  const target = isControlElement(el) ? el : findNearbyControl(el) ?? el
  target.click()
  return { ok: true, result: `Toggled element` }
}

async function aiIdSelectOption(el: HTMLElement, value: string): Promise<{ ok: boolean; result?: string; error?: string }> {
  if (el instanceof HTMLSelectElement) {
    for (const opt of el.options) {
      if (opt.value === value || opt.textContent?.trim() === value) {
        el.value = opt.value
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, result: `Selected "${opt.textContent?.trim()}"` }
      }
    }
    return { ok: false, error: `Option "${value}" not found` }
  }
  el.click()
  await sleep(300)
  const opts = document.querySelectorAll<HTMLElement>('[role="option"], [role="listbox"] li, ul[role="listbox"] > *')
  for (const opt of opts) {
    if (opt.textContent?.trim().toLowerCase().includes(value.toLowerCase())) {
      opt.click()
      return { ok: true, result: `Selected "${opt.textContent.trim()}"` }
    }
  }
  return { ok: false, error: `Option "${value}" not found after opening dropdown` }
}

function aiIdClear(el: HTMLElement): { ok: boolean; result?: string } {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el.isContentEditable) {
    el.textContent = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return { ok: true, result: 'Cleared element' }
}

function redirectToNearbyControl(el: HTMLElement): HTMLElement {
  if (isControlElement(el)) return el

  const nearby = findNearbyControl(el)
  if (nearby) return nearby

  const labelFor = el.closest('label')?.getAttribute('for')
  if (labelFor) {
    const target = document.getElementById(labelFor)
    if (target instanceof HTMLElement && isVisible(target)) return target
  }

  return el
}

// ─── Click ────────────────────────────────────────────────────────────────────

async function handleClick(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  let selector = action.selector ?? ''

  // If selector is empty, try to find the primary action button (Search, Done, Submit, etc.)
  if (!selector.trim()) {
    const primaryBtn = findPrimaryButton()
    if (primaryBtn) {
      return performClick(primaryBtn)
    }
    return { ok: false, error: `Empty selector — specify which element to click. Available: ${listClickableElements()}` }
  }

  let el = findByVisibleText(selector) ?? resolveElement(selector)

  // Scroll-to-reveal: incrementally scroll through the page to find the element
  if (!el) {
    el = await findElementWithScroll(selector)
  }

  if (!el) {
    el = findByTreeWalker(selector)
  }

  if (!el) {
    el = findByXPath(selector)
  }

  if (!el) return { ok: false, error: `Element not found: "${selector}". Available clickable elements: ${listClickableElements()}` }

  if (!isClickable(el)) {
    const parent = el.closest<HTMLElement>('a, button, [role="button"], [role="switch"], [role="checkbox"], [aria-checked], [tabindex], [onclick], [jsaction], input[type="checkbox"]')
    if (parent && isVisible(parent)) el = parent
  }

  el = redirectToNearbyControl(el)

  return performClick(el)
}

async function findElementWithScroll(selector: string, maxScrolls = 5): Promise<HTMLElement | null> {
  // Save original position
  const originalY = window.scrollY

  // Try waiting for dynamic content first (SPA pages)
  for (let wait = 0; wait < 2; wait++) {
    await sleep(400)
    const el = findByVisibleText(selector) ?? resolveElement(selector)
    if (el) return el
  }

  // Scroll to top first
  window.scrollTo(0, 0)
  await sleep(300)
  let el = findByVisibleText(selector) ?? resolveElement(selector)
  if (el) return el

  // Incrementally scroll down, checking after each scroll
  const scrollStep = Math.floor(window.innerHeight * 0.8)
  for (let i = 0; i < maxScrolls; i++) {
    window.scrollBy(0, scrollStep)
    await sleep(500) // Wait for dynamic content to load
    el = findByVisibleText(selector) ?? resolveElement(selector)
    if (el) return el
  }

  // Last resort: restore position and try TreeWalker/XPath
  window.scrollTo(0, originalY)
  await sleep(200)

  el = findByTreeWalker(selector)
  if (el) return el

  el = findByXPath(selector)
  return el
}

function findByTreeWalker(text: string): HTMLElement | null {
  if (!text) return null
  const clean = text.replace(/^["']|["']$/g, '').trim().toLowerCase()
  if (!clean) return null

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.textContent?.trim().toLowerCase() ?? ''
      if (t === clean || (t.length < 120 && t.includes(clean))) return NodeFilter.FILTER_ACCEPT
      return NodeFilter.FILTER_SKIP
    },
  })

  let best: HTMLElement | null = null
  let bestLen = Infinity

  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement
    if (!parent || !isVisible(parent)) continue
    const len = (parent.textContent?.trim() ?? '').length
    if (len < bestLen) {
      bestLen = len
      best = parent
    }
  }

  return best
}

function findByXPath(text: string): HTMLElement | null {
  if (!text) return null
  const clean = text.replace(/^["']|["']$/g, '').trim()
  if (!clean) return null

  try {
    const escaped = clean.replace(/'/g, "\\'")
    const xp = `//*[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${escaped.toLowerCase()}')]`
    const result = document.evaluate(xp, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null)
    let node = result.iterateNext()
    let best: HTMLElement | null = null
    let bestLen = Infinity
    while (node) {
      const el = node as HTMLElement
      if (isVisible(el)) {
        const len = (el.textContent?.trim() ?? '').length
        if (len < bestLen) {
          bestLen = len
          best = el
        }
      }
      node = result.iterateNext()
    }
    return best
  } catch {
    return null
  }
}

function isClickable(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return true
  const role = el.getAttribute('role')
  if (role === 'button' || role === 'link' || role === 'switch' || role === 'checkbox' || role === 'radio') return true
  if (el.hasAttribute('aria-checked') || el.hasAttribute('aria-pressed')) return true
  if (el.hasAttribute('onclick') || el.hasAttribute('jsaction') || el.hasAttribute('tabindex')) return true
  if (el.hasAttribute('data-action') || el.hasAttribute('data-click')) return true
  return false
}

async function performClick(el: HTMLElement): Promise<{ ok: boolean; result?: string; error?: string }> {
  const preUrl = location.href
  const preTitle = document.title
  const preHash = quickBodyHash()

  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(200)

  el.focus()
  const rect = el.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  showClickEffect(cx, cy)

  // Use full realistic event sequence that modern frameworks respond to
  const mouseOpts: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }
  const pointerOpts = { ...mouseOpts, pointerId: 1, pointerType: 'mouse' as const, isPrimary: true }

  el.dispatchEvent(new PointerEvent('pointerover', pointerOpts))
  el.dispatchEvent(new PointerEvent('pointerenter', { ...pointerOpts, bubbles: false }))
  el.dispatchEvent(new MouseEvent('mouseover', mouseOpts))
  el.dispatchEvent(new MouseEvent('mouseenter', { ...mouseOpts, bubbles: false }))
  el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts))
  el.dispatchEvent(new MouseEvent('mousedown', mouseOpts))
  el.dispatchEvent(new PointerEvent('pointerup', pointerOpts))
  el.dispatchEvent(new MouseEvent('mouseup', mouseOpts))
  el.dispatchEvent(new MouseEvent('click', mouseOpts))

  // Always try native .click() as well — many frameworks (React, Angular, etc.)
  // need the trusted native event, not just dispatched synthetic events
  try { el.click() } catch { /* ignore */ }

  // Also try clicking the nearest <a> or <button> ancestor if el is a child
  if (el.tagName !== 'A' && el.tagName !== 'BUTTON') {
    const clickableParent = el.closest<HTMLElement>('a[href], button, [role="button"], [role="link"]')
    if (clickableParent && clickableParent !== el) {
      try { clickableParent.click() } catch { /* ignore */ }
    }
  }

  await sleep(200) // reduced from 800ms — CDP is now the primary click path

  const postUrl = location.href
  const postTitle = document.title
  const postHash = quickBodyHash()

  const label = cleanResultText(el)

  if (preUrl !== postUrl) {
    return { ok: true, result: `Clicked "${label}" → navigated to ${postUrl}` }
  }
  if (preTitle !== postTitle) {
    return { ok: true, result: `Clicked "${label}" → page changed: ${postTitle}` }
  }
  if (preHash !== postHash) {
    return { ok: true, result: `Clicked "${label}" → content updated` }
  }

  // Return coordinates so the service worker can retry with CDP (trusted events)
  return {
    ok: true,
    result: `Clicked "${label}" — WARNING: no visible page change detected. [COORDS:${Math.round(cx)},${Math.round(cy)}]`,
  }
}

async function handleClickElement(el: HTMLElement): Promise<{ ok: boolean; result?: string; error?: string }> {
  removeMarkers()
  return performClick(el)
}

function quickBodyHash(): string {
  const sample = (document.body.textContent ?? '').slice(0, 3000)
  return simpleHash(sample)
}

function cleanResultText(el: HTMLElement): string {
  const raw = (el.textContent?.trim() ?? '').slice(0, 80)
  if (looksLikeCode(raw)) return `(${el.tagName.toLowerCase()})`
  return raw.slice(0, 50)
}

// ─── Type ─────────────────────────────────────────────────────────────────────

/** Find an input/textarea/select by label, placeholder, aria-label, name, or role */
function findInputField(text: string): HTMLElement | null {
  const clean = text.replace(/^["']|["']$/g, '').trim().toLowerCase()
  if (!clean) return null

  // Strategy 1: inputs/textareas/selects by placeholder, aria-label, name, title
  const inputs = document.querySelectorAll<HTMLElement>(
    'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"]'
  )
  // Exact match first
  for (const el of inputs) {
    if (!isVisible(el)) continue
    const ph = (el.getAttribute('placeholder') ?? '').toLowerCase()
    const aria = (el.getAttribute('aria-label') ?? '').toLowerCase()
    const name = (el.getAttribute('name') ?? '').toLowerCase()
    const title = (el.getAttribute('title') ?? '').toLowerCase()
    const id = (el.id ?? '').toLowerCase()
    if (ph === clean || aria === clean || name === clean || title === clean || id === clean) return el
  }
  // Partial match
  for (const el of inputs) {
    if (!isVisible(el)) continue
    const ph = (el.getAttribute('placeholder') ?? '').toLowerCase()
    const aria = (el.getAttribute('aria-label') ?? '').toLowerCase()
    const name = (el.getAttribute('name') ?? '').toLowerCase()
    const title = (el.getAttribute('title') ?? '').toLowerCase()
    if (ph.includes(clean) || aria.includes(clean) || name.includes(clean) || title.includes(clean)) return el
  }

  // Strategy 2: find by associated <label> text
  const labels = document.querySelectorAll<HTMLLabelElement>('label')
  for (const label of labels) {
    const labelText = (label.textContent ?? '').trim().toLowerCase()
    if (labelText === clean || labelText.includes(clean)) {
      if (label.htmlFor) {
        const target = document.getElementById(label.htmlFor)
        if (target && isVisible(target as HTMLElement)) return target as HTMLElement
      }
      // Label might wrap the input
      const inner = label.querySelector<HTMLElement>('input, textarea, select')
      if (inner && isVisible(inner)) return inner
    }
  }

  return null
}

async function handleType(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const selector = action.selector ?? ''
  if (!selector.trim()) {
    return { ok: false, error: 'Empty selector — specify which field to type into (CSS selector or field name).' }
  }

  // Try input-specific finding first (placeholder, aria-label, name, label text)
  let el = findInputField(selector) ?? findByVisibleText(selector) ?? resolveElement(selector)

  if (!el) {
    el = await findElementWithScroll(selector, 3)
  }

  // Last resort: TreeWalker and XPath (same as handleClick)
  if (!el) el = findByTreeWalker(selector)
  if (!el) el = findByXPath(selector)

  if (!el) return { ok: false, error: `Field not found: ${selector}. Try using a CSS selector like textarea, input[name="q"], or the field's placeholder text.` }

  // If we found a label or container, look for the actual input inside it
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable
      && !el.getAttribute('role')?.match(/textbox|combobox|searchbox/)) {
    const inner = el.querySelector<HTMLElement>('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]')
    if (inner) el = inner
  }

  const inputType = (el as HTMLInputElement).type || el.tagName.toLowerCase()
  const ok = await fillField(el, action.value ?? '', inputType)
  if (!ok) return { ok: false, error: `Could not fill field: ${selector}` }

  showAIAttribution(el)
  return { ok: true, result: `Typed "${(action.value ?? '').slice(0, 30)}" into ${selector}` }
}

// ─── Hover ────────────────────────────────────────────────────────────────────

async function handleHover(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = findByVisibleText(action.selector ?? '') ?? resolveElement(action.selector ?? '')
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(200)

  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }))
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }))

  return { ok: true, result: `Hovered: "${el.textContent?.trim().slice(0, 40)}"` }
}

// ─── Double Click ─────────────────────────────────────────────────────────────

async function handleDoubleClick(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = findByVisibleText(action.selector ?? '') ?? resolveElement(action.selector ?? '')
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(200)

  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))

  return { ok: true, result: `Double-clicked: "${el.textContent?.trim().slice(0, 40)}"` }
}

// ─── Keypress ─────────────────────────────────────────────────────────────────

function handleKeypress(action: AIAction): { ok: boolean; result?: string; error?: string } {
  const keyCombo = action.value ?? ''
  if (!keyCombo) return { ok: false, error: 'No key specified' }

  const parts = keyCombo.split('+')
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts.map(p => p.toLowerCase()))

  const target = (action.selector ? resolveElement(action.selector) : null) ?? document.activeElement ?? document.body

  const opts: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.has('ctrl') || modifiers.has('control'),
    shiftKey: modifiers.has('shift'),
    altKey: modifiers.has('alt'),
    metaKey: modifiers.has('meta') || modifiers.has('cmd'),
  }

  target.dispatchEvent(new KeyboardEvent('keydown', opts))
  target.dispatchEvent(new KeyboardEvent('keypress', opts))
  target.dispatchEvent(new KeyboardEvent('keyup', opts))

  return { ok: true, result: `Pressed: ${keyCombo}` }
}

// ─── Focus ────────────────────────────────────────────────────────────────────

async function handleFocus(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = findByVisibleText(action.selector ?? '') ?? resolveElement(action.selector ?? '')
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.focus()
  return { ok: true, result: `Focused: ${action.selector}` }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function handleBack(): { ok: boolean; result?: string } {
  history.back()
  return { ok: true, result: 'Navigated back' }
}

function handleForward(): { ok: boolean; result?: string } {
  history.forward()
  return { ok: true, result: 'Navigated forward' }
}

// ─── Scroll To ────────────────────────────────────────────────────────────────

async function handleScrollTo(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const el = findByVisibleText(action.selector ?? '') ?? resolveElement(action.selector ?? '')
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return { ok: true, result: `Scrolled to: "${el.textContent?.trim().slice(0, 40)}"` }
}

// ─── Select Text ──────────────────────────────────────────────────────────────

function handleSelectText(action: AIAction): { ok: boolean; result?: string; error?: string } {
  const el = resolveElement(action.selector ?? '')
  if (!el) return { ok: false, error: `Element not found: ${action.selector}` }

  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  return { ok: true, result: `Selected text in: ${action.selector}` }
}

function handleBatchRead(action: AIAction): { ok: boolean; result?: string; error?: string } {
  let selectors: string[] = []
  const raw = action.value ?? ''
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      selectors = parsed
        .map(x => (typeof x === 'string' ? x : (x as { selector?: string }).selector))
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
    }
  } catch {
    selectors = raw.split(/[\n|]+/).map(s => s.trim()).filter(Boolean)
  }
  if (selectors.length === 0) {
    return { ok: false, error: 'batch_read: set value to a JSON array of CSS selectors, e.g. ["#a","div.b"]' }
  }
  const parts: string[] = []
  for (const sel of selectors.slice(0, 25)) {
    try {
      const el = document.querySelector(sel)
      if (!el) {
        parts.push(`--- ${sel} ---\n[element not found]`)
        continue
      }
      const t = el.textContent?.trim() ?? ''
      parts.push(`--- ${sel} ---\n${t.slice(0, 12_000)}`)
    } catch (e) {
      parts.push(`--- ${sel} ---\n[error: ${e}]`)
    }
  }
  return { ok: true, result: parts.join('\n\n') }
}

async function handleAnalyzeFile(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  let href = action.url?.trim() ?? ''
  if (!href && action.selector) {
    const el = document.querySelector<HTMLAnchorElement>(action.selector)
    href = el?.href ?? ''
  }
  if (!href) {
    const links = findAttachmentLinks()
    const hint = links.length
      ? `Try: ${links.map(l => `${l.text} → ${l.href.slice(0, 80)}`).slice(0, 4).join(' | ')}`
      : 'No attachment links detected on this view.'
    return { ok: false, error: `analyze_file: pass url= or selector= for a file link. ${hint}` }
  }
  const r = await analyzeFileFromUrl(href)
  if (!r.ok) return { ok: false, error: r.error ?? 'Analysis failed' }
  return { ok: true, result: formatFileAnalysisResult(r) }
}

function formatFileAnalysisResult(r: FileAnalysisResult): string {
  const lines = [`Type: ${r.mime ?? 'unknown'}`, `Size: ${r.sizeBytes ?? 0} bytes`]
  if (r.warning) lines.push(`Note: ${r.warning}`)
  lines.push('')
  lines.push(r.textExcerpt ?? '')
  return lines.join('\n')
}

// ─── Other standard actions ───────────────────────────────────────────────────

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
  action.assignments.forEach(a => {
    const el = document.querySelector<HTMLElement>(a.selector)
    if (el) showAIAttribution(el)
  })
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
  showAIAttribution(el)
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

// ─── Toggle (smart switch/checkbox handler) ──────────────────────────────────

async function handleToggle(action: AIAction): Promise<{ ok: boolean; result?: string; error?: string }> {
  const selector = action.selector ?? ''
  if (!selector.trim()) {
    return { ok: false, error: 'Empty selector — specify which toggle/switch to change.' }
  }

  const desiredState = action.value?.toLowerCase()
  const wantOn = desiredState === 'true' || desiredState === 'on' || desiredState === 'enable'
  const wantOff = desiredState === 'false' || desiredState === 'off' || desiredState === 'disable'

  let el = findToggleElement(selector)
  if (!el) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(400)
      el = findToggleElement(selector)
      if (el) break
    }
  }
  if (!el) return { ok: false, error: `Toggle not found: "${selector}". Available: ${listClickableElements()}` }

  el = redirectToNearbyControl(el)

  const currentState = readToggleState(el)
  const label = (el.getAttribute('aria-label') || el.textContent?.trim() || selector).slice(0, 60)

  if (currentState === 'on' && wantOn) return { ok: true, result: `"${label}" is already ON — no click needed.` }
  if (currentState === 'off' && wantOff) return { ok: true, result: `"${label}" is already OFF — no click needed.` }

  const clickResult = await performClick(el)
  if (!clickResult.ok) return clickResult

  await sleep(500)

  el = findToggleElement(selector)
  const newState = el ? readToggleState(el) : 'unknown'
  const stateDesc = newState === 'on' ? 'ON' : newState === 'off' ? 'OFF' : 'toggled'

  if ((wantOn && newState === 'off') || (wantOff && newState === 'on')) {
    return { ok: false, error: `Toggle "${label}" click did not change state (still ${stateDesc}). Try a different selector or approach.` }
  }

  if (newState === currentState && newState !== 'unknown') {
    return { ok: false, error: `Toggle "${label}" state unchanged after click (still ${stateDesc}). The click may not have targeted the correct element.` }
  }

  return { ok: true, result: `Toggled "${label}" -> ${stateDesc}` }
}

function findToggleElement(selector: string): HTMLElement | null {
  const switchEls = document.querySelectorAll<HTMLElement>(
    '[role="switch"], [role="checkbox"], input[type="checkbox"], [aria-checked]'
  )
  const clean = selector.replace(/^["']|["']$/g, '').trim().toLowerCase()

  for (const el of switchEls) {
    if (!isVisible(el)) continue
    const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase()
    if (ariaLabel && (ariaLabel.includes(clean) || clean.includes(ariaLabel))) return el
  }

  for (const el of switchEls) {
    if (!isVisible(el)) continue
    const name = (el.textContent?.trim() ?? '').toLowerCase()
    if (name.includes(clean) || clean.includes(name)) {
      if (isControlElement(el)) return el
      const nearby = findNearbyControl(el)
      if (nearby) return nearby
    }
  }

  const textEl = findByVisibleText(selector) ?? resolveElement(selector)
  if (!textEl) return null

  if (isControlElement(textEl)) return textEl
  return findNearbyControl(textEl) ?? textEl
}

function readToggleState(el: HTMLElement): 'on' | 'off' | 'unknown' {
  const ariaChecked = el.getAttribute('aria-checked')
  if (ariaChecked === 'true') return 'on'
  if (ariaChecked === 'false') return 'off'

  const ariaPressed = el.getAttribute('aria-pressed')
  if (ariaPressed === 'true') return 'on'
  if (ariaPressed === 'false') return 'off'

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    return el.checked ? 'on' : 'off'
  }

  const cls = el.className?.toString?.() ?? ''
  if (/\b(active|enabled|is-on|is-checked|toggled)\b/i.test(cls)) return 'on'
  if (/\b(inactive|is-off|is-unchecked|untoggled)\b/i.test(cls)) return 'off'

  return 'unknown'
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

// ─── AI Attribution visual indicator ──────────────────────────────────────────

function showAIAttribution(el: HTMLElement): void {
  const origBorder = el.style.borderLeft
  el.style.borderLeft = '3px solid #7c6ef5'

  const label = document.createElement('span')
  label.textContent = 'AI filled'
  label.style.cssText = `
    position:absolute;font-size:10px;background:#7c6ef5;color:#fff;
    padding:1px 6px;border-radius:4px;z-index:999999;pointer-events:none;
    opacity:1;transition:opacity 1s ease;
  `
  const rect = el.getBoundingClientRect()
  label.style.top = `${rect.top + window.scrollY - 16}px`
  label.style.left = `${rect.left + window.scrollX}px`
  document.body.appendChild(label)

  setTimeout(() => { label.style.opacity = '0' }, 1500)
  setTimeout(() => { el.style.borderLeft = origBorder; label.remove() }, 2500)
}

// ─── Element resolution helpers ───────────────────────────────────────────────

function resolveElement(selector: string): HTMLElement | null {
  if (!selector) return null
  try {
    return document.querySelector<HTMLElement>(selector)
  } catch {
    return null
  }
}

// ─── Element quality filter ────────────────────────────────────────────────────

const REJECTED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'PATH',
  'META', 'LINK', 'HEAD', 'BR', 'HR', 'DEFS', 'CLIPPATH',
])

function looksLikeCode(text: string): boolean {
  if (!text) return false
  const t = text.trimStart()
  return /^(\(function|var |const |let |\/\/|\/\*|\{|import |export |if\s*\(|try\s*\{|window\.)/.test(t)
}

function isClickableElement(el: HTMLElement): boolean {
  if (REJECTED_TAGS.has(el.tagName)) return false
  if (el.closest('script, style, noscript, template')) return false

  if (el.offsetParent === null && el.offsetHeight === 0 && el.offsetWidth === 0) return false

  const text = el.textContent?.trim() ?? ''
  if (looksLikeCode(text)) return false

  if (text.length > 500) return false

  return true
}

// ─── Element scoring ──────────────────────────────────────────────────────────

function scoreElement(el: HTMLElement): number {
  const tag = el.tagName.toLowerCase()
  let score = 0

  if (tag === 'a' || tag === 'button') score += 10
  if (tag === 'input' && ['submit', 'button'].includes((el as HTMLInputElement).type)) score += 10
  if (tag === 'input' && (el as HTMLInputElement).type === 'checkbox') score += 10

  const role = el.getAttribute('role')
  if (role === 'switch' || role === 'checkbox' || role === 'radio') score += 12
  if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') score += 8
  if (role === 'row' || role === 'option' || role === 'listitem' || role === 'gridcell' || role === 'treeitem') score += 5
  if (role) score += 2

  if (el.hasAttribute('aria-checked') || el.hasAttribute('aria-pressed')) score += 10
  if (el.hasAttribute('href')) score += 4
  if (el.hasAttribute('tabindex')) score += 1
  if (el.hasAttribute('jsaction') || el.hasAttribute('data-action') || el.hasAttribute('onclick')) score += 3

  const textLen = (el.textContent?.trim() ?? '').length
  if (textLen > 0 && textLen < 100) score += 3
  if (textLen >= 100 && textLen < 200) score += 1

  return score
}

// ─── Priority-based element search ────────────────────────────────────────────

const HIGH_PRIORITY_SELECTOR = 'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]'

const ROW_SELECTOR = '[role="row"], [role="listitem"], [role="option"], [role="gridcell"], [role="treeitem"], tbody > tr, [jsaction], [data-action], [onclick], [tabindex]'

const WIDE_SELECTOR = 'div, span, li, p, h1, h2, h3, h4, h5, h6, nav a, header a, footer a, section a, label, summary, details, [class*="btn"], [class*="button"], [class*="link"], [class*="tab"], [class*="menu"], [class*="nav"], [data-testid], [data-cy]'

function findByVisibleText(text: string): HTMLElement | null {
  if (!text) return null
  const cleanText = text.replace(/^["']|["']$/g, '').trim().toLowerCase()
  if (!cleanText) return null

  const match = findInSet(HIGH_PRIORITY_SELECTOR, cleanText, true)
  if (match) return match

  const rowMatch = findInSet(ROW_SELECTOR, cleanText, true)
  if (rowMatch) return rowMatch

  const partialHigh = findInSet(HIGH_PRIORITY_SELECTOR, cleanText, false)
  if (partialHigh) return partialHigh

  const partialRow = findInSet(ROW_SELECTOR, cleanText, false)
  if (partialRow) return partialRow

  const wideExact = findInSet(WIDE_SELECTOR, cleanText, true)
  if (wideExact) return wideExact

  const widePartial = findInSet(WIDE_SELECTOR, cleanText, false)
  if (widePartial) return widePartial

  const hrefMatch = findByHref(cleanText)
  if (hrefMatch) return hrefMatch

  const ariaMatch = findByAriaOrDataAttr(cleanText)
  if (ariaMatch) return ariaMatch

  return null
}

function findByHref(text: string): HTMLElement | null {
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href]')
  for (const a of links) {
    if (!isVisible(a)) continue
    const href = a.getAttribute('href')?.toLowerCase() ?? ''
    if (href.includes(text) || text.includes(href.replace(/^\//, ''))) return a
  }
  return null
}

function findByAriaOrDataAttr(text: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(
    `[aria-label*="${CSS.escape(text)}"], [data-testid*="${CSS.escape(text)}"], [data-cy*="${CSS.escape(text)}"], [title*="${CSS.escape(text)}"], [alt*="${CSS.escape(text)}"]`
  )
  for (const el of all) {
    if (isVisible(el)) return el
  }
  return null
}

function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && el.offsetHeight === 0 && el.offsetWidth === 0) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  return true
}

function findInSet(selector: string, cleanText: string, exactOnly: boolean): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>(selector)
  const candidates: { el: HTMLElement; score: number }[] = []

  for (const el of elements) {
    if (!isClickableElement(el)) continue

    const elText = (el.textContent?.trim() ?? '').toLowerCase()
    const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase()
    const title = (el.getAttribute('title') ?? '').toLowerCase()
    const rawVal = (el as HTMLInputElement).value
    const value = (typeof rawVal === 'string' ? rawVal : '').toLowerCase()
    const directText = getDirectText(el).toLowerCase()

    if (elText === cleanText || ariaLabel === cleanText || title === cleanText || value === cleanText || directText === cleanText) {
      return el
    }

    if (!exactOnly) {
      const matches = elText.includes(cleanText) || ariaLabel.includes(cleanText) || cleanText.includes(elText)
      if (matches) {
        candidates.push({ el, score: scoreElement(el) })
      }
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    const diff = b.score - a.score
    if (diff !== 0) return diff
    const aLen = (a.el.textContent?.trim() ?? '').length
    const bLen = (b.el.textContent?.trim() ?? '').length
    return aLen - bLen
  })

  return candidates[0].el
}

function getDirectText(el: HTMLElement): string {
  let text = ''
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
    }
  }
  return text.trim()
}

/** When click has no selector, find the most likely primary action button */
function findPrimaryButton(): HTMLElement | null {
  // Look for common submit/search/done buttons by text, role, and type
  const primaryTexts = ['search', 'done', 'submit', 'go', 'apply', 'ok', 'confirm', 'next', 'continue',
    'suche', 'suchen', 'fertig', 'weiter', 'ok', 'bestätigen', 'explore']
  const buttons = document.querySelectorAll<HTMLElement>(
    'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]'
  )
  for (const btn of buttons) {
    if (!isVisible(btn)) continue
    const text = (btn.textContent?.trim() ?? '').toLowerCase()
    const aria = (btn.getAttribute('aria-label') ?? '').toLowerCase()
    const val = ((btn as HTMLInputElement).value ?? '').toLowerCase()
    for (const pt of primaryTexts) {
      if (text === pt || aria === pt || val === pt || text.includes(pt)) return btn
    }
  }
  // Also try the first visible submit button
  const submit = document.querySelector<HTMLElement>('button[type="submit"]:not([disabled])')
  if (submit && isVisible(submit)) return submit
  return null
}

function listClickableElements(): string {
  const allSelectors = `${HIGH_PRIORITY_SELECTOR}, ${ROW_SELECTOR}, ${WIDE_SELECTOR}`
  const elements = document.querySelectorAll<HTMLElement>(allSelectors)
  const visible: string[] = []
  const seen = new Set<string>()

  for (const el of elements) {
    if (!isVisible(el)) continue
    const text = el.textContent?.trim().slice(0, 50) || (el as HTMLInputElement).value || el.getAttribute('aria-label') || ''
    if (!text || text.length < 2 || seen.has(text)) continue
    seen.add(text)
    visible.push(`"${text}"`)
    if (visible.length >= 35) break
  }
  return visible.join(', ') || 'none visible'
}

// ─── Activity overlay with stop button ──────────────────────────────────────

const BORDER_ID = '__orion-activity-border'
const STOP_BTN_ID = '__orion-stop-btn'

function showActivityBorder(): void {
  if (document.getElementById(BORDER_ID)) return

  // Pulsing border frame
  const el = document.createElement('div')
  el.id = BORDER_ID
  el.style.cssText = `
    position:fixed;inset:0;pointer-events:none;z-index:2147483646;
    border:2px solid rgba(108,92,231,0.6);
    box-shadow:inset 0 0 30px rgba(108,92,231,0.08);
    border-radius:0;animation:__orion-pulse 2s ease-in-out infinite;
  `

  // Floating stop button — top-right corner
  const stopBtn = document.createElement('button')
  stopBtn.id = STOP_BTN_ID
  stopBtn.textContent = 'Stop AI'
  stopBtn.style.cssText = `
    position:fixed;top:12px;right:12px;z-index:2147483647;
    padding:6px 16px;border:none;border-radius:6px;
    background:rgba(220,38,38,0.9);color:#fff;
    font:600 13px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    cursor:pointer;pointer-events:auto;
    box-shadow:0 2px 8px rgba(0,0,0,0.3);
    transition:background 0.15s, transform 0.1s;
  `
  stopBtn.addEventListener('mouseenter', () => { stopBtn.style.background = 'rgba(185,28,28,0.95)' })
  stopBtn.addEventListener('mouseleave', () => { stopBtn.style.background = 'rgba(220,38,38,0.9)' })
  stopBtn.addEventListener('mousedown', () => { stopBtn.style.transform = 'scale(0.95)' })
  stopBtn.addEventListener('mouseup', () => { stopBtn.style.transform = '' })
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.STOP_AUTOMATION }).catch(() => {})
    hideActivityBorder()
  })

  const style = document.createElement('style')
  style.id = `${BORDER_ID}-style`
  style.textContent = `
    @keyframes __orion-pulse {
      0%,100%{border-color:rgba(108,92,231,0.6);box-shadow:inset 0 0 20px rgba(108,92,231,0.05)}
      50%{border-color:rgba(108,92,231,0.9);box-shadow:inset 0 0 40px rgba(108,92,231,0.12)}
    }
  `
  document.head.appendChild(style)
  document.body.appendChild(el)
  document.body.appendChild(stopBtn)
}

function hideActivityBorder(): void {
  document.getElementById(BORDER_ID)?.remove()
  document.getElementById(STOP_BTN_ID)?.remove()
  document.getElementById(`${BORDER_ID}-style`)?.remove()
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(): void {
  sendSnapshot()
  sendPageText()
  setupActionMonitor()
  setupTextMonitor()
  setupComposeAssistant()

  setInterval(() => {
    safeSendMessage({ type: MSG.FLUSH_ACTION_BUFFER })
  }, DEFAULTS.ACTION_FLUSH_INTERVAL_MS)
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
