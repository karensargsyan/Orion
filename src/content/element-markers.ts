/**
 * Element Markers — injects numbered visual badges on interactive elements
 * and builds a simplified accessibility tree for the AI.
 * Inspired by "Set-of-Marks" prompting for vision-language models.
 */

import { getUniqueSelector } from './dom-analyzer'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarkedElement {
  id: number
  role: string
  name: string
  selector: string
  tag: string
  coords: [number, number]
  rect: { x: number; y: number; w: number; h: number }
  state?: string
  controlId?: number
}

// ─── Tag blacklist ─────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'PATH',
  'META', 'LINK', 'HEAD', 'BR', 'HR', 'DEFS', 'CLIPPATH', 'TEMPLATE',
])

const MARKER_CLASS = '__localai-marker'

// ─── Visibility check ──────────────────────────────────────────────────────────

function isElementVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && el.offsetHeight === 0 && el.offsetWidth === 0) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false
  return true
}

// ─── JS content detector ───────────────────────────────────────────────────────

function looksLikeScript(text: string): boolean {
  if (!text) return false
  const t = text.trimStart()
  return /^(\(function|var |const |let |\/\/|\/\*|\{|import |export |if\s*\(|try\s*\{|window\.)/.test(t)
}

// ─── Element name extraction ───────────────────────────────────────────────────

function getElementName(el: HTMLElement): string {
  const ariaLabel = el.getAttribute('aria-label')?.trim()
  if (ariaLabel && ariaLabel.length <= 80) return ariaLabel

  const title = el.getAttribute('title')?.trim()
  if (title && title.length <= 80) return title

  const value = (el as HTMLInputElement).value?.trim()
  if (value && value.length <= 40 && el.tagName === 'INPUT') return value

  const placeholder = el.getAttribute('placeholder')?.trim()
  if (placeholder) return placeholder

  const text = el.textContent?.trim() ?? ''
  if (text.length > 0 && text.length <= 80 && !looksLikeScript(text)) return text

  if (text.length > 80) return text.slice(0, 60) + '...'

  return el.tagName.toLowerCase()
}

// ─── Role detection ────────────────────────────────────────────────────────────

function getElementRole(el: HTMLElement): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit

  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'a': return 'link'
    case 'button': return 'button'
    case 'input': {
      const type = (el as HTMLInputElement).type
      if (type === 'submit' || type === 'button') return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      return 'textbox'
    }
    case 'select': return 'combobox'
    case 'textarea': return 'textbox'
    case 'img': return 'img'
    case 'tr': return 'row'
    case 'td': case 'th': return 'cell'
    case 'nav': return 'navigation'
    default:
      if (el.hasAttribute('contenteditable')) return 'textbox'
      if (el.hasAttribute('onclick') || el.hasAttribute('jsaction') || el.hasAttribute('data-action')) return 'interactive'
      if (window.getComputedStyle(el).cursor === 'pointer') return 'interactive'
      return tag
  }
}

// ─── Element state detection ────────────────────────────────────────────────

function getElementState(el: HTMLElement): string | undefined {
  const parts: string[] = []

  const ariaChecked = el.getAttribute('aria-checked')
  if (ariaChecked) parts.push(ariaChecked === 'true' ? 'ON' : 'OFF')

  const ariaPressed = el.getAttribute('aria-pressed')
  if (ariaPressed) parts.push(ariaPressed === 'true' ? 'pressed' : 'unpressed')

  const ariaExpanded = el.getAttribute('aria-expanded')
  if (ariaExpanded) parts.push(ariaExpanded === 'true' ? 'expanded' : 'collapsed')

  const ariaSelected = el.getAttribute('aria-selected')
  if (ariaSelected === 'true') parts.push('selected')

  const ariaDisabled = el.getAttribute('aria-disabled')
  if (ariaDisabled === 'true') parts.push('disabled')

  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      parts.push(el.checked ? 'checked' : 'unchecked')
    }
    if (el.disabled) parts.push('disabled')
  }

  if (el instanceof HTMLButtonElement && el.disabled) parts.push('disabled')

  if (parts.length === 0) {
    const cls = el.className?.toString?.() ?? ''
    if (/\b(active|enabled|is-on|is-checked|toggled)\b/i.test(cls)) parts.push('ON')
    if (/\b(inactive|is-off|is-unchecked|untoggled)\b/i.test(cls)) parts.push('OFF')
  }

  return parts.length > 0 ? parts.join(', ') : undefined
}

// ─── Control detection ────────────────────────────────────────────────────────

export const CONTROL_SELECTOR = '[role="switch"], [role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"], [aria-checked]'

export function isControlElement(el: HTMLElement): boolean {
  const role = el.getAttribute('role')
  if (role === 'switch' || role === 'checkbox' || role === 'radio') return true
  if (el.hasAttribute('aria-checked')) return true
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return true
  return false
}

export function findNearbyControl(el: HTMLElement): HTMLElement | null {
  const parent = el.parentElement
  if (!parent) return null

  for (let container: HTMLElement | null = parent; container; container = container.parentElement) {
    const control = container.querySelector<HTMLElement>(CONTROL_SELECTOR)
    if (control && control !== el && isElementVisible(control)) return control
    if (container.children.length > 20) break
  }

  return null
}

// ─── Collect interactive elements ──────────────────────────────────────────────

const INTERACTIVE_SELECTOR = [
  'button', 'a[href]', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="row"]', '[role="option"]', '[role="listitem"]', '[role="gridcell"]',
  '[role="treeitem"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
  '[contenteditable="true"]',
  '[onclick]', '[jsaction]', '[data-action]', '[tabindex]',
  'tbody > tr',
].join(', ')

function collectInteractiveElements(): HTMLElement[] {
  const all = document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)
  const controls: HTMLElement[] = []
  const others: HTMLElement[] = []
  const seen = new Set<HTMLElement>()

  for (const el of all) {
    if (seen.has(el)) continue
    if (SKIP_TAGS.has(el.tagName)) continue
    if (el.closest('script, style, noscript, template')) continue
    if (!isElementVisible(el)) continue

    const text = el.textContent?.trim() ?? ''
    if (looksLikeScript(text)) continue
    if (text.length > 500) continue

    seen.add(el)
    if (isControlElement(el)) {
      controls.push(el)
    } else {
      others.push(el)
    }
  }

  return [...controls, ...others]
}

// ─── Inject numbered badges ────────────────────────────────────────────────────

export function injectMarkers(): MarkedElement[] {
  removeMarkers()

  const elements = collectInteractiveElements()
  const marked: MarkedElement[] = []
  const elementToId = new Map<HTMLElement, number>()

  for (let i = 0; i < elements.length && i < 120; i++) {
    const el = elements[i]
    const rect = el.getBoundingClientRect()
    const cx = Math.round(rect.left + rect.width / 2)
    const cy = Math.round(rect.top + rect.height / 2)
    const id = i + 1

    elementToId.set(el, id)

    const badge = document.createElement('span')
    badge.className = MARKER_CLASS
    badge.textContent = String(id)
    badge.dataset.markerId = String(id)
    badge.style.cssText = `
      position:fixed;
      top:${Math.max(0, rect.top - 8)}px;
      left:${Math.max(0, rect.left - 8)}px;
      min-width:16px;height:16px;
      font-size:10px;font-weight:bold;font-family:monospace;
      color:#fff;background:#e63946;
      border-radius:8px;
      display:flex;align-items:center;justify-content:center;
      z-index:2147483646;pointer-events:none;
      padding:0 3px;line-height:1;
      box-shadow:0 1px 3px rgba(0,0,0,0.4);
    `
    document.body.appendChild(badge)

    marked.push({
      id,
      role: getElementRole(el),
      name: getElementName(el),
      selector: getUniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      coords: [cx, cy],
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      state: getElementState(el),
    })
  }

  for (let i = 0; i < marked.length; i++) {
    const el = elements[i]
    if (isControlElement(el)) continue

    const control = findNearbyControl(el)
    if (control) {
      const controlId = elementToId.get(control)
      if (controlId) marked[i].controlId = controlId
    }
  }

  return marked
}

// ─── Remove badges ─────────────────────────────────────────────────────────────

export function removeMarkers(): void {
  document.querySelectorAll(`.${MARKER_CLASS}`).forEach(el => el.remove())
}

// ─── Build accessibility tree text ─────────────────────────────────────────────

export function buildAccessibilityTree(elements: MarkedElement[]): string {
  if (elements.length === 0) return 'No interactive elements found.'

  const controlIds = new Set(elements.filter(e => e.controlId).map(e => e.controlId))
  const suppressedLabels = new Set<number>()

  for (const el of elements) {
    if (!el.controlId) continue
    const control = elements.find(c => c.id === el.controlId)
    if (!control) continue
    const labelName = el.name.replace(/\n/g, ' ').trim().toLowerCase()
    const controlName = control.name.replace(/\n/g, ' ').trim().toLowerCase()
    if (labelName === controlName || controlName.includes(labelName)) {
      suppressedLabels.add(el.id)
    }
  }

  const lines: string[] = []
  for (const el of elements) {
    if (suppressedLabels.has(el.id)) continue

    const name = el.name.replace(/\n/g, ' ').trim()
    const stateTag = el.state ? ` [State: ${el.state}]` : ''
    const controlTag = el.controlId ? ` [Control: ${el.controlId}]` : ''
    const actionHint = controlIds.has(el.id) ? ' [Actionable]' : ''
    lines.push(`[ID: ${el.id}] [${capitalize(el.role)}] [${name}]${stateTag}${controlTag}${actionHint} [Coords: ${el.coords[0]}, ${el.coords[1]}]`)
  }

  return lines.join('\n')
}

// ─── Find element by marker ID ─────────────────────────────────────────────────

let lastMarkedElements: MarkedElement[] = []

export function getLastMarkedElements(): MarkedElement[] {
  return lastMarkedElements
}

export function setLastMarkedElements(elements: MarkedElement[]): void {
  lastMarkedElements = elements
}

export function findElementByMarkerId(id: number): HTMLElement | null {
  const entry = lastMarkedElements.find(e => e.id === id)
  if (!entry) return null

  try {
    return document.querySelector<HTMLElement>(entry.selector)
  } catch {
    return null
  }
}

export function findElementByAIId(aiId: number): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`[data-ai-id="${aiId}"]`)
  if (el) return el
  return findElementByMarkerId(aiId)
}

/**
 * Staleness recovery: when an element_id is no longer on the page,
 * re-inject markers and find by matching role + name from the previous tree.
 */
export function recoverStaleElement(oldId: number): { element: HTMLElement; newId: number } | null {
  // Look up the old element's role and name
  const oldEntry = lastMarkedElements.find(e => e.id === oldId)
  if (!oldEntry) return null

  // Re-inject markers to get fresh element list
  const freshElements = injectMarkers()
  setLastMarkedElements(freshElements)
  removeMarkers()

  // Find by matching role + name (exact)
  const match = freshElements.find(e =>
    e.role === oldEntry.role && e.name === oldEntry.name
  )
  if (match) {
    try {
      const el = document.querySelector<HTMLElement>(match.selector)
      if (el) return { element: el, newId: match.id }
    } catch { /* ignore */ }
  }

  // Fuzzy match: same role, name contains or is contained
  const fuzzy = freshElements.find(e =>
    e.role === oldEntry.role && (
      e.name.toLowerCase().includes(oldEntry.name.toLowerCase()) ||
      oldEntry.name.toLowerCase().includes(e.name.toLowerCase())
    ) && e.name.length > 0
  )
  if (fuzzy) {
    try {
      const el = document.querySelector<HTMLElement>(fuzzy.selector)
      if (el) return { element: el, newId: fuzzy.id }
    } catch { /* ignore */ }
  }

  return null
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
