/**
 * CDP Accessibility — extracts the browser's real accessibility tree via chrome.debugger,
 * then stamps data-ai-id attributes on interactive elements for stable targeting.
 *
 * Falls back to the existing DOM-based marker system if CDP is unavailable.
 *
 * When a CDPSession is active (from cdp-session.ts), skips attach/detach and reuses
 * the session — eliminating ~100ms overhead per tree fetch.
 */

import { isSessionActive, cdpSend } from './cdp-session'

const CDP_VERSION = '1.3'
const MAX_AI_ELEMENTS = 200

interface CDPAXNode {
  nodeId: string
  role: { type: string; value: string }
  name?: { type: string; value: string }
  description?: { type: string; value: string }
  value?: { type: string; value: string }
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
  ignored?: boolean
}

export interface AITreeElement {
  aiId: number
  role: string
  name: string
  state: string
  backendNodeId: number
  coords?: [number, number]
  rect?: { x: number; y: number; w: number; h: number }
}

export interface CDPTreeResult {
  treeText: string
  elements: AITreeElement[]
  viewport: { width: number; height: number }
  source: 'cdp' | 'dom-fallback'
}

// ─── Legacy standalone CDP helpers (used when no session is active) ──────────

async function attachDebugger(tabId: number): Promise<boolean> {
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION)
    return true
  } catch {
    return false
  }
}

async function detachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId })
  } catch { /* already detached */ }
}

/** Send CDP command — routes through session if active, else direct. */
async function cmd<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  if (isSessionActive(tabId)) {
    return cdpSend<T>(tabId, method, params)
  }
  return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem', 'row', 'gridcell',
  'cell', 'columnheader', 'rowheader',
])

function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role.toLowerCase())
}

function extractState(node: CDPAXNode): string {
  const parts: string[] = []
  for (const prop of node.properties ?? []) {
    const val = prop.value?.value
    switch (prop.name) {
      case 'checked':
        parts.push(val === 'true' ? 'checked' : val === 'mixed' ? 'mixed' : 'unchecked')
        break
      case 'pressed':
        parts.push(val === 'true' ? 'pressed' : 'unpressed')
        break
      case 'expanded':
        parts.push(val === 'true' ? 'expanded' : 'collapsed')
        break
      case 'selected':
        if (val === 'true') parts.push('selected')
        break
      case 'disabled':
        if (val === 'true') parts.push('disabled')
        break
      case 'focused':
        if (val === 'true') parts.push('focused')
        break
    }
  }
  return parts.join(', ')
}

interface BoxModelResult {
  model?: {
    content: number[]
    width: number
    height: number
  }
}

async function getNodeBounds(
  tabId: number,
  backendNodeId: number
): Promise<{ coords: [number, number]; rect: { x: number; y: number; w: number; h: number } } | null> {
  try {
    const result = await cmd<BoxModelResult>(tabId, 'DOM.getBoxModel', { backendNodeId })
    if (!result.model) return null
    const q = result.model.content
    const x = Math.round(Math.min(q[0], q[2], q[4], q[6]))
    const y = Math.round(Math.min(q[1], q[3], q[5], q[7]))
    const w = Math.round(result.model.width)
    const h = Math.round(result.model.height)
    return {
      coords: [Math.round(x + w / 2), Math.round(y + h / 2)],
      rect: { x, y, w, h },
    }
  } catch {
    return null
  }
}

async function injectAIIdAttribute(tabId: number, backendNodeId: number, aiId: number): Promise<void> {
  try {
    const { nodeId } = await cmd<{ nodeId: number }>(
      tabId, 'DOM.pushNodeByBackendIdToFrontend', { backendNodeId }
    )
    if (nodeId > 0) {
      await cmd(tabId, 'DOM.setAttributeValue', {
        nodeId,
        name: 'data-ai-id',
        value: String(aiId),
      })
    }
  } catch { /* restricted node */ }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─── Tree caching ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 3_000
let cachedTree: CDPTreeResult | null = null
let cachedTabId = -1
let cachedAt = 0

function getCachedTree(tabId: number): CDPTreeResult | null {
  if (cachedTabId === tabId && cachedTree && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedTree
  }
  return null
}

function setCachedTree(tabId: number, tree: CDPTreeResult): void {
  cachedTree = tree
  cachedTabId = tabId
  cachedAt = Date.now()
}

/** Invalidate the tree cache (call after navigation or major DOM change). */
export function invalidateTreeCache(): void {
  cachedTree = null
  cachedTabId = -1
  cachedAt = 0
}

// ─── Core tree extraction ────────────────────────────────────────────────────

async function fetchTree(tabId: number): Promise<CDPTreeResult | null> {
  // Ensure DOM + Accessibility domains are enabled (no-op if session already enabled them)
  await cmd(tabId, 'DOM.enable').catch(() => {})
  await cmd(tabId, 'Accessibility.enable').catch(() => {})
  await cmd(tabId, 'DOM.getDocument', { depth: 0 }).catch(() => {})

  const { nodes } = await cmd<{ nodes: CDPAXNode[] }>(
    tabId, 'Accessibility.getFullAXTree', { depth: -1 }
  )

  const layoutMetrics = await cmd<{
    layoutViewport: { clientWidth: number; clientHeight: number }
  }>(tabId, 'Page.getLayoutMetrics')
  const viewport = {
    width: layoutMetrics.layoutViewport.clientWidth,
    height: layoutMetrics.layoutViewport.clientHeight,
  }

  const interactiveNodes = nodes.filter(n => {
    if (n.ignored) return false
    const role = n.role?.value ?? ''
    if (!role || role === 'none' || role === 'presentation' || role === 'generic') return false
    return isInteractiveRole(role) && n.backendDOMNodeId !== undefined
  })

  const capped = interactiveNodes.slice(0, MAX_AI_ELEMENTS)
  const elements: AITreeElement[] = []

  for (let i = 0; i < capped.length; i++) {
    const node = capped[i]
    const aiId = i + 1
    const bounds = await getNodeBounds(tabId, node.backendDOMNodeId!)
    if (!bounds || bounds.rect.w === 0 || bounds.rect.h === 0) continue
    if (bounds.rect.y + bounds.rect.h < 0 || bounds.rect.y > viewport.height + 200) continue

    await injectAIIdAttribute(tabId, node.backendDOMNodeId!, aiId)

    elements.push({
      aiId,
      role: node.role?.value ?? 'unknown',
      name: (node.name?.value ?? '').replace(/\n/g, ' ').trim().slice(0, 80) || (node.role?.value ?? 'unnamed'),
      state: extractState(node),
      backendNodeId: node.backendDOMNodeId!,
      coords: bounds.coords,
      rect: bounds.rect,
    })
  }

  const lines = elements.map(el => {
    const stateTag = el.state ? ` [State: ${el.state}]` : ''
    return `[ID: ${el.aiId}] [${capitalize(el.role)}] [${el.name}]${stateTag} [Coords: ${el.coords![0]}, ${el.coords![1]}]`
  })

  const treeText = lines.length > 0 ? lines.join('\n') : 'No interactive elements found.'

  return { treeText, elements, viewport, source: 'cdp' }
}

/**
 * Get the CDP accessibility tree. If a CDPSession is active for this tab,
 * reuses it (no attach/detach overhead). Otherwise attaches/detaches as before.
 */
export async function getCDPAccessibilityTree(tabId: number): Promise<CDPTreeResult | null> {
  // If session is active, skip attach/detach — domains already enabled
  if (isSessionActive(tabId)) {
    try {
      const tree = await fetchTree(tabId)
      if (tree) setCachedTree(tabId, tree)
      return tree
    } catch (err) {
      console.warn('[CDP] Accessibility tree extraction failed:', err)
      return null
    }
  }

  // Legacy path: attach, fetch, detach
  const attached = await attachDebugger(tabId)
  if (!attached) return null

  try {
    const tree = await fetchTree(tabId)
    if (tree) {
      // Disable domains before detach
      await cmd(tabId, 'Accessibility.disable').catch(() => {})
      await cmd(tabId, 'DOM.disable').catch(() => {})
      setCachedTree(tabId, tree)
    }
    return tree
  } catch (err) {
    console.warn('[CDP] Accessibility tree extraction failed:', err)
    return null
  } finally {
    await detachDebugger(tabId)
  }
}

/**
 * Get accessibility tree with caching (3-second TTL).
 * Use this in action execution loops to avoid redundant tree fetches.
 */
export async function getCDPAccessibilityTreeCached(tabId: number): Promise<CDPTreeResult | null> {
  const cached = getCachedTree(tabId)
  if (cached) return cached
  return getCDPAccessibilityTree(tabId)
}

// ─── Element resolution ──────────────────────────────────────────────────────

export interface ElementRef {
  aiId?: number
  selector?: string
  text?: string
}

/**
 * Resolve an AI element reference to pixel coordinates.
 * Tries in order: aiId lookup → name search → CSS selector eval.
 */
export async function resolveElementCoords(
  tabId: number,
  ref: ElementRef,
): Promise<{ x: number; y: number; backendNodeId?: number } | null> {
  // 1. By aiId — look up in cached tree
  if (ref.aiId !== undefined && ref.aiId > 0) {
    const tree = await getCDPAccessibilityTreeCached(tabId)
    if (tree) {
      const el = tree.elements.find(e => e.aiId === ref.aiId)
      if (el?.coords) {
        // Refresh coordinates in case element moved (scroll, layout shift)
        const freshBounds = await getNodeBounds(tabId, el.backendNodeId)
        if (freshBounds) {
          return { x: freshBounds.coords[0], y: freshBounds.coords[1], backendNodeId: el.backendNodeId }
        }
        return { x: el.coords[0], y: el.coords[1], backendNodeId: el.backendNodeId }
      }
    }
  }

  // 2. By accessible name — search tree for matching text
  if (ref.text || ref.selector) {
    const searchText = (ref.text || ref.selector || '').toLowerCase().trim()
    if (searchText) {
      const tree = await getCDPAccessibilityTreeCached(tabId)
      if (tree) {
        // Exact name match first
        let match = tree.elements.find(e => e.name.toLowerCase() === searchText)
        // Partial match
        if (!match) {
          match = tree.elements.find(e => e.name.toLowerCase().includes(searchText))
        }
        // Search text contains element name
        if (!match) {
          match = tree.elements.find(e => searchText.includes(e.name.toLowerCase()) && e.name.length > 2)
        }
        if (match?.coords) {
          const freshBounds = await getNodeBounds(tabId, match.backendNodeId)
          if (freshBounds) {
            return { x: freshBounds.coords[0], y: freshBounds.coords[1], backendNodeId: match.backendNodeId }
          }
          return { x: match.coords[0], y: match.coords[1], backendNodeId: match.backendNodeId }
        }
      }
    }
  }

  // 3. By CSS selector — evaluate in page via Runtime
  if (ref.selector && (ref.selector.includes('.') || ref.selector.includes('#') || ref.selector.includes('[') || ref.selector.includes('>'))) {
    try {
      const evalResult = await cmd<{
        result: { objectId?: string }
        exceptionDetails?: unknown
      }>(tabId, 'Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(ref.selector)})`,
        returnByValue: false,
      })
      if (evalResult.result?.objectId && !evalResult.exceptionDetails) {
        const nodeResult = await cmd<{ backendNodeId: number }>(
          tabId, 'DOM.requestNode', { objectId: evalResult.result.objectId }
        )
        if (nodeResult.backendNodeId) {
          const bounds = await getNodeBounds(tabId, nodeResult.backendNodeId)
          if (bounds) {
            return { x: bounds.coords[0], y: bounds.coords[1], backendNodeId: nodeResult.backendNodeId }
          }
        }
      }
    } catch { /* selector invalid or element not found */ }
  }

  return null
}
