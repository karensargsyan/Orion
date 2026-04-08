const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK',
  'HEAD', 'BR', 'HR', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME',
])

const SEMANTIC_CONTAINERS = [
  '[role="main"]', 'main', 'article', '[role="feed"]',
  '[role="list"]', '[role="grid"]', '[role="table"]',
  '[role="tabpanel"]', '[role="dialog"]',
]

const LANDMARK_SELECTORS: Array<[string, string]> = [
  ['nav, [role="navigation"]', 'nav'],
  ['main, [role="main"]', 'main'],
  ['aside, [role="complementary"]', 'aside'],
  ['footer, [role="contentinfo"]', 'footer'],
  ['header, [role="banner"]', 'header'],
  ['[role="search"]', 'search'],
  ['form, [role="form"]', 'form'],
  ['[role="dialog"], [role="alertdialog"], dialog', 'dialog'],
  ['[role="feed"]', 'feed'],
  ['[role="list"], ul, ol', 'list'],
  ['[role="grid"], [role="table"], table', 'grid'],
]

// ─── Generic text extraction ─────────────────────────────────────────────────

export function extractPageText(maxLength = 8000): string {
  const contentEl = findMainContent()
  const text = contentEl
    ? getTextContent(contentEl, maxLength)
    : getTextContent(document.body, maxLength)
  return text.trim()
}

/** Full document text: entire body tree (viewport + off-screen + typical hidden-in-DOM content). Skips script/style. Caps length. */
export function extractCompletePageText(maxLength = 100_000): string {
  if (!document.body) return ''
  return getTextContent(document.body, maxLength).trim()
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

// ─── Structured content extraction (generic, no hardcoded selectors) ─────────

export function extractStructuredContent(maxLength = 8000): string | null {
  const mainContainer = findMainContent()
  if (!mainContainer) return null

  const repeatedBlocks = findRepeatedContentBlocks(mainContainer)
  if (repeatedBlocks.length === 0) return null

  const parts = repeatedBlocks
    .slice(0, 50)
    .map(el => getTextContent(el, 500).trim())
    .filter(t => t.length > 5)

  if (parts.length === 0) return null
  return parts.join('\n---\n').slice(0, maxLength)
}

// ─── Semantic landmarks ──────────────────────────────────────────────────────

export interface LandmarkInfo {
  type: string
  count: number
  hasContent: boolean
}

export function extractSemanticLandmarks(): LandmarkInfo[] {
  const landmarks: LandmarkInfo[] = []

  for (const [selector, type] of LANDMARK_SELECTORS) {
    const els = document.querySelectorAll<HTMLElement>(selector)
    const visibleEls = [...els].filter(el => el.offsetParent !== null || el.offsetHeight > 0)
    if (visibleEls.length > 0) {
      const hasContent = visibleEls.some(el => (el.textContent?.trim().length ?? 0) > 10)
      landmarks.push({ type, count: visibleEls.length, hasContent })
    }
  }

  return landmarks
}

// ─── Repeated content block detection ────────────────────────────────────────

function findRepeatedContentBlocks(container: Element): Element[] {
  const candidates: Element[] = []

  for (const sel of SEMANTIC_CONTAINERS) {
    const el = container.querySelector(sel) ?? document.querySelector(sel)
    if (el) {
      const blocks = findSiblingGroups(el)
      if (blocks.length >= 2) return blocks
    }
  }

  const blocks = findSiblingGroups(container)
  if (blocks.length >= 2) return blocks

  return candidates
}

function findSiblingGroups(parent: Element): Element[] {
  const tagGroups = new Map<string, Element[]>()

  for (const child of parent.children) {
    const tag = child.tagName
    const role = child.getAttribute('role') ?? ''
    const key = role ? `${tag}[${role}]` : tag

    if (!tagGroups.has(key)) tagGroups.set(key, [])
    tagGroups.get(key)!.push(child)
  }

  let bestGroup: Element[] = []
  for (const group of tagGroups.values()) {
    if (group.length > bestGroup.length && group.length >= 2) {
      const withText = group.filter(el => (el.textContent?.trim().length ?? 0) > 10)
      if (withText.length >= 2) bestGroup = withText
    }
  }

  if (bestGroup.length >= 2) return bestGroup

  for (const child of parent.children) {
    const nested = findSiblingGroups(child)
    if (nested.length >= 2) return nested
  }

  return []
}

// ─── Internal helpers ────────────────────────────────────────────────────────

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
