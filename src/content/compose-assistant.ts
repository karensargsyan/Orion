/**
 * Inline compose assistant: offers AI-improved text for emails / contact forms.
 * User clicks Accept to replace draft text.
 */

import { MSG } from '../shared/constants'
import { safeSendMessageAsync } from './runtime-safe'

const PANEL_ID = '__localai-compose-panel'
const MIN_CHARS = 28
const DEBOUNCE_MS = 3200
const COOLDOWN_MS = 45_000

let lastRequestAt = 0
const debouncers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

const COMPOSE_SELECTORS = [
  'textarea',
  '[contenteditable="true"]',
  'input[type="text"][name*="subject" i]',
  'input[type="email"]',
  'input[name*="message" i]',
  'input[name*="body" i]',
].join(', ')

export function setupComposeAssistant(): void {
  document.addEventListener('input', onInput, true)
}

function onInput(e: Event): void {
  const el = e.target as HTMLElement
  if (!isComposeField(el)) return

  const prev = debouncers.get(el)
  if (prev) clearTimeout(prev)

  debouncers.set(
    el,
    setTimeout(() => void maybeRequestRewrite(el), DEBOUNCE_MS)
  )
}

function isComposeField(el: HTMLElement): boolean {
  if (el.closest('[data-localai-compose-ignore="1"]')) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el.isContentEditable) return true
  if (el instanceof HTMLInputElement) {
    const t = el.type
    if (t === 'text' || t === 'email' || t === 'search') {
      const n = (el.name + el.id + el.placeholder).toLowerCase()
      return /subject|message|body|compose|reply|contact|email|name/.test(n) || el.offsetHeight > 36
    }
  }
  return false
}

function getFieldText(el: HTMLElement): string {
  if (el.isContentEditable) return el.innerText?.trim() ?? ''
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value?.trim() ?? ''
  return ''
}

function setFieldText(el: HTMLElement, text: string): void {
  if (el.isContentEditable) {
    el.focus()
    el.innerText = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    return
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus()
    el.value = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
}

async function maybeRequestRewrite(el: HTMLElement): Promise<void> {
  const text = getFieldText(el)
  if (text.length < MIN_CHARS) return
  if (Date.now() - lastRequestAt < COOLDOWN_MS) return

  lastRequestAt = Date.now()

  const res = await safeSendMessageAsync<{ ok?: boolean; improved?: string; error?: string }>({
    type: MSG.REQUEST_COMPOSE_REWRITE,
    text,
    url: location.href,
  })

  if (!res?.ok || !res.improved || res.improved.trim() === text.trim()) {
    removePanel()
    return
  }

  showPanel(el, text, res.improved.trim())
}

function showPanel(field: HTMLElement, original: string, improved: string): void {
  removePanel()

  const rect = field.getBoundingClientRect()
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.setAttribute('data-localai-compose-ignore', '1')
  panel.style.cssText = `
    position:fixed;z-index:2147483642;left:${Math.min(rect.left, window.innerWidth - 340)}px;
    top:${Math.max(8, rect.top + window.scrollY - 8)}px;width:min(340px,calc(100vw - 16px));
    background:#1a1b26;border:1px solid #7c6ef5;border-radius:10px;
    box-shadow:0 8px 32px rgba(0,0,0,0.45);font:13px/1.45 system-ui,sans-serif;color:#e5e7eb;
    padding:10px 12px;
  `

  const title = document.createElement('div')
  title.textContent = 'Suggested revision'
  title.style.cssText = 'font-weight:600;margin-bottom:8px;color:#a5b4fc;font-size:12px'

  const preview = document.createElement('div')
  preview.textContent = improved.slice(0, 900) + (improved.length > 900 ? '…' : '')
  preview.style.cssText = 'max-height:140px;overflow:auto;margin-bottom:10px;white-space:pre-wrap;word-break:break-word'

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = 'Dismiss'
  dismiss.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#d1d5db;cursor:pointer'

  const accept = document.createElement('button')
  accept.type = 'button'
  accept.textContent = 'Accept'
  accept.style.cssText = 'padding:6px 14px;border-radius:6px;border:none;background:#7c6ef5;color:#fff;cursor:pointer;font-weight:600'

  dismiss.addEventListener('click', () => removePanel())
  accept.addEventListener('click', () => {
    setFieldText(field, improved)
    removePanel()
  })

  row.appendChild(dismiss)
  row.appendChild(accept)
  panel.appendChild(title)
  panel.appendChild(preview)
  panel.appendChild(row)
  document.body.appendChild(panel)
}

function removePanel(): void {
  document.getElementById(PANEL_ID)?.remove()
}
