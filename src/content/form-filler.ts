/**
 * Form Filler — React/SPA-aware input simulation.
 * Fires the full event sequence required by modern JS frameworks.
 */

import type { FillAssignment } from '../shared/types'

// Cache the native setter to bypass React's Object.defineProperty override
const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
const nativeTextareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomDelay(): Promise<void> {
  return sleep(80 + Math.random() * 120) // 80–200ms per field
}

/** Simulate human-like value entry into a single field. */
export async function fillField(el: HTMLElement, value: string, inputType: string): Promise<boolean> {
  if (!el || !document.body.contains(el)) return false

  // Handle <select>
  if (el instanceof HTMLSelectElement) {
    // Try to find option by value or text content
    const option = [...el.options].find(o =>
      o.value.toLowerCase() === value.toLowerCase() ||
      o.text.toLowerCase() === value.toLowerCase()
    )
    if (option) {
      el.value = option.value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return !!option
  }

  // Handle contenteditable
  if (el.isContentEditable) {
    el.focus()
    document.execCommand('selectAll', false)
    document.execCommand('insertText', false, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await randomDelay()
    return true
  }

  // Handle checkbox / radio
  if (el instanceof HTMLInputElement && (inputType === 'checkbox' || inputType === 'radio')) {
    const boolVal = value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes'
    el.checked = boolVal
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  // Standard input / textarea
  const isTextarea = el instanceof HTMLTextAreaElement
  const setter = isTextarea ? nativeTextareaSetter : nativeInputSetter

  if (setter) {
    setter.call(el, value)
  } else {
    // Fallback
    ;(el as HTMLInputElement).value = value
  }

  // Reset React's internal value tracker so it registers the change
  const tracker = (el as HTMLInputElement & { _valueTracker?: { setValue(v: string): void } })._valueTracker
  if (tracker) tracker.setValue('')

  // Fire full event sequence
  el.dispatchEvent(new Event('focus', { bubbles: true }))
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('blur', { bubbles: true }))

  await randomDelay()
  return true
}

// ─── Public API ───────────────────────────────────────────────────────────────

interface FillResult {
  filled: number
  skipped: number
  errors: string[]
}

/**
 * Fill multiple fields from assignments. Handles dynamically revealed fields
 * by rescanning after each fill (up to 3 cycles).
 */
export async function fillAssignments(assignments: FillAssignment[]): Promise<FillResult> {
  const result: FillResult = { filled: 0, skipped: 0, errors: [] }

  for (let cycle = 0; cycle < 3; cycle++) {
    const remaining: FillAssignment[] = []

    for (const assignment of assignments) {
      const el = document.querySelector<HTMLElement>(assignment.selector)
      if (!el) {
        if (cycle < 2) {
          remaining.push(assignment) // retry in next cycle
        } else {
          result.skipped++
          result.errors.push(`Element not found: ${assignment.selector}`)
        }
        continue
      }

      try {
        const ok = await fillField(el, assignment.value, assignment.inputType)
        if (ok) result.filled++
        else result.skipped++
      } catch (err) {
        result.errors.push(`Error filling ${assignment.selector}: ${err}`)
        result.skipped++
      }
    }

    if (remaining.length === 0) break
    // Wait for dynamic fields to appear
    await sleep(400)
    assignments = remaining
  }

  return result
}

/** Highlight fields that were filled (brief green flash). */
export function highlightFilledFields(selectors: string[]): void {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) continue
    const prev = el.style.outline
    el.style.outline = '2px solid #22c55e'
    el.style.outlineOffset = '2px'
    setTimeout(() => {
      el.style.outline = prev
      el.style.outlineOffset = ''
    }, 1500)
  }
}
