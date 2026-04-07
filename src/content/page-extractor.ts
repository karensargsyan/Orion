import type { PageSnapshot } from '../shared/types'

const EMAIL_SELECTORS = [
  '.adn.ads', '.ii.gt', '.message-body', '.email-content',
  '[data-message-id]', '.mail-message-body', '.ReadMsgBody',
  '.WordSection1', '[role="main"] .message',
]

const CHAT_SELECTORS = [
  '[data-testid="msg-container"]', '.message-list', '.chat-message',
  '.c-message__body', '.msg-content', '[class*="MessageBody"]',
  '.text-msg', '._21Ahp', '.message-in', '.message-out',
]

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK',
  'HEAD', 'BR', 'HR', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME',
])

export function extractPageText(maxLength = 8000): string {
  const contentEl = findMainContent()
  const text = contentEl
    ? getTextContent(contentEl, maxLength)
    : getTextContent(document.body, maxLength)
  return text.trim()
}

export function extractVisibleText(maxLength = 4000): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  let totalLen = 0

  while (walker.nextNode()) {
    const node = walker.currentNode
    const el = node.parentElement
    if (!el || SKIP_TAGS.has(el.tagName)) continue
    if (!isInViewport(el)) continue

    const text = (node.textContent ?? '').trim()
    if (text.length < 2) continue

    parts.push(text)
    totalLen += text.length
    if (totalLen >= maxLength) break
  }

  return parts.join(' ').slice(0, maxLength)
}

export function extractSelectedText(): string {
  return window.getSelection()?.toString()?.trim() ?? ''
}

export function extractEmailContent(): string | null {
  for (const sel of EMAIL_SELECTORS) {
    const els = document.querySelectorAll(sel)
    if (els.length > 0) {
      return Array.from(els).map(el => getTextContent(el, 3000)).join('\n---\n').slice(0, 8000)
    }
  }
  return null
}

export function extractChatContent(): string | null {
  for (const sel of CHAT_SELECTORS) {
    const els = document.querySelectorAll(sel)
    if (els.length > 0) {
      return Array.from(els)
        .slice(-50)
        .map(el => getTextContent(el, 500))
        .join('\n')
        .slice(0, 8000)
    }
  }
  return null
}

export function isEmailPage(): boolean {
  const url = location.href.toLowerCase()
  return url.includes('mail.google.com') ||
    url.includes('outlook.live.com') ||
    url.includes('outlook.office') ||
    url.includes('mail.yahoo.com') ||
    url.includes('mail.') ||
    url.includes('/mail/') ||
    document.querySelector('[role="main"] [data-message-id]') !== null
}

export function isChatPage(): boolean {
  const url = location.href.toLowerCase()
  return url.includes('web.whatsapp.com') ||
    url.includes('app.slack.com') ||
    url.includes('teams.microsoft.com') ||
    url.includes('discord.com') ||
    url.includes('messenger.com') ||
    url.includes('telegram.org')
}

function findMainContent(): Element | null {
  const candidates = [
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.querySelector('article'),
    document.querySelector('.content'),
    document.querySelector('#content'),
  ]
  return candidates.find(el => el !== null) ?? null
}

function getTextContent(el: Element | Node, maxLen: number): string {
  const parts: string[] = []
  let totalLen = 0

  const walk = (node: Node) => {
    if (totalLen >= maxLen) return
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').trim()
      if (text.length > 1) {
        parts.push(text)
        totalLen += text.length
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const tag = (node as Element).tagName
    if (SKIP_TAGS.has(tag)) return
    for (const child of Array.from(node.childNodes)) {
      walk(child)
      if (totalLen >= maxLen) return
    }
  }

  walk(el)
  return parts.join(' ').slice(0, maxLen)
}

function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.top < window.innerHeight && rect.bottom > 0 &&
    rect.left < window.innerWidth && rect.right > 0
}
