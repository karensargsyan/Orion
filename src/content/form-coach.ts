/**
 * Form Coach — step-by-step guided form filling with highlight + floating card.
 * Injected into the page as part of the content script bundle.
 */
import { fillField } from './form-filler'

export interface CoachField {
  selector: string
  label: string
  type: string
  hint: string
  suggestedValue: string
  required: boolean
}

interface CoachState {
  fields: CoachField[]
  currentIndex: number
  filledCount: number
  skippedCount: number
}

const COACH_ID = '__orion-form-coach'
const HIGHLIGHT_CLASS = '__orion-coach-highlight'
const STYLE_ID = '__orion-coach-styles'

let state: CoachState | null = null
let onDone: ((summary: { filled: number; skipped: number; total: number }) => void) | null = null

// ─── CSS ─────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid #7c6ef5 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(124,110,245,0.25), 0 0 20px rgba(124,110,245,0.15) !important;
      transition: outline 0.3s ease, box-shadow 0.3s ease !important;
    }

    #${COACH_ID} {
      position: fixed;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      pointer-events: auto;
      transition: top 0.25s ease, left 0.25s ease;
    }

    #${COACH_ID} .coach-card {
      background: #1a1c25;
      border: 1px solid #2e3140;
      border-radius: 12px;
      padding: 16px;
      min-width: 280px;
      max-width: 360px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(124,110,245,0.15);
      color: #e4e6ef;
    }

    #${COACH_ID} .coach-field-name {
      font-size: 14px;
      font-weight: 600;
      color: #7c6ef5;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    #${COACH_ID} .coach-required {
      font-size: 10px;
      background: rgba(231,76,60,0.15);
      color: #e74c3c;
      padding: 1px 6px;
      border-radius: 4px;
    }

    #${COACH_ID} .coach-hint {
      font-size: 12px;
      color: #b8bcc8;
      margin-bottom: 10px;
      line-height: 1.5;
    }

    #${COACH_ID} .coach-value-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }

    #${COACH_ID} .coach-input {
      flex: 1;
      background: #272a36;
      border: 1px solid #3d4155;
      border-radius: 8px;
      color: #e4e6ef;
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
    }
    #${COACH_ID} .coach-input:focus {
      border-color: #7c6ef5;
    }

    #${COACH_ID} .coach-actions {
      display: flex;
      gap: 8px;
    }

    #${COACH_ID} .coach-accept {
      flex: 1;
      background: #7c6ef5;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    #${COACH_ID} .coach-accept:hover { background: #6a5dd8; }

    #${COACH_ID} .coach-skip {
      background: transparent;
      color: #b8bcc8;
      border: 1px solid #3d4155;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    #${COACH_ID} .coach-skip:hover { background: #272a36; color: #e4e6ef; }

    #${COACH_ID} .coach-progress {
      margin-top: 10px;
      font-size: 11px;
      color: #6b7084;
      text-align: center;
    }

    #${COACH_ID} .coach-progress-bar {
      height: 3px;
      background: #2e3140;
      border-radius: 2px;
      margin-top: 6px;
      overflow: hidden;
    }
    #${COACH_ID} .coach-progress-fill {
      height: 100%;
      background: #7c6ef5;
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    #${COACH_ID} .coach-filled-badge {
      display: inline-block;
      font-size: 11px;
      background: rgba(34,197,94,0.15);
      color: #22c55e;
      padding: 2px 8px;
      border-radius: 4px;
      margin-top: 4px;
    }

    #${COACH_ID} .coach-header {
      font-size: 12px;
      color: #7c6ef5;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid #2e3140;
      text-align: center;
      font-weight: 500;
    }

    #${COACH_ID} .coach-step-badge {
      font-size: 10px;
      background: rgba(124,110,245,0.15);
      color: #7c6ef5;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }

    #${COACH_ID} .coach-fill-all {
      background: transparent;
      color: #7c6ef5;
      border: 1px solid rgba(124,110,245,0.3);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
    }
    #${COACH_ID} .coach-fill-all:hover { background: rgba(124,110,245,0.1); }
  `
  document.head.appendChild(style)
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startCoach(
  fields: CoachField[],
  done: (summary: { filled: number; skipped: number; total: number }) => void
): void {
  cleanup()
  injectStyles()

  state = {
    fields,
    currentIndex: 0,
    filledCount: 0,
    skippedCount: 0,
  }
  onDone = done

  showCurrentField()
}

export function cleanup(): void {
  document.getElementById(COACH_ID)?.remove()
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS)
  })
  state = null
  onDone = null
}

// ─── Internal ────────────────────────────────────────────────────────────────

function showCurrentField(): void {
  if (!state) return
  if (state.currentIndex >= state.fields.length) {
    finish()
    return
  }

  const field = state.fields[state.currentIndex]
  const el = document.querySelector<HTMLElement>(field.selector)

  if (!el) {
    // Skip missing elements
    state.skippedCount++
    state.currentIndex++
    showCurrentField()
    return
  }

  // Remove previous highlights
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(e => e.classList.remove(HIGHLIGHT_CLASS))

  // Highlight current field
  el.classList.add(HIGHLIGHT_CLASS)
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })

  // Wait for scroll to finish, then position the card
  setTimeout(() => positionCard(el, field), 350)
}

function positionCard(el: HTMLElement, field: CoachField): void {
  if (!state) return

  // Remove existing card
  document.getElementById(COACH_ID)?.remove()

  const rect = el.getBoundingClientRect()
  const card = document.createElement('div')
  card.id = COACH_ID

  const isSelect = field.type === 'select' || field.type === 'select-one'
  const inputType = isSelect ? 'text' : (field.type === 'password' ? 'password' : 'text')
  const progress = state.currentIndex + 1
  const total = state.fields.length
  const pct = Math.round((progress / total) * 100)

  card.innerHTML = `
    <div class="coach-card">
      ${progress === 1 ? '<div class="coach-header">Orion will help fill this form field by field</div>' : ''}
      <div class="coach-field-name">
        <span class="coach-step-badge">Step ${progress} of ${total}</span>
        ${escHtml(field.label || 'Field')}
        ${field.required ? '<span class="coach-required">Required</span>' : ''}
      </div>
      <div class="coach-hint">${escHtml(field.hint || 'Fill in this field')}</div>
      <div class="coach-value-row">
        <input class="coach-input" type="${inputType}" value="${escAttr(field.suggestedValue || '')}" placeholder="Enter value...">
      </div>
      <div class="coach-actions">
        <button class="coach-accept">\u2713 Fill</button>
        <button class="coach-skip">Skip \u2192</button>
        ${(total - progress) >= 2 ? '<button class="coach-fill-all">Fill all remaining</button>' : ''}
      </div>
      <div class="coach-progress">
        <div class="coach-progress-bar"><div class="coach-progress-fill" style="width:${pct}%"></div></div>
      </div>
    </div>
  `

  // Position above the field, or below if not enough space above
  const spaceAbove = rect.top
  const cardHeight = 220 // estimated
  let top: number
  if (spaceAbove > cardHeight + 10) {
    top = rect.top + window.scrollY - cardHeight - 8
  } else {
    top = rect.bottom + window.scrollY + 8
  }
  const left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 380))

  card.style.top = `${top}px`
  card.style.left = `${left}px`
  card.style.position = 'absolute'

  document.body.appendChild(card)

  // Wire events
  const acceptBtn = card.querySelector('.coach-accept') as HTMLButtonElement
  const skipBtn = card.querySelector('.coach-skip') as HTMLButtonElement
  const input = card.querySelector('.coach-input') as HTMLInputElement

  acceptBtn.addEventListener('click', () => acceptField(input.value))
  skipBtn.addEventListener('click', () => skipField())

  // Fill all remaining — auto-fill from current index onward
  const fillAllBtn = card.querySelector('.coach-fill-all') as HTMLButtonElement | null
  if (fillAllBtn) {
    fillAllBtn.addEventListener('click', () => fillAllRemaining())
  }

  // Enter key on input = accept
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') acceptField(input.value)
    if (e.key === 'Escape') skipField()
  })

  // Focus the input so user can type immediately
  input.focus()
  input.select()
}

async function acceptField(value: string): Promise<void> {
  if (!state) return
  const field = state.fields[state.currentIndex]
  const el = document.querySelector<HTMLElement>(field.selector)

  if (el && value.trim()) {
    const inputType = (el as HTMLInputElement).type || el.tagName.toLowerCase()
    await fillField(el, value.trim(), inputType)

    // Flash green on the field
    el.classList.remove(HIGHLIGHT_CLASS)
    el.style.outline = '2px solid #22c55e'
    el.style.outlineOffset = '2px'
    setTimeout(() => {
      el.style.outline = ''
      el.style.outlineOffset = ''
    }, 800)

    state.filledCount++
  } else {
    state.skippedCount++
  }

  state.currentIndex++
  showCurrentField()
}

function skipField(): void {
  if (!state) return

  const field = state.fields[state.currentIndex]
  const el = document.querySelector<HTMLElement>(field.selector)
  if (el) el.classList.remove(HIGHLIGHT_CLASS)

  state.skippedCount++
  state.currentIndex++
  showCurrentField()
}

async function fillAllRemaining(): Promise<void> {
  if (!state) return

  // Remove the coach card UI
  document.getElementById(COACH_ID)?.remove()

  // Fill all remaining fields from current index onwards
  for (let i = state.currentIndex; i < state.fields.length; i++) {
    const field = state.fields[i]
    const el = document.querySelector<HTMLElement>(field.selector)
    if (el) el.classList.remove(HIGHLIGHT_CLASS)

    if (el && field.suggestedValue) {
      const inputType = (el as HTMLInputElement).type || el.tagName.toLowerCase()
      await fillField(el, field.suggestedValue, inputType)
      state.filledCount++

      // Brief flash green
      el.style.outline = '2px solid #22c55e'
      el.style.outlineOffset = '2px'
      setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = '' }, 600)

      // Small delay between fields for visual feedback
      await new Promise(r => setTimeout(r, 150))
    } else {
      state.skippedCount++
    }
  }

  state.currentIndex = state.fields.length
  finish()
}

function finish(): void {
  if (!state) return
  const summary = {
    filled: state.filledCount,
    skipped: state.skippedCount,
    total: state.fields.length,
  }

  cleanup()

  if (onDone) onDone(summary)
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
