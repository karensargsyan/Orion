/**
 * Inline compose assistant: offers context-aware AI-improved text.
 * Detects the environment (email, chat, search, social media, etc.)
 * and adapts the rewrite style accordingly.
 */

import { MSG } from '../shared/constants'
import { safeSendMessageAsync } from './runtime-safe'

const PANEL_ID = '__orion-compose-panel'
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

// ─── Context detection ──────────────────────────────────────────────────────

type ComposeContext =
  | 'email'
  | 'search'
  | 'chat'
  | 'social'
  | 'code'
  | 'form'
  | 'document'
  | 'comment'
  | 'general'

/** Detect the writing context from URL, page structure, and field attributes */
function detectComposeContext(el: HTMLElement): { context: ComposeContext; detail: string } {
  const url = location.href.toLowerCase()
  const host = location.hostname.toLowerCase()
  const title = document.title.toLowerCase()
  const fieldName = (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.name + el.id + el.placeholder : '') +
    (el.getAttribute('aria-label') ?? '')
  ).toLowerCase()

  // Email services
  if (
    host.includes('mail.google') || host.includes('outlook.live') || host.includes('outlook.office') ||
    host.includes('mail.yahoo') || host.includes('protonmail') || host.includes('tutanota') ||
    host.includes('zoho.com/mail') || host.includes('fastmail') || host.includes('icloud.com/mail') ||
    host.includes('mail.') || title.includes('inbox') || title.includes('compose') ||
    url.includes('/mail/') || url.includes('compose') ||
    fieldName.includes('subject') || fieldName.includes('compose') ||
    el.closest('[role="dialog"][aria-label*="mail" i], [role="dialog"][aria-label*="compose" i], .compose, .email-compose, [data-message-id]') !== null
  ) {
    const isSubject = fieldName.includes('subject')
    return { context: 'email', detail: isSubject ? 'email subject line' : 'email body' }
  }

  // Search engines
  if (
    host.includes('google.com') && (url.includes('/search') || fieldName.includes('search')) ||
    host.includes('bing.com') || host.includes('duckduckgo') || host.includes('yahoo.com/search') ||
    host.includes('brave.com/search') || host.includes('ecosia') ||
    el.closest('form[action*="search"], form[role="search"], [data-search]') !== null ||
    fieldName.includes('search') || el.getAttribute('type') === 'search'
  ) {
    return { context: 'search', detail: 'search query' }
  }

  // Chat & messaging apps
  if (
    host.includes('web.whatsapp') || host.includes('web.telegram') || host.includes('discord') ||
    host.includes('slack.com') || host.includes('teams.microsoft') || host.includes('messenger.com') ||
    host.includes('signal') || host.includes('element.io') || host.includes('matrix.to') ||
    host.includes('chat.') || title.includes('chat') ||
    el.closest('[data-testid*="message" i], [aria-label*="message" i], .chat-input, .message-input, [contenteditable][data-placeholder*="message" i]') !== null ||
    fieldName.includes('message') || fieldName.includes('chat')
  ) {
    return { context: 'chat', detail: 'instant message' }
  }

  // Social media
  if (
    host.includes('twitter.com') || host.includes('x.com') || host.includes('facebook.com') ||
    host.includes('instagram.com') || host.includes('linkedin.com') || host.includes('reddit.com') ||
    host.includes('threads.net') || host.includes('mastodon') || host.includes('bsky.') ||
    host.includes('tiktok.com') ||
    el.closest('[data-testid*="tweet" i], [aria-label*="post" i], [data-testid*="post" i]') !== null
  ) {
    const isComment = fieldName.includes('comment') || fieldName.includes('reply') ||
      el.closest('[data-testid*="reply" i], [aria-label*="comment" i], [aria-label*="reply" i]') !== null
    return { context: 'social', detail: isComment ? 'social media reply/comment' : 'social media post' }
  }

  // Code editors
  if (
    host.includes('github.com') || host.includes('gitlab.com') || host.includes('bitbucket.org') ||
    host.includes('codepen.io') || host.includes('codesandbox.io') || host.includes('stackblitz.com') ||
    host.includes('stackoverflow.com') ||
    el.closest('.CodeMirror, .monaco-editor, [data-mode-id], .ace_editor') !== null
  ) {
    const isIssue = url.includes('/issues') || url.includes('/pull') || url.includes('/merge')
    const isComment = fieldName.includes('comment') || el.closest('.comment, .review-comment, .timeline-comment') !== null
    if (isIssue) return { context: 'code', detail: 'issue/PR description' }
    if (isComment) return { context: 'comment', detail: 'code review comment' }
    return { context: 'code', detail: 'technical writing' }
  }

  // Comments on articles/blogs/forums
  if (
    fieldName.includes('comment') || fieldName.includes('reply') ||
    el.closest('.comment-form, .reply-form, #respond, [id*="comment"]') !== null ||
    host.includes('disqus.com') || host.includes('medium.com') || host.includes('wordpress')
  ) {
    return { context: 'comment', detail: 'article/blog comment' }
  }

  // Document editors
  if (
    host.includes('docs.google') || host.includes('notion.so') || host.includes('coda.io') ||
    host.includes('dropboxpaper') || host.includes('quip.com') || host.includes('confluence')
  ) {
    return { context: 'document', detail: 'document/note editing' }
  }

  // Contact/support forms
  if (
    el.closest('form') !== null && (
      fieldName.includes('contact') || fieldName.includes('inquiry') || fieldName.includes('feedback') ||
      fieldName.includes('support') || fieldName.includes('body') ||
      document.querySelector('form h1, form h2, form h3')?.textContent?.toLowerCase().includes('contact') ||
      title.includes('contact') || title.includes('support') || title.includes('feedback')
    )
  ) {
    return { context: 'form', detail: 'contact/support form' }
  }

  // Generic text area (long text field)
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) {
    return { context: 'general', detail: 'text composition' }
  }

  return { context: 'general', detail: 'text input' }
}

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
  if (el.closest('[data-orion-compose-ignore="1"]')) return false
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

  // Detect writing context for the AI
  const { context, detail } = detectComposeContext(el)

  // Skip search queries — user is searching, not composing
  if (context === 'search') return

  const res = await safeSendMessageAsync<{ ok?: boolean; improved?: string; error?: string }>({
    type: MSG.REQUEST_COMPOSE_REWRITE,
    text,
    url: location.href,
    composeContext: context,
    composeDetail: detail,
    pageTitle: document.title.slice(0, 100),
  })

  if (!res?.ok || !res.improved || res.improved.trim() === text.trim()) {
    removePanel()
    return
  }

  showPanel(el, text, res.improved.trim(), detail)
}

function showPanel(field: HTMLElement, original: string, improved: string, contextLabel?: string): void {
  removePanel()

  const rect = field.getBoundingClientRect()
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.setAttribute('data-orion-compose-ignore', '1')
  panel.style.cssText = `
    position:fixed;z-index:2147483642;left:${Math.min(rect.left, window.innerWidth - 340)}px;
    top:${Math.max(8, rect.top + window.scrollY - 8)}px;width:min(340px,calc(100vw - 16px));
    background:#1a1b26;border:1px solid #7c6ef5;border-radius:10px;
    box-shadow:0 8px 32px rgba(0,0,0,0.45);font:13px/1.45 system-ui,sans-serif;color:#e5e7eb;
    padding:10px 12px;
  `

  const title = document.createElement('div')
  title.innerHTML = `Suggested revision${contextLabel ? ` <span style="font-weight:400;color:#8b8fa3;font-size:11px">· ${contextLabel}</span>` : ''}`
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
