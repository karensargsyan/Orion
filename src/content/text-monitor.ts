import { MSG } from '../shared/constants'
import { safeSendMessage } from './runtime-safe'

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let lastText = ''

const EDITABLE_SELECTORS = 'textarea, [contenteditable="true"], input[type="text"], input[type="email"]'
const MIN_TEXT_LENGTH = 20

export function setupTextMonitor(): void {
  document.addEventListener('input', onInput, true)
  document.addEventListener('focusout', onBlur, true)
}

function onInput(e: Event): void {
  const el = e.target as HTMLElement
  if (!isEditableElement(el)) return

  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    const text = getEditableText(el)
    if (text.length >= MIN_TEXT_LENGTH && text !== lastText) {
      lastText = text
      safeSendMessage({
        type: MSG.TEXT_SELECTED,
        text,
        isEditing: true,
        selector: getSelector(el),
      })
    }
  }, 2000)
}

function onBlur(e: FocusEvent): void {
  const el = e.target as HTMLElement
  if (!isEditableElement(el)) return

  const text = getEditableText(el)
  if (text.length >= MIN_TEXT_LENGTH) {
    safeSendMessage({
      type: MSG.TEXT_SELECTED,
      text,
      isEditing: true,
      selector: getSelector(el),
    })
  }
}

function isEditableElement(el: HTMLElement): boolean {
  if (el.isContentEditable) return true
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'email')) return true
  return false
}

function getEditableText(el: HTMLElement): string {
  if (el.isContentEditable) return el.innerText?.trim() ?? ''
  return (el as HTMLInputElement).value?.trim() ?? ''
}

function getSelector(el: HTMLElement): string {
  if (el.id) return `#${el.id}`
  if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`
  return el.tagName.toLowerCase()
}
