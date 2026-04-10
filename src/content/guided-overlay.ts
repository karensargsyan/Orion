/**
 * Guided Overlay — highlights elements for the user to click instead of
 * auto-clicking. Shows a beautiful pulsing glow, instruction card, and
 * arrow pointer. Returns a Promise that resolves when the user acts.
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
const OVERLAY_ID = '__orion-guided-overlay'
const ARROW_ID = '__orion-guided-arrow'
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
                    0 0 24px rgba(99, 102, 241, 0.2),
                    0 0 48px rgba(99, 102, 241, 0.1);
      }
      50% {
        outline-color: rgba(139, 92, 246, 1);
        box-shadow: 0 0 0 6px rgba(139, 92, 246, 0.4),
                    0 0 32px rgba(139, 92, 246, 0.3),
                    0 0 64px rgba(139, 92, 246, 0.15);
      }
    }

    .${HIGHLIGHT_CLASS} {
      outline: 3px solid rgba(99, 102, 241, 0.9) !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.3),
                  0 0 24px rgba(99, 102, 241, 0.2),
                  0 0 48px rgba(99, 102, 241, 0.1) !important;
      animation: __orion-guided-pulse 2s ease-in-out infinite !important;
      transition: outline 0.3s ease !important;
      position: relative;
      z-index: auto;
    }

    #${OVERLAY_ID} {
      position: fixed;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      pointer-events: auto;
      transition: top 0.25s ease, left 0.25s ease, opacity 0.2s ease;
    }

    #${OVERLAY_ID} .guided-card {
      background: #1a1c25;
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 14px;
      padding: 16px 18px;
      min-width: 260px;
      max-width: 380px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5),
                  0 0 0 1px rgba(99, 102, 241, 0.1),
                  0 0 24px rgba(99, 102, 241, 0.08);
      color: #e4e6ef;
    }

    #${OVERLAY_ID} .guided-step-badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      padding: 2px 10px;
      border-radius: 10px;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    #${OVERLAY_ID} .guided-instruction {
      font-size: 15px;
      font-weight: 500;
      color: #f1f5f9;
      margin-bottom: 12px;
      line-height: 1.5;
    }

    #${OVERLAY_ID} .guided-hint {
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 12px;
      line-height: 1.4;
    }

    #${OVERLAY_ID} .guided-input-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }

    #${OVERLAY_ID} .guided-input {
      flex: 1;
      background: #272a36;
      border: 1px solid #3d4155;
      border-radius: 8px;
      color: #e4e6ef;
      padding: 9px 12px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    #${OVERLAY_ID} .guided-input:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
    }

    #${OVERLAY_ID} .guided-actions {
      display: flex;
      gap: 8px;
    }

    #${OVERLAY_ID} .guided-btn-primary {
      flex: 1;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 9px 16px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.1s, box-shadow 0.15s;
    }
    #${OVERLAY_ID} .guided-btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    }
    #${OVERLAY_ID} .guided-btn-primary:active {
      transform: translateY(0);
    }

    #${OVERLAY_ID} .guided-btn-skip {
      background: transparent;
      color: #94a3b8;
      border: 1px solid #3d4155;
      border-radius: 8px;
      padding: 9px 14px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    #${OVERLAY_ID} .guided-btn-skip:hover {
      background: #272a36;
      color: #e4e6ef;
    }

    #${OVERLAY_ID} .guided-btn-stop {
      background: transparent;
      color: #f87171;
      border: 1px solid rgba(248, 113, 113, 0.3);
      border-radius: 8px;
      padding: 9px 14px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.15s;
    }
    #${OVERLAY_ID} .guided-btn-stop:hover {
      background: rgba(248, 113, 113, 0.1);
    }

    #${ARROW_ID} {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      transition: all 0.25s ease;
    }
  `
  document.head.appendChild(style)
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Highlight an element and wait for user to click it (or skip/stop).
 * Returns a Promise that resolves when the user acts.
 */
export function showGuidedHighlight(target: GuidedTarget): Promise<GuidedClickResult> {
  // Clean up any previous highlight
  hideGuidedHighlight()
  injectStyles()

  return new Promise<GuidedClickResult>((resolve) => {
    // Find the target element
    const el = resolveElement(target)

    if (!el) {
      // Element not found — auto-skip
      resolve({ clicked: false, skipped: true, stopped: false, selector: target.selector })
      return
    }

    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // Apply highlight after scroll animation
    setTimeout(() => {
      if (!el.isConnected) {
        resolve({ clicked: false, skipped: true, stopped: false, selector: target.selector })
        return
      }

      // Add pulsing highlight class
      el.classList.add(HIGHLIGHT_CLASS)

      // Determine if this is a type/fill action
      const isTypeAction = target.actionType === 'type' || target.actionType === 'fill_form' ||
        target.actionType === 'clear' || target.actionType === 'select_option'

      // Build and position the instruction card
      const card = buildCard(target, isTypeAction)
      positionCard(card, el)
      document.body.appendChild(card)

      // Draw arrow from card to element
      const arrow = buildArrow(card, el)
      if (arrow) document.body.appendChild(arrow)

      let resolved = false
      const finish = (result: GuidedClickResult) => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(result)
      }

      // ── Click detection (for click actions) ──
      let clickHandler: ((e: MouseEvent) => void) | null = null
      if (!isTypeAction) {
        clickHandler = (e: MouseEvent) => {
          const clicked = e.target as HTMLElement
          if (el === clicked || el.contains(clicked)) {
            // User clicked the highlighted element — let it propagate
            finish({ clicked: true, skipped: false, stopped: false, selector: target.selector })
          }
        }
        document.addEventListener('click', clickHandler, true)
      }

      // ── Button event handlers ──
      const fillBtn = card.querySelector('.guided-btn-primary') as HTMLButtonElement | null
      const skipBtn = card.querySelector('.guided-btn-skip') as HTMLButtonElement | null
      const stopBtn = card.querySelector('.guided-btn-stop') as HTMLButtonElement | null
      const input = card.querySelector('.guided-input') as HTMLInputElement | null

      if (fillBtn && isTypeAction) {
        fillBtn.addEventListener('click', async () => {
          const value = input?.value ?? target.value ?? ''
          if (value.trim()) {
            const inputType = (el as HTMLInputElement).type || el.tagName.toLowerCase()
            await fillField(el, value.trim(), inputType)
            // Flash green on success
            el.classList.remove(HIGHLIGHT_CLASS)
            el.style.outline = '3px solid #22c55e'
            el.style.outlineOffset = '3px'
            setTimeout(() => {
              el.style.outline = ''
              el.style.outlineOffset = ''
            }, 600)
          }
          finish({ clicked: true, skipped: false, stopped: false, selector: target.selector, value: input?.value })
        })
      } else if (fillBtn && !isTypeAction) {
        // For click actions, the primary button is "Click for me"
        fillBtn.addEventListener('click', () => {
          el.click()
          finish({ clicked: true, skipped: false, stopped: false, selector: target.selector })
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
          if (e.key === 'Escape') {
            finish({ clicked: false, skipped: true, stopped: false, selector: target.selector })
          }
        })
        // Auto-focus after a short delay
        setTimeout(() => input.focus(), 100)
      }

      // ── Timeout ──
      const timeoutId = setTimeout(() => {
        finish({ clicked: false, skipped: true, stopped: false, selector: target.selector })
      }, TIMEOUT_MS)

      // ── Cleanup function ──
      const cleanup = () => {
        clearTimeout(timeoutId)
        if (clickHandler) document.removeEventListener('click', clickHandler, true)
        el.classList.remove(HIGHLIGHT_CLASS)
        document.getElementById(OVERLAY_ID)?.remove()
        document.getElementById(ARROW_ID)?.remove()
        activeCleanup = null
      }

      activeCleanup = cleanup
    }, 350) // wait for scroll
  })
}

/** Remove all guided overlay elements */
export function hideGuidedHighlight(): void {
  if (activeCleanup) {
    activeCleanup()
    activeCleanup = null
  }
  // Fallback cleanup
  document.getElementById(OVERLAY_ID)?.remove()
  document.getElementById(ARROW_ID)?.remove()
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS)
  })
}

// ─── Element Resolution ────────────────────────────────────────────────────

function resolveElement(target: GuidedTarget): HTMLElement | null {
  // 1. Try marker ID
  if (target.markerId !== undefined && target.markerId > 0) {
    const el = findElementByMarkerId(target.markerId) ?? findElementByAIId(target.markerId)
    if (el) return el
  }

  // 2. Try CSS selector
  if (target.selector) {
    const el = document.querySelector<HTMLElement>(target.selector)
    if (el) return el
  }

  // 3. Try data-ai-id
  if (target.markerId !== undefined) {
    const el = document.querySelector<HTMLElement>(`[data-ai-id="${target.markerId}"]`)
    if (el) return el
  }

  return null
}

// ─── Card Builder ──────────────────────────────────────────────────────────

function buildCard(target: GuidedTarget, isTypeAction: boolean): HTMLDivElement {
  const card = document.createElement('div')
  card.id = OVERLAY_ID

  const actionVerb = getActionVerb(target.actionType)
  const hintText = isTypeAction
    ? 'Edit the value below and click Fill, or skip this step.'
    : 'Click the highlighted element, or use the buttons below.'

  let inputHtml = ''
  if (isTypeAction) {
    inputHtml = `
      <div class="guided-input-row">
        <input class="guided-input" type="text"
          value="${escAttr(target.value ?? '')}"
          placeholder="Enter value...">
      </div>
    `
  }

  const primaryLabel = isTypeAction ? 'Fill' : 'Click for me'

  card.innerHTML = `
    <div class="guided-card">
      <div class="guided-step-badge">Step ${target.stepNumber}</div>
      <div class="guided-instruction">${actionVerb} ${escHtml(target.instruction)}</div>
      <div class="guided-hint">${hintText}</div>
      ${inputHtml}
      <div class="guided-actions">
        <button class="guided-btn-primary">${primaryLabel}</button>
        <button class="guided-btn-skip">Skip</button>
        <button class="guided-btn-stop">Stop</button>
      </div>
    </div>
  `

  return card
}

function getActionVerb(actionType: string): string {
  switch (actionType) {
    case 'click': return ''
    case 'type': return ''
    case 'select_option': return ''
    case 'check': case 'toggle': return ''
    case 'hover': return ''
    case 'doubleclick': return ''
    case 'focus': return ''
    case 'clear': return ''
    default: return ''
  }
}

// ─── Card Positioning ──────────────────────────────────────────────────────

function positionCard(card: HTMLDivElement, el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  const cardHeight = 200 // estimated
  const cardWidth = 340

  // Prefer above the element
  let top: number
  if (rect.top > cardHeight + 16) {
    top = rect.top - cardHeight - 12
  } else {
    top = rect.bottom + 12
  }

  // Horizontal: center on element, but clamp to viewport
  let left = rect.left + (rect.width / 2) - (cardWidth / 2)
  left = Math.max(12, Math.min(left, window.innerWidth - cardWidth - 12))

  // Clamp top to viewport
  top = Math.max(12, Math.min(top, window.innerHeight - cardHeight - 12))

  card.style.top = `${top}px`
  card.style.left = `${left}px`
}

// ─── Arrow Pointer ─────────────────────────────────────────────────────────

function buildArrow(card: HTMLDivElement, el: HTMLElement): SVGSVGElement | null {
  const rect = el.getBoundingClientRect()
  const elCenterX = rect.left + rect.width / 2
  const elCenterY = rect.top + rect.height / 2

  // Wait for card to be in DOM to get its position
  // We'll use the planned position from the card's style
  const cardTop = parseFloat(card.style.top)
  const cardLeft = parseFloat(card.style.left)
  const cardWidth = 340
  const cardHeight = 200

  const isAbove = cardTop + cardHeight < rect.top
  const cardCenterX = cardLeft + cardWidth / 2
  const arrowStartY = isAbove ? cardTop + cardHeight : cardTop
  const arrowEndY = isAbove ? rect.top - 4 : rect.bottom + 4

  // Don't draw arrow if too close
  if (Math.abs(arrowEndY - arrowStartY) < 20) return null

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.id = ARROW_ID

  const minX = Math.min(cardCenterX, elCenterX) - 10
  const maxX = Math.max(cardCenterX, elCenterX) + 10
  const minY = Math.min(arrowStartY, arrowEndY) - 10
  const maxY = Math.max(arrowStartY, arrowEndY) + 10

  svg.setAttribute('width', `${maxX - minX}`)
  svg.setAttribute('height', `${maxY - minY}`)
  svg.style.cssText = `
    position: fixed;
    left: ${minX}px;
    top: ${minY}px;
    z-index: 2147483646;
    pointer-events: none;
    overflow: visible;
  `

  // Curved path from card to element
  const startX = cardCenterX - minX
  const startY = arrowStartY - minY
  const endX = elCenterX - minX
  const endY = arrowEndY - minY
  const midY = (startY + endY) / 2

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`)
  path.setAttribute('stroke', 'rgba(99, 102, 241, 0.5)')
  path.setAttribute('stroke-width', '2')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke-dasharray', '6 4')

  // Arrowhead
  const arrowSize = 8
  const angle = Math.atan2(endY - midY, endX - endX) // pointing down/up
  const arrowAngle = isAbove ? Math.PI / 2 : -Math.PI / 2

  const arrow1X = endX - arrowSize * Math.cos(arrowAngle - 0.5)
  const arrow1Y = endY - arrowSize * Math.sin(arrowAngle - 0.5)
  const arrow2X = endX - arrowSize * Math.cos(arrowAngle + 0.5)
  const arrow2Y = endY - arrowSize * Math.sin(arrowAngle + 0.5)

  const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
  arrowHead.setAttribute('points', `${endX},${endY} ${arrow1X},${arrow1Y} ${arrow2X},${arrow2Y}`)
  arrowHead.setAttribute('fill', 'rgba(99, 102, 241, 0.6)')

  svg.appendChild(path)
  svg.appendChild(arrowHead)

  return svg
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
