/**
 * CDP Accessibility — extracts the browser's real accessibility tree via chrome.debugger,
 * then stamps data-ai-id attributes on interactive elements for stable targeting.
 *
 * Falls back to the existing DOM-based marker system if CDP is unavailable.
 */

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

async function cdpCommand<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
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
    const result = await cdpCommand<BoxModelResult>(tabId, 'DOM.getBoxModel', { backendNodeId })
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
    const { nodeId } = await cdpCommand<{ nodeId: number }>(
      tabId, 'DOM.pushNodeByBackendIdToFrontend', { backendNodeId }
    )
    if (nodeId > 0) {
      await cdpCommand(tabId, 'DOM.setAttributeValue', {
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

export async function getCDPAccessibilityTree(tabId: number): Promise<CDPTreeResult | null> {
  const attached = await attachDebugger(tabId)
  if (!attached) return null

  try {
    await cdpCommand(tabId, 'DOM.enable')
    await cdpCommand(tabId, 'Accessibility.enable')
    await cdpCommand(tabId, 'DOM.getDocument', { depth: 0 })

    const { nodes } = await cdpCommand<{ nodes: CDPAXNode[] }>(
      tabId, 'Accessibility.getFullAXTree', { depth: -1 }
    )

    const layoutMetrics = await cdpCommand<{
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

    await cdpCommand(tabId, 'Accessibility.disable').catch(() => {})
    await cdpCommand(tabId, 'DOM.disable').catch(() => {})

    return { treeText, elements, viewport, source: 'cdp' }
  } catch (err) {
    console.warn('[CDP] Accessibility tree extraction failed:', err)
    return null
  } finally {
    await detachDebugger(tabId)
  }
}
