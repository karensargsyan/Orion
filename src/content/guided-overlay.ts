/**
 * Guided Overlay — lightweight highlight for elements the user should interact with.
 * Shows a pulsing glow + small tooltip. Fast and minimal.
 */

import { fillField } from './form-filler'
import { findElementByMarkerId, findElementByAIId } from './element-markers'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GuidedTarget {
  selector: string
  markerId?: number
  actionType: string
  instruction: string
  value?: string
  stepNumber: number
}

export interface GuidedClickResult {
  clicked: boolean
  skipped: boolean
  stopped: boolean
  selector: string
  value?: string
}

// ─── Constants ─────────────────────────────────────────────────────────────

const HIGHLIGHT_CLASS = '__orion-guided-highlight'
const TIP_ID = '__orion-guided-tip'
const STYLE_ID = '__orion-guided-styles'
const TIMEOUT_MS = 120_000

// ─── State ─────────────────────────────────────────────────────────────────

let activeCleanup: (() => void) | null = null

// ─── CSS ───────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @keyframes __orion-guided-pulse {
      0%, 100% {
        outline-color: rgba(99, 102, 241, 0.9);
        box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.3),
                    0 0 20px rgba(99, 102, 241, 0.15);
      }
      50% {
        outline-color: rgba(139, 92, 246, 1);
        box-shadow: 0 0 0 6px rgba(139, 92, 246, 0.35),
                    0 0 28px rgba(139, 92, 246, 0.2);
      }
    }

    .${HIGHLIGHT_CLASS} {
      outline: 3px solid rgba(99, 102, 241, 0.9) !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.3),
                  0 0 20px rgba(99, 102, 241, 0.15) !important;
      animation: __orion-guided-pulse 1.8s ease-in-out infinite !important;
      position: relative;
      z-index: auto;
    }

    #${TIP_ID} {
      position: fixed;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      pointer-events: auto;
      background: #1a1c25;
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: 10px;
      padding: 8px 12px;
      color: #e4e6ef;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      max-width: 320px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: __orion-tip-in 0.15s ease-out;
    }

    @keyframes __orion-tip-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    #${TIP_ID} .tip-text {
      font-size: 13px;
      font-weight: 500;
      color: #f1f5f9;
      flex: 1;
      line-height: 1.3;
    }

    #${TIP_ID} .tip-step {
      font-size: 10px;
      font-weight: 600;
      color: #818cf8;
      background: rgba(99, 102, 241, 0.12);
      padding: 2px 7px;
      border-radius: 8px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    #${TIP_ID} .tip-input {
      flex: 1;
      background: #272a36;
      border: 1px solid #3d4155;
      border-radius: 6px;
      color: #e4e6ef;
      padding: 6px 10px;
      font-size: 12px;
      outline: none;
      min-width: 100px;
    }
    #${TIP_ID} .tip-input:focus {
      border-color: #6366f1;
    }

    #${TIP_ID} .tip-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      color: #94a3b8;
      font-size: 13px;
      line-height: 1;
      flex-shrink: 0;
      transition: color 0.1s, background 0.1s;
    }
    #${TIP_ID} .tip-btn:hover { color: #f1f5f9; background: rgba(255,255,255,0.06); }
    #${TIP_ID} .tip-btn-fill {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      padding: 5px 10px;
      border-radius: 6px;
      font-weight: 500;
      font-size: 12px;
    }
    #${TIP_ID} .tip-btn-fill:hover { box-shadow: 0 2px 8px rgba(99,102,241,0.35); }
    #${TIP_ID} .tip-btn-stop { color: #f87171; }
    #${TIP_ID} .tip-btn-stop:hover { background: rgba(248,113,113,0.1); }
  `
  document.head.appendChild(style)
}

// ─── Public API ────────────────────────────────────────────────────────────

export function showGuidedHighlight(target: GuidedTarget): Promise<GuidedClickResult> {
  hideGuidedHighlight()
  injectStyles()

  return new Promise<GuidedClickResult>((resolve) => {
    const el = resolveElement(target)

    if (!el) {
      resolve({ clicked: false, skipped: true, stopped: false, selector: target.selector })
      return
    }

    // Scroll into view fast
    el.scrollIntoView({ behavior: 'auto', block: 'center' })

    // Apply highlight immediately (no scroll delay)
    requestAnimationFrame(() => {
      if (!el.isConnected) {
        resolve({ clicked: false, skipped: true, stopped: false, selector: target.selector })
        return
      }

      el.classList.add(HIGHLIGHT_CLASS)

      const isTypeAction = target.actionType === 'type' || target.actionType === 'fill_form' ||
        target.actionType === 'clear' || target.actionType === 'select_option'

      // Build lightweight tooltip
      const tip = buildTip(target, isTypeAction)
      positionTip(tip, el)
      document.body.appendChild(tip)

      let resolved = false
      const finish = (result: GuidedClickResult) => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(result)
      }

      // Click detection
      let clickHandler: ((e: MouseEvent) => void) | null = null
      if (!isTypeAction) {
        clickHandler = (e: MouseEvent) => {
          const clicked = e.target as HTMLElement
          if (el === clicked || el.contains(clicked)) {
            finish({ clicked: true, skipped: false, stopped: false, selector: target.selector })
          }
        }
        document.addEventListener('click', clickHandler, true)
      }

      // Button handlers
      const fillBtn = tip.querySelector('.tip-btn-fill') as HTMLButtonElement | null
      const skipBtn = tip.querySelector('.tip-btn-skip') as HTMLButtonElement | null
      const stopBtn = tip.querySelector('.tip-btn-stop') as HTMLButtonElement | null
      const input = tip.querySelector('.tip-input') as HTMLInputElement | null

      if (fillBtn && isTypeAction) {
        fillBtn.addEventListener('click', async () => {
          const value = input?.value ?? target.value ?? ''
          if (value.trim()) {
            const inputType = (el as HTMLInputElement).type || el.tagName.toLowerCase()
            await fillField(el, value.trim(), inputType)
            el.classList.remove(HIGHLIGHT_CLASS)
            el.style.outline = '3px solid #22c55e'
            el.style.outlineOffset = '3px'
            setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = '' }, 500)
          }
          finish({ clicked: true, skipped: false, stopped: false, selector: target.selector, value: input?.value })
        })
      }

      if (skipBtn) {
        skipBtn.addEventListener('click', () => {
          finish({ clicked: false, skipped: true, stopped: false, selector: target.selector })
        })
      }

      if (stopBtn) {
        stopBtn.addEventListener('click', () => {
          finish({ clicked: false, skipped: false, stopped: true, selector: target.selector })
        })
      }

      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') fillBtn?.click()
          if (e.key === 'Escape') finish({ clicked: false, skipped: true, stopped: false, selector: target.selector })
        })
        setTimeout(() => input.focus(), 50)
      }

      const timeoutId = setTimeout(() => {
        finish({ clicked: false, skipped: true, stopped: false, selector: target.selector })
      }, TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timeoutId)
        if (clickHandler) document.removeEventListener('click', clickHandler, true)
        el.classList.remove(HIGHLIGHT_CLASS)
        document.getElementById(TIP_ID)?.remove()
        activeCleanup = null
      }

      activeCleanup = cleanup
    })
  })
}

export function hideGuidedHighlight(): void {
  if (activeCleanup) {
    activeCleanup()
    activeCleanup = null
  }
  document.getElementById(TIP_ID)?.remove()
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS)
  })
}

// ─── Element Resolution ────────────────────────────────────────────────────

function resolveElement(target: GuidedTarget): HTMLElement | null {
  if (target.markerId !== undefined && target.markerId > 0) {
    const el = findElementByMarkerId(target.markerId) ?? findElementByAIId(target.markerId)
    if (el) return el
  }
  if (target.selector) {
    const el = document.querySelector<HTMLElement>(target.selector)
    if (el) return el
  }
  if (target.markerId !== undefined) {
    const el = document.querySelector<HTMLElement>(`[data-ai-id="${target.markerId}"]`)
    if (el) return el
  }
  return null
}

// ─── Tooltip Builder ──────────────────────────────────────────────────────

function buildTip(target: GuidedTarget, isTypeAction: boolean): HTMLDivElement {
  const tip = document.createElement('div')
  tip.id = TIP_ID

  const esc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  if (isTypeAction) {
    tip.innerHTML = `
      <span class="tip-step">${target.stepNumber}</span>
      <input class="tip-input" type="text" value="${esc(target.value ?? '')}" placeholder="Type here...">
      <button class="tip-btn tip-btn-fill">Fill</button>
      <button class="tip-btn tip-btn-skip" title="Skip">⏭</button>
      <button class="tip-btn tip-btn-stop" title="Stop">✕</button>
    `
  } else {
    tip.innerHTML = `
      <span class="tip-step">${target.stepNumber}</span>
      <span class="tip-text">${esc(target.instruction)}</span>
      <button class="tip-btn tip-btn-skip" title="Skip">⏭</button>
      <button class="tip-btn tip-btn-stop" title="Stop">✕</button>
    `
  }

  return tip
}

function positionTip(tip: HTMLDivElement, el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  const tipHeight = 44

  // Prefer above element
  let top: number
  if (rect.top > tipHeight + 8) {
    top = rect.top - tipHeight - 6
  } else {
    top = rect.bottom + 6
  }

  // Center on element, clamp to viewport
  let left = rect.left + (rect.width / 2) - 160
  left = Math.max(8, Math.min(left, window.innerWidth - 328))
  top = Math.max(8, Math.min(top, window.innerHeight - tipHeight - 8))

  tip.style.top = `${top}px`
  tip.style.left = `${left}px`
}
