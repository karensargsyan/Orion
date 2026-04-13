/**
 * DOM Analyzer — builds a PageSnapshot from the current page.
 * Uses MutationObserver with debouncing to track DOM changes.
 */

import type { PageSnapshot, FormInfo, FormField, PageButton, PageLink, FieldOption } from '../shared/types'

// ─── Unique selector generation ───────────────────────────────────────────────

export function getUniqueSelector(el: Element): string {
  // Prefer id
  if (el.id) return `#${CSS.escape(el.id)}`

  // Prefer name attribute for form elements
  const name = el.getAttribute('name')
  if (name) {
    const tag = el.tagName.toLowerCase()
    const byName = document.querySelectorAll(`${tag}[name="${CSS.escape(name)}"]`)
    if (byName.length === 1) return `${tag}[name="${CSS.escape(name)}"]`
  }

  // Build path from element up to body
  const parts: string[] = []
  let current: Element | null = el
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase()
    const cls = [...current.classList].slice(0, 2).join('.')
    if (cls) selector += `.${cls.replace(/\s+/g, '.')}`
    const parent = current.parentElement
    if (parent) {
      const siblings = [...parent.children].filter(c => c.tagName === current!.tagName)
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1
        selector += `:nth-of-type(${idx})`
      }
    }
    parts.unshift(selector)
    current = current.parentElement
  }
  return parts.slice(-4).join(' > ') // limit depth
}

// ─── Label finder ─────────────────────────────────────────────────────────────

export function findLabel(el: Element): string {
  // aria-label
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return ariaLabel.trim()

  // aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy)
    if (labelEl) return labelEl.textContent?.trim() ?? ''
  }

  // <label for="id">
  const id = el.id
  if (id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
    if (label) return label.textContent?.trim() ?? ''
  }

  // Wrapping <label>
  const parentLabel = el.closest('label')
  if (parentLabel) {
    // Clone and remove the input to get just the label text
    const clone = parentLabel.cloneNode(true) as HTMLElement
    clone.querySelectorAll('input, select, textarea').forEach(c => c.remove())
    const text = clone.textContent?.trim()
    if (text) return text
  }

  // Placeholder as fallback
  return el.getAttribute('placeholder')?.trim() ?? ''
}

// ─── Form analysis ────────────────────────────────────────────────────────────

function isVisible(el: HTMLElement): boolean {
  if (el.hidden || el.offsetParent === null) return false
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

function analyzeForms(): FormInfo[] {
  const formEls = [
    ...document.querySelectorAll<HTMLElement>('form, [role="form"]'),
  ]

  // Also detect "implicit" forms (login boxes without <form>)
  if (formEls.length === 0) {
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="email"], input[type="password"]')
    if (inputs.length >= 1) {
      // Treat page body as implicit form
      return [{
        selector: 'body',
        action: location.href,
        method: 'post',
        fields: [...inputs].filter(isVisible).map(analyzeField),
      }]
    }
  }

  return formEls.map(form => {
    const fields = [...form.querySelectorAll<HTMLElement>('input, select, textarea, [contenteditable="true"]')]
      .filter(el => {
        if (!isVisible(el)) return false
        const input = el as HTMLInputElement
        return input.type !== 'hidden' && input.type !== 'submit' && input.type !== 'button'
          && input.type !== 'reset' && input.type !== 'image' && input.type !== 'file'
      })
      .map(analyzeField)

    return {
      selector: getUniqueSelector(form),
      action: (form as HTMLFormElement).action || location.href,
      method: (form as HTMLFormElement).method || 'get',
      fields,
    }
  })
}

function analyzeField(el: HTMLElement): FormField {
  const input = el as HTMLInputElement
  const field: FormField = {
    selector: getUniqueSelector(el),
    type: input.type || el.tagName.toLowerCase(),
    name: input.name || el.id || input.placeholder || '',
    label: findLabel(el),
    required: input.required ?? false,
    autocomplete: input.autocomplete || '',
    value: input.type === 'password' ? '' : (input.value || ''),
  }

  if (el instanceof HTMLSelectElement) {
    field.options = extractSelectOptions(el)
    field.value = el.value
  }

  if (input.type === 'checkbox' || input.type === 'radio') {
    field.checked = input.checked
    if (input.name) {
      field.groupName = input.name
      field.options = extractRadioCheckboxGroup(input)
    }
  }

  return field
}

function extractSelectOptions(select: HTMLSelectElement): FieldOption[] {
  return [...select.options].slice(0, 30).map(opt => ({
    value: opt.value,
    label: opt.text.trim(),
    selected: opt.selected,
  }))
}

function extractRadioCheckboxGroup(input: HTMLInputElement): FieldOption[] {
  if (!input.name) return []
  const group = document.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(input.name)}"]`)
  return [...group].slice(0, 30).map(el => ({
    value: el.value,
    label: findLabel(el) || el.value,
    selected: el.checked,
  }))
}

// ─── Heading analysis ─────────────────────────────────────────────────────────

function analyzeHeadings(): string[] {
  return [...document.querySelectorAll('h1, h2, h3')]
    .map(h => h.textContent?.trim() ?? '')
    .filter(t => t.length > 0 && t.length < 120)
    .slice(0, 8)
}

// ─── Button analysis ──────────────────────────────────────────────────────────

/** Detect if a button has primary/CTA styling via CSS class names */
function detectPrimaryButton(el: HTMLElement): boolean {
  const cls = (el.className ?? '').toString()
  return /\b(primary|cta|submit|main-action|send|checkout|btn-primary|btn-success|btn-danger)\b/i.test(cls)
}

function analyzeButtons(): PageButton[] {
  const buttons = [
    ...document.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"], [role="button"]'),
  ]
  return buttons
    .filter(isVisible)
    .map(btn => {
      const tag = btn.tagName.toUpperCase()
      const inp = btn as HTMLInputElement
      const form = btn.closest('form')
      const explicitType = btn.getAttribute('type')
      // A button is submit-type if it's input[type=submit], or a <button> inside a form
      // with type="submit" or no explicit type (default for <button> in a form is "submit")
      const isSubmitType = (tag === 'INPUT' && inp.type === 'submit') ||
        (tag === 'BUTTON' && !!form && (explicitType === 'submit' || !explicitType))
      return {
        selector: getUniqueSelector(btn),
        text: (btn.textContent?.trim() || inp.value || btn.getAttribute('aria-label') || '').slice(0, 60),
        role: btn.getAttribute('role') || btn.tagName.toLowerCase(),
        formAction: form?.action || undefined,
        isSubmitType,
        isPrimary: detectPrimaryButton(btn),
        ariaLabel: btn.getAttribute('aria-label') || undefined,
      }
    })
    .filter(b => b.text.length > 0)
    .slice(0, 20)
}

function analyzeInteractiveElements(): PageButton[] {
  const seen = new Set<Element>()
  const seenText = new Set<string>()
  const results: PageButton[] = []

  const roleEls = document.querySelectorAll<HTMLElement>(
    '[role="row"], [role="listitem"], [role="option"], [role="gridcell"], [role="treeitem"], [role="menuitem"], [role="tab"], [role="link"], tbody > tr, [tabindex], [onclick], [data-action], [jsaction]'
  )

  for (const el of roleEls) {
    if (seen.has(el) || !isVisible(el)) continue
    if (!isInteractiveCandidate(el)) continue

    const rawText = (el.textContent?.trim() ?? '').slice(0, 80).replace(/^\s+/gm, ' ')
    if (rawText.length < 3) continue

    const dedup = rawText.slice(0, 50)
    if (seenText.has(dedup)) continue

    seen.add(el)
    seenText.add(dedup)
    results.push({
      selector: getUniqueSelector(el),
      text: rawText,
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
    })
    if (results.length >= 15) return results
  }

  return results
}

const NON_INTERACTIVE_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'PATH',
  'META', 'LINK', 'HEAD', 'BR', 'HR', 'DEFS', 'CLIPPATH', 'TEMPLATE',
])

function isInteractiveCandidate(el: HTMLElement): boolean {
  if (NON_INTERACTIVE_TAGS.has(el.tagName)) return false
  if (el.closest('script, style, noscript, template')) return false

  const text = el.textContent?.trim() ?? ''
  if (text.length > 500) return false

  const t = text.trimStart()
  if (/^(\(function|var |const |let |\/\/|\/\*|\{|import |export |if\s*\(|try\s*\{|window\.)/.test(t)) return false

  return true
}

// ─── Link analysis ────────────────────────────────────────────────────────────

function analyzeLinks(): PageLink[] {
  const navEls = document.querySelectorAll<HTMLAnchorElement>('nav a, header a, [role="navigation"] a')
  const navHrefs = new Set([...navEls].map(a => a.href))

  return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter(a => isVisible(a) && a.href && !a.href.startsWith('javascript:'))
    .slice(0, 30)
    .map(a => ({
      href: a.href,
      text: (a.textContent?.trim() || a.title || '').slice(0, 80),
      isNav: navHrefs.has(a.href),
    }))
    .filter(l => l.text.length > 0)
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export function buildSnapshot(): PageSnapshot {
  return {
    url: location.href,
    title: document.title,
    timestamp: Date.now(),
    forms: analyzeForms(),
    buttons: [...analyzeButtons(), ...analyzeInteractiveElements()],
    links: analyzeLinks(),
    headings: analyzeHeadings(),
    metaDescription: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content?.trim() ?? '',
    language: document.documentElement.lang || navigator.language || '',
    readyState: document.readyState,
  }
}

export function snapshotChanged(a: PageSnapshot | null, b: PageSnapshot): boolean {
  if (!a) return true
  if (a.url !== b.url) return true
  if (a.forms.length !== b.forms.length) return true
  const aFields = a.forms.reduce((s, f) => s + f.fields.length, 0)
  const bFields = b.forms.reduce((s, f) => s + f.fields.length, 0)
  if (aFields !== bFields) return true
  if (a.headings.join() !== b.headings.join()) return true
  if (fieldValuesHash(a) !== fieldValuesHash(b)) return true
  return false
}

function fieldValuesHash(snap: PageSnapshot): string {
  let hash = 0
  for (const form of snap.forms) {
    for (const field of form.fields) {
      const val = field.value ?? ''
      for (let i = 0; i < val.length; i++) {
        hash = ((hash << 5) - hash + val.charCodeAt(i)) | 0
      }
      if (field.checked !== undefined) {
        hash = ((hash << 5) - hash + (field.checked ? 1 : 0)) | 0
      }
    }
  }
  return String(hash)
}
