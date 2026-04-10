import { MSG } from '../shared/constants'
import type { AIAction, AIActionResult, Settings, ChatMessage, PageSnapshot, FillAssignment } from '../shared/types'
import { callAI, estimateTokens, truncateMessagesToFit } from './ai-client'
import type { StreamPort } from './ai-client'
import { tabState } from './tab-state'
import { searchGoogle, openAndReadTab, closeAllResearchTabs, openAndReadMultipleTabs, getResearchTabCount } from './web-researcher'
import { sanitizeModelOutput, stripMalformedActions } from '../shared/sanitize-output'
import { extractTaskPattern, buildCompactSequence, saveOrReinforceSkill, recordSkillFailure } from './skill-manager'
import { recordActionFailure, recordActionSuccess, recallRelevantMemories } from './mempalace-learner'
import { getAllSettings } from './memory-manager'
import { classifyField } from './form-intelligence'
import { mempalaceEnabled, searchMempalace } from './mempalace-client'
import { getCDPAccessibilityTree, getCDPAccessibilityTreeCached, resolveElementCoords, invalidateTreeCache } from './cdp-accessibility'
import { captureMiniMap, captureAutomationScreenshot } from './minimap-screenshot'
import { recordPageVisit, getPageScreenshot } from './visual-sitemap'
import { acquireSession, releaseSession, isSessionActive } from './cdp-session'
import {
  cdpClickAt, cdpDoubleClickAt, cdpHoverAt, cdpTypeText, cdpPressKey,
  cdpFocusNode, cdpScrollPage, cdpScrollIntoView, cdpClearField,
  cdpWaitForNavigation, cdpWaitForDOMStable, cdpScreenshot,
} from './cdp-actions'

const ACTION_PATTERN = /\[ACTION:(\w+)([^\]]*)\]/g
const MAX_INJECT_RETRIES = 2
const USER_ACTIVE_RETRY_DELAY = 2000
const NAV_ACTIONS = new Set(['navigate', 'back', 'forward'])

// ─── Cancellation registry ──────────────────────────────────────────────────
// Allows aborting the executeWithFollowUp loop from outside (e.g., stop button)

const cancelledTabs = new Set<number>()

export function cancelAutomation(tabId: number): void {
  cancelledTabs.add(tabId)
}

function isCancelled(tabId: number): boolean {
  return cancelledTabs.has(tabId)
}

function clearCancellation(tabId: number): void {
  cancelledTabs.delete(tabId)
}

interface ParsedAction {
  action: string
  params: Record<string, string>
}

export function parseActionsFromText(text: string): ParsedAction[] {
  const actions: ParsedAction[] = []
  let match: RegExpExecArray | null

  ACTION_PATTERN.lastIndex = 0
  while ((match = ACTION_PATTERN.exec(text)) !== null) {
    const action = match[1].toLowerCase()
    const paramStr = match[2]
    const params: Record<string, string> = {}

    // Relaxed param regex: accepts key="val", key='val', key=val, key: "val", key : val
    const paramPattern = /(\w+)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
    let pm: RegExpExecArray | null
    while ((pm = paramPattern.exec(paramStr)) !== null) {
      params[pm[1]] = pm[2] ?? pm[3] ?? pm[4] ?? ''
    }

    actions.push({ action, params })
  }

  // Always try JSON too — merge results (some models mix formats)
  const jsonActions = parseJSONActions(text)
  if (jsonActions.length > 0) {
    if (actions.length === 0) {
      actions.push(...jsonActions)
    } else {
      // Only add JSON actions that aren't duplicates
      for (const ja of jsonActions) {
        const isDup = actions.some(a => {
          if (a.action !== ja.action) return false
          // Compare by the most meaningful param for each action type
          const aKey = a.params.selector ?? a.params.url ?? a.params.query ?? a.params.value ?? ''
          const jKey = ja.params.selector ?? ja.params.url ?? ja.params.query ?? ja.params.value ?? ''
          const aMarker = a.params.markerId ?? ''
          const jMarker = ja.params.markerId ?? ''
          if (aMarker && jMarker && aMarker === jMarker) return true
          if (aKey && jKey && aKey === jKey) return true
          if (!aKey && !jKey && !aMarker && !jMarker) return true
          return false
        })
        if (!isDup) actions.push(ja)
      }
    }
  }

  return actions
}

interface JSONActionPayload {
  [key: string]: unknown
}

function payloadToParsed(payload: JSONActionPayload): ParsedAction | null {
  const actionRaw = payload.action as string | undefined
  if (!actionRaw) return null

  const action = actionRaw.toLowerCase()
  const params: Record<string, string> = {}

  // Element ID — accept element_id, elementId, id, marker_id
  const eid = payload.element_id ?? payload.elementId ?? payload.marker_id
  if (eid !== undefined) params.markerId = String(eid)

  // Selector — accept selector, target, label, name, text, element, css, query_selector
  const sel = (payload.selector ?? payload.target ?? payload.label ??
    payload.name ?? payload.text ?? payload.element ?? payload.css ??
    payload.query_selector ?? payload.aria_label) as string | undefined
  if (sel) params.selector = sel

  // Value / text content — accept value, text_content, textContent, input, content
  const val = (payload.text_content ?? payload.textContent ?? payload.value ??
    payload.input ?? payload.content) as string | undefined
  if (val !== undefined) params.value = String(val)

  // URL
  if (payload.url) params.url = String(payload.url)

  // Point coordinates
  if (Array.isArray(payload.point)) {
    params.x = String(payload.point[0])
    params.y = String(payload.point[1])
  }

  // Query (for search)
  if (payload.query) params.query = String(payload.query)

  // Direction (for scroll)
  if (payload.direction) params.direction = String(payload.direction)

  // Key (for keypress)
  if (payload.key) params.key = String(payload.key)

  if (action === 'scroll_down') return { action: 'scroll', params: { direction: 'down' } }
  if (action === 'scroll_up') return { action: 'scroll', params: { direction: 'up' } }
  if (action === 'wait') return { action: 'wait', params: { ms: params.value ?? '1500' } }

  return { action, params }
}

function parseJSONActions(text: string): ParsedAction[] {
  const results: ParsedAction[] = []

  // Try 1: JSON array  [{...}, {...}]
  const arrayMatch = text.match(/\[[\s\S]*?\{[\s\S]*?"action"[\s\S]*?\}[\s\S]*?\]/)
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[0]) as unknown
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const p = payloadToParsed(item as JSONActionPayload)
          if (p) results.push(p)
        }
        if (results.length > 0) return results
      }
    } catch { /* not valid JSON array, try individual objects */ }
  }

  // Try 2: Find ALL individual JSON objects with "action" key (works for 1 or many)
  const jsonObjectPattern = /\{[^{}]*?"action"\s*:\s*"[^"]+?"[^{}]*?\}/g
  const matches = text.match(jsonObjectPattern)
  if (matches) {
    for (const m of matches) {
      try {
        const payload = JSON.parse(m) as JSONActionPayload
        const p = payloadToParsed(payload)
        if (p) results.push(p)
      } catch { /* skip invalid */ }
    }
    if (results.length > 0) return results
  }

  // Try 3: Relaxed — find action-like patterns even with slightly broken JSON
  // e.g. {action: "click", element_id: 5} (unquoted keys)
  const relaxedPattern = /\{\s*(?:"action"|action)\s*:\s*"(\w+)"[^}]*\}/g
  let rm: RegExpExecArray | null
  while ((rm = relaxedPattern.exec(text)) !== null) {
    try {
      // Try to fix unquoted keys for JSON.parse
      const fixed = rm[0].replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"')
      const payload = JSON.parse(fixed) as JSONActionPayload
      const p = payloadToParsed(payload)
      if (p) results.push(p)
    } catch {
      // Even if JSON fails, extract the action name
      const action = rm[1].toLowerCase()
      if (action && action !== 'undefined') {
        results.push({ action, params: {} })
      }
    }
  }

  return results
}

function toAIAction(parsed: ParsedAction): AIAction {
  // Accept selector from many possible param names
  const selector = parsed.params.selector ?? parsed.params.text ?? parsed.params.target ??
    parsed.params.label ?? parsed.params.name ?? parsed.params.element
  const markerId = parsed.params.markerId ? Number(parsed.params.markerId) : undefined

  switch (parsed.action) {
    case 'click':
      return { action: 'click', selector, markerId }
    case 'type':
      return { action: 'type', selector: selector ?? parsed.params.selector, value: parsed.params.value, markerId }
    case 'navigate':
      return { action: 'navigate', url: parsed.params.url }
    case 'scroll':
      return { action: 'scroll', value: parsed.params.direction ?? 'down' }
    case 'read':
      return { action: 'read', selector }
    case 'select':
      return { action: 'select', selector }
    case 'screenshot':
      return { action: 'screenshot' }
    case 'select_option':
      return { action: 'select_option', selector, value: parsed.params.value, markerId }
    case 'check':
      return { action: 'check', selector, value: parsed.params.value, markerId }
    case 'clear':
      return { action: 'clear', selector, markerId }
    case 'wait':
      return { action: 'wait', value: parsed.params.ms ?? '1000' }
    case 'read_options':
      return { action: 'read_options', selector }
    case 'get_page_state':
      return { action: 'get_page_state' }
    case 'get_page_text':
      return { action: 'get_page_text' }
    case 'read_page':
      return { action: 'read_page', value: parsed.params.filter ?? parsed.params.value ?? 'all' }
    case 'hover':
      return { action: 'hover', selector, markerId }
    case 'doubleclick':
      return { action: 'doubleclick', selector, markerId }
    case 'keypress':
      return { action: 'keypress', value: parsed.params.key ?? parsed.params.value }
    case 'focus':
      return { action: 'focus', selector, markerId }
    case 'back':
      return { action: 'back' }
    case 'forward':
      return { action: 'forward' }
    case 'scroll_to':
      return { action: 'scroll_to', selector, markerId }
    case 'toggle':
      return { action: 'toggle', selector, markerId }
    case 'select_text':
      return { action: 'select_text', selector }
    case 'search':
      return { action: 'search', value: parsed.params.query }
    case 'open_tab':
      return { action: 'open_tab', url: parsed.params.url }
    case 'read_tab':
      return { action: 'read_tab', url: parsed.params.url }
    case 'close_tab':
      return { action: 'close_tab' }
    case 'batch_read':
      return { action: 'batch_read', value: parsed.params.value ?? parsed.params.selectors ?? '' }
    case 'analyze_file':
      return { action: 'analyze_file', url: parsed.params.url, selector: parsed.params.selector }
    case 'fill_form': {
      let assignments: FillAssignment[] = []
      const raw = parsed.params.assignments ?? parsed.params.json ?? ''
      try {
        const parsedJson = JSON.parse(raw) as unknown
        if (Array.isArray(parsedJson)) assignments = parsedJson as FillAssignment[]
      } catch { /* invalid JSON */ }
      return { action: 'fill_form', assignments }
    }
    case 'sitemap_screenshot':
      return { action: 'sitemap_screenshot', value: parsed.params.path ?? parsed.params.value ?? '/' }
    case 'research_done':
      return { action: 'research_done' }
    case 'form_coach':
      return { action: 'form_coach' }
    default:
      return { action: parsed.action as AIAction['action'], selector, value: parsed.params.value }
  }
}

export async function ensureContentScript(tabId: number): Promise<boolean> {
  let tabUrl = ''
  try {
    const tab = await chrome.tabs.get(tabId)
    tabUrl = tab.url ?? ''
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      console.warn(`[LocalAI] Cannot inject content script on restricted page: ${tab.url}`)
      return false
    }
  } catch (err) {
    console.warn(`[LocalAI] Cannot get tab ${tabId}:`, err)
    return false
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.PING })
    return true
  } catch {
    try {
      console.log(`[LocalAI] Injecting content script on ${tabUrl.slice(0, 80)}...`)
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-main.js'],
      })
      await sleep(400)
      await chrome.tabs.sendMessage(tabId, { type: MSG.PING })
      console.log(`[LocalAI] Content script injected successfully`)
      return true
    } catch (err) {
      console.warn(`[LocalAI] Content script injection failed on ${tabUrl.slice(0, 80)}:`, err)
      return false
    }
  }
}

export async function requestFreshSnapshot(tabId: number): Promise<PageSnapshot | undefined> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.REQUEST_FRESH_SNAPSHOT }) as { ok: boolean; snapshot?: PageSnapshot }
    if (response?.ok && response.snapshot) {
      tabState.set(tabId, response.snapshot)
      return response.snapshot
    }
  } catch { /* content script unavailable */ }
  return undefined
}

const BARRIER_ACTIONS = new Set([
  'navigate', 'back', 'forward', 'open_tab', 'close_tab',
  'scroll', 'scroll_to', 'wait',
  'screenshot', 'get_page_state', 'get_page_text', 'read_page',
  'fill_form', 'search', 'read_tab', 'research_done',
])

const PARALLELIZABLE_ACTIONS = new Set([
  'click', 'toggle', 'check', 'hover', 'doubleclick', 'focus',
  'select_option', 'clear', 'read', 'batch_read',
])

function groupActionsIntoBatches(actions: AIAction[]): AIAction[][] {
  const batches: AIAction[][] = []
  let currentParallel: AIAction[] = []

  for (const action of actions) {
    if (BARRIER_ACTIONS.has(action.action)) {
      if (currentParallel.length > 0) {
        batches.push(currentParallel)
        currentParallel = []
      }
      batches.push([action])
    } else if (PARALLELIZABLE_ACTIONS.has(action.action)) {
      // Type actions are sequential if they target the same element as a previous action
      if (action.action === 'type' && currentParallel.some(a =>
        a.selector === action.selector || (a.markerId && a.markerId === action.markerId)
      )) {
        if (currentParallel.length > 0) {
          batches.push(currentParallel)
          currentParallel = []
        }
        batches.push([action])
      } else {
        currentParallel.push(action)
      }
    } else {
      // Unknown action type — treat as barrier
      if (currentParallel.length > 0) {
        batches.push(currentParallel)
        currentParallel = []
      }
      batches.push([action])
    }
  }

  if (currentParallel.length > 0) {
    batches.push(currentParallel)
  }

  return batches
}

/**
 * Execute actions from pre-parsed ParsedAction array.
 * Used by executeWithFollowUp when actions come from kickstart or retry rather than text.
 */
async function executeParsedActions(
  parsed: ParsedAction[],
  tabId: number
): Promise<AIActionResult[]> {
  if (parsed.length === 0) return []
  const allActions = parsed.map(p => toAIAction(p))
  return executeAIActions(allActions, tabId)
}

export async function executeActionsFromText(
  text: string,
  tabId: number
): Promise<AIActionResult[]> {
  const parsed = parseActionsFromText(text)
  if (parsed.length === 0) return []
  return executeParsedActions(parsed, tabId)
}

async function executeAIActions(allActions: AIAction[], tabId: number): Promise<AIActionResult[]> {
  const batches = groupActionsIntoBatches(allActions)
  const results: AIActionResult[] = []

  for (const batch of batches) {
    if (batch.length === 1) {
      // Single action — execute directly
      const action = batch[0]
      const result = await executeSingleAction(action, tabId)
      results.push(result)

      if (result.success) {
        const isNavAction = NAV_ACTIONS.has(action.action) ||
          (action.action === 'click' && result.result?.includes('Navigat'))
        if (isNavAction) {
          // Wait for navigation: event-based if CDP is active, else fixed delay
          if (isSessionActive(tabId)) {
            await cdpWaitForNavigation(tabId, 5000)
            invalidateTreeCache()
          } else {
            await sleep(2000)
          }
          await ensureContentScript(tabId).catch(() => false)
          await sleep(300)
        }
      }
    } else {
      // Parallel batch — execute all simultaneously
      const batchResults = await Promise.all(
        batch.map(action => executeSingleAction(action, tabId))
      )
      results.push(...batchResults)
    }

    // Refresh snapshot + capture fast verification screenshot after each batch
    const lastResult = results[results.length - 1]
    if (lastResult?.success) {
      await requestFreshSnapshot(tabId)
      try {
        // Use CDP screenshot when session is active (faster, no extra API call)
        const shotUrl = isSessionActive(tabId)
          ? await cdpScreenshot(tabId, 20)
          : (await captureAutomationScreenshot(tabId).catch(() => null))?.dataUrl ?? null
        if (shotUrl) {
          tabState.setScreenshot(tabId, shotUrl)
          const snap = tabState.get(tabId)
          if (snap?.url) {
            const domain = extractDomainFromUrl(snap.url)
            recordPageVisit(domain, snap.url, snap, shotUrl).catch(() => {})
          }
        }
      } catch { /* screenshot not critical */ }
    }
    await sleep(100) // reduced from 200ms
  }

  return results
}

// ─── CDP-first action execution ─────────────────────────────────────────────
// Tries to execute DOM-interactive actions via CDP (trusted events) first.
// Returns null if CDP is unavailable or the action can't be handled via CDP,
// causing automatic fallback to the content script path.

const CDP_CLICK_ACTIONS = new Set(['click', 'doubleclick', 'toggle', 'check'])
const CDP_INPUT_ACTIONS = new Set(['type', 'clear'])
const CDP_OTHER_ACTIONS = new Set(['hover', 'focus', 'scroll', 'scroll_to', 'select_option', 'keypress'])

async function executeSingleActionCDP(action: AIAction, tabId: number): Promise<AIActionResult | null> {
  if (!isSessionActive(tabId)) return null

  // ── Click / DoubleClick / Toggle / Check ───────────────────────────────
  if (CDP_CLICK_ACTIONS.has(action.action)) {
    const coords = await resolveElementCoords(tabId, {
      aiId: action.markerId,
      selector: action.selector,
      text: action.value,
    })
    if (!coords) return null // can't find element → fallback

    // Scroll into view if we have a backendNodeId
    if (coords.backendNodeId) {
      await cdpScrollIntoView(tabId, coords.backendNodeId)
      // Re-fetch coordinates after scroll
      const fresh = await resolveElementCoords(tabId, {
        aiId: action.markerId,
        selector: action.selector,
        text: action.value,
      })
      if (fresh) {
        coords.x = fresh.x
        coords.y = fresh.y
      }
    }

    const clickFn = action.action === 'doubleclick' ? cdpDoubleClickAt : cdpClickAt
    const ok = await clickFn(tabId, coords.x, coords.y)
    if (!ok) return null

    // Wait for DOM to stabilize (event-based, not fixed sleep)
    await cdpWaitForDOMStable(tabId, 1500)

    return { action: action.action, success: true, result: `${action.action} via CDP at (${coords.x}, ${coords.y})` }
  }

  // ── Type ───────────────────────────────────────────────────────────────
  if (action.action === 'type') {
    // Focus the target element first
    if (action.markerId || action.selector) {
      const coords = await resolveElementCoords(tabId, {
        aiId: action.markerId,
        selector: action.selector,
      })
      if (coords) {
        if (coords.backendNodeId) {
          await cdpFocusNode(tabId, coords.backendNodeId)
        } else {
          await cdpClickAt(tabId, coords.x, coords.y)
        }
        await sleep(100) // brief pause after focus
      } else {
        return null // can't find target → fallback
      }
    }

    const ok = await cdpTypeText(tabId, action.value ?? '')
    if (!ok) return null
    return { action: 'type', success: true, result: `Typed "${(action.value ?? '').slice(0, 50)}" via CDP` }
  }

  // ── Clear ──────────────────────────────────────────────────────────────
  if (action.action === 'clear') {
    if (action.markerId || action.selector) {
      const coords = await resolveElementCoords(tabId, {
        aiId: action.markerId,
        selector: action.selector,
      })
      if (coords) {
        if (coords.backendNodeId) {
          await cdpFocusNode(tabId, coords.backendNodeId)
        } else {
          await cdpClickAt(tabId, coords.x, coords.y)
        }
      }
    }
    const ok = await cdpClearField(tabId)
    if (!ok) return null
    return { action: 'clear', success: true, result: 'Field cleared via CDP' }
  }

  // ── Hover ──────────────────────────────────────────────────────────────
  if (action.action === 'hover') {
    const coords = await resolveElementCoords(tabId, {
      aiId: action.markerId,
      selector: action.selector,
      text: action.value,
    })
    if (!coords) return null
    const ok = await cdpHoverAt(tabId, coords.x, coords.y)
    if (!ok) return null
    return { action: 'hover', success: true, result: `Hovered via CDP at (${coords.x}, ${coords.y})` }
  }

  // ── Focus ──────────────────────────────────────────────────────────────
  if (action.action === 'focus') {
    const coords = await resolveElementCoords(tabId, {
      aiId: action.markerId,
      selector: action.selector,
    })
    if (!coords?.backendNodeId) return null
    const ok = await cdpFocusNode(tabId, coords.backendNodeId)
    if (!ok) return null
    return { action: 'focus', success: true, result: 'Focused via CDP' }
  }

  // ── Scroll ─────────────────────────────────────────────────────────────
  if (action.action === 'scroll') {
    const direction = (action.value ?? 'down').toLowerCase() as 'up' | 'down'
    const ok = await cdpScrollPage(tabId, direction)
    if (!ok) return null
    return { action: 'scroll', success: true, result: `Scrolled ${direction} via CDP` }
  }

  // ── Scroll To (specific element) ───────────────────────────────────────
  if (action.action === 'scroll_to') {
    const coords = await resolveElementCoords(tabId, {
      aiId: action.markerId,
      selector: action.selector,
      text: action.value,
    })
    if (!coords?.backendNodeId) return null
    const ok = await cdpScrollIntoView(tabId, coords.backendNodeId)
    if (!ok) return null
    return { action: 'scroll_to', success: true, result: 'Scrolled to element via CDP' }
  }

  // ── Keypress ───────────────────────────────────────────────────────────
  if (action.action === 'keypress') {
    const key = action.value ?? action.selector ?? 'Enter'
    const ok = await cdpPressKey(tabId, key)
    if (!ok) return null
    return { action: 'keypress', success: true, result: `Pressed ${key} via CDP` }
  }

  // ── Select Option ──────────────────────────────────────────────────────
  if (action.action === 'select_option') {
    // Click the select, then try to find and click the option
    const coords = await resolveElementCoords(tabId, {
      aiId: action.markerId,
      selector: action.selector,
    })
    if (coords) {
      await cdpClickAt(tabId, coords.x, coords.y)
      await sleep(200) // wait for dropdown
    }
    // Fall through to content script for actual option selection
    return null
  }

  return null // action not handled by CDP → fallback
}

async function executeSingleAction(action: AIAction, tabId: number): Promise<AIActionResult> {
  if (action.action === 'screenshot') {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 60 })
      tabState.setScreenshot(tabId, dataUrl)
      // Also record in sitemap
      const snap = tabState.get(tabId)
      if (snap?.url) {
        const domain = extractDomainFromUrl(snap.url)
        recordPageVisit(domain, snap.url, snap, dataUrl).catch(() => {})
      }
      return { action: 'screenshot', success: true, result: 'Screenshot captured' }
    } catch (err) {
      return { action: 'screenshot', success: false, error: String(err) }
    }
  }

  if (action.action === 'sitemap_screenshot') {
    const path = action.value ?? action.selector ?? '/'
    const snap = tabState.get(tabId)
    const domain = snap?.url ? extractDomainFromUrl(snap.url) : ''
    const screenshot = await getPageScreenshot(domain, path)
    if (screenshot) {
      tabState.setScreenshot(tabId, screenshot)
      return { action: 'sitemap_screenshot', success: true, result: `Loaded cached screenshot for ${path}` }
    }
    return { action: 'sitemap_screenshot', success: false, error: `No cached screenshot for path "${path}" on ${domain}` }
  }

  if (action.action === 'wait') {
    const ms = Math.min(parseInt(action.value ?? '1000', 10) || 1000, 10000)
    await sleep(ms)
    return { action: 'wait', success: true, result: `Waited ${ms}ms` }
  }

  if (action.action === 'get_page_state') {
    const snapshot = await requestFreshSnapshot(tabId)
    if (snapshot) {
      return { action: 'get_page_state', success: true, result: tabState.summarize(tabId), snapshot }
    }
    return { action: 'get_page_state', success: false, error: 'Could not get page state' }
  }

  if (action.action === 'get_page_text') {
    let snapshot = tabState.get(tabId)
    let text = snapshot?.completePageText ?? snapshot?.pageText ?? ''
    if (!text) {
      await requestFreshSnapshot(tabId)
      snapshot = tabState.get(tabId)
      text = snapshot?.completePageText ?? snapshot?.pageText ?? ''
    }
    if (text) {
      return { action: 'get_page_text', success: true, result: text.slice(0, 50_000) }
    }
    return { action: 'get_page_text', success: false, error: 'No page text available' }
  }

  if (action.action === 'read_page') {
    return await executeReadPage(action, tabId)
  }

  if (action.action === 'search') {
    try {
      const results = await searchGoogle(action.value ?? '')
      if (results.length === 0) {
        return {
          action: 'search',
          success: true,
          result: 'No results found. Google may be showing a consent page or blocking automated requests. Use [ACTION:OPEN_TAB url="https://www.google.com/search?q=YOUR+QUERY"] to open Google directly and read the results, or navigate directly to a relevant website with [ACTION:NAVIGATE url="..."].',
        }
      }
      const formatted = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
      return { action: 'search', success: true, result: formatted }
    } catch (err) {
      return { action: 'search', success: false, error: String(err) }
    }
  }

  if (action.action === 'open_tab' || action.action === 'read_tab') {
    try {
      const content = await openAndReadTab(action.url ?? '')
      return { action: action.action, success: true, result: `Title: ${content.title}\nURL: ${content.url}\n\n${content.text}` }
    } catch (err) {
      return { action: action.action, success: false, error: String(err) }
    }
  }

  if (action.action === 'close_tab') {
    await closeAllResearchTabs()
    return { action: 'close_tab', success: true, result: 'All research tabs closed' }
  }

  if (action.action === 'research_done') {
    const count = getResearchTabCount()
    await closeAllResearchTabs()
    return { action: 'research_done', success: true, result: `Research complete — closed ${count} research tab${count !== 1 ? 's' : ''}` }
  }

  // --- Form Coach: step-by-step guided form filling ---
  if (action.action === 'form_coach') {
    try {
      // 1. Get form fields from the page via content script
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: MSG.REQUEST_SNAPSHOT }) as PageSnapshot
      const forms = snapshot?.forms ?? []
      if (forms.length === 0) {
        return { action: 'form_coach', success: false, error: 'No forms found on this page.' }
      }

      // 2. Collect all fields across all forms
      const allFields = forms.flatMap(f => f.fields)
      if (allFields.length === 0) {
        return { action: 'form_coach', success: false, error: 'No fillable fields found.' }
      }

      // 3. Classify each field and build the coach data
      const settings = await getAllSettings()
      const coachFields = allFields.slice(0, 30).map(field => {
        const hint = classifyField(field)
        return {
          selector: field.selector,
          label: field.label || field.name || field.type,
          type: field.type,
          hint: hint ? `This field expects: ${hint}` : `Enter your ${field.label || field.name || field.type}`,
          suggestedValue: '',  // Filled by AI below
          required: field.required,
        }
      })

      // 4. Ask AI to suggest values for each field
      const fieldDescriptions = coachFields.map((f, i) =>
        `${i + 1}. "${f.label}" (${f.type}) — ${f.hint}${f.required ? ' [REQUIRED]' : ''}`
      ).join('\n')

      const aiResponse = await callAI([
        { role: 'system', content: 'You are a form-filling assistant. For each field below, suggest a realistic value the user should enter. Return ONLY a JSON array of strings, one per field. If you don\'t know, use empty string. Example: ["John", "Doe", "john@email.com", "", ""]' },
        { role: 'user', content: `Suggest values for these form fields:\n${fieldDescriptions}` },
      ], settings, 1024)

      // Parse AI suggestions
      try {
        const match = aiResponse.match(/\[[\s\S]*\]/)
        if (match) {
          const suggestions = JSON.parse(match[0]) as string[]
          suggestions.forEach((val, i) => {
            if (i < coachFields.length && val) coachFields[i].suggestedValue = val
          })
        }
      } catch { /* AI didn't return valid JSON — user can type manually */ }

      // 5. Send to content script to start the guided UI
      await chrome.tabs.sendMessage(tabId, {
        type: MSG.FORM_COACH_START,
        fields: coachFields,
      })

      return {
        action: 'form_coach',
        success: true,
        result: `Started guided form filling for ${coachFields.length} fields. The user is filling the form step-by-step.`,
      }
    } catch (err) {
      return { action: 'form_coach', success: false, error: `Form coach failed: ${err}` }
    }
  }

  // --- Navigation actions: use Chrome API directly, NO content script needed ---
  if (action.action === 'navigate') {
    const url = action.url ?? action.value ?? ''
    if (!url) return { action: 'navigate', success: false, error: 'No URL provided' }
    try {
      // Ensure URL has a protocol
      const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`
      await chrome.tabs.update(tabId, { url: fullUrl })
      // Wait for page to start loading
      await sleep(2000)
      return { action: 'navigate', success: true, result: `Navigated to ${fullUrl}` }
    } catch (err) {
      return { action: 'navigate', success: false, error: `Navigation failed: ${err}` }
    }
  }

  if (action.action === 'back') {
    try {
      await chrome.tabs.goBack(tabId)
      await sleep(1000)
      return { action: 'back', success: true, result: 'Went back' }
    } catch (err) {
      return { action: 'back', success: false, error: `Back failed: ${err}` }
    }
  }

  if (action.action === 'forward') {
    try {
      await chrome.tabs.goForward(tabId)
      await sleep(1000)
      return { action: 'forward', success: true, result: 'Went forward' }
    } catch (err) {
      return { action: 'forward', success: false, error: `Forward failed: ${err}` }
    }
  }

  // ── CDP-FIRST: try trusted browser events before content script ──────
  // CDP clicks are isTrusted:true — they work on Gmail, React, Angular, etc.
  const cdpResult = await executeSingleActionCDP(action, tabId)
  if (cdpResult) return cdpResult

  // ── Content script fallback path ────────────────────────────────────────
  if (action.action === 'scroll') {
    // Scroll can work via CDP even without content script (standalone fallback)
    try {
      const direction = (action.value ?? 'down').toLowerCase()
      const deltaY = direction === 'up' ? -500 : 500
      await chrome.debugger.attach({ tabId }, '1.3').catch(() => {})
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY,
      })
      await chrome.debugger.detach({ tabId }).catch(() => {})
      return { action: 'scroll', success: true, result: `Scrolled ${direction}` }
    } catch {
      // Fall through to content script path
    }
  }

  if (action.markerId && action.action === 'click') {
    return await executeMarkerAction(action, tabId)
  }

  // Route all marker-based actions (including type) through AI ID handler which passes value
  const AI_ID_ROUTABLE_ACTIONS = new Set([
    'type', 'hover', 'doubleclick', 'focus', 'check', 'toggle', 'select_option', 'clear', 'scroll_to',
  ])
  if (action.markerId && AI_ID_ROUTABLE_ACTIONS.has(action.action)) {
    return await executeAIIdAction(action, tabId)
  }

  for (let attempt = 0; attempt <= MAX_INJECT_RETRIES; attempt++) {
    const alive = await ensureContentScript(tabId)
    if (!alive) {
      if (attempt < MAX_INJECT_RETRIES) { await sleep(500); continue }
      return { action: action.action, success: false, error: 'Content script unreachable — tab may be a restricted page or closed' }
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: MSG.EXECUTE_ACTION,
        action,
      }) as { ok: boolean; result?: string; error?: string; userActive?: boolean; snapshot?: PageSnapshot }

      if (response.error === 'USER_ACTIVE' && attempt < MAX_INJECT_RETRIES) {
        await sleep(USER_ACTIVE_RETRY_DELAY)
        continue
      }

      const result: AIActionResult = {
        action: action.action,
        success: response.ok,
        result: response.result,
        error: response.error,
        userActive: response.userActive,
      }

      if (response.snapshot) {
        tabState.set(tabId, response.snapshot)
        result.snapshot = response.snapshot
      }

      // If click reported "no visible change" with coordinates, retry via CDP
      // CDP produces trusted browser events that frameworks like Gmail respond to
      if (action.action === 'click' && response.ok && response.result?.includes('[COORDS:')) {
        const coordMatch = response.result.match(/\[COORDS:(\d+),(\d+)\]/)
        if (coordMatch) {
          const cx = parseInt(coordMatch[1])
          const cy = parseInt(coordMatch[2])
          // Use CDP actions module if session active, else standalone
          if (isSessionActive(tabId)) {
            await cdpClickAt(tabId, cx, cy)
          } else {
            try {
              await chrome.debugger.attach({ tabId }, '1.3').catch(() => {})
              await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
                type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
              })
              await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
              })
              await chrome.debugger.detach({ tabId }).catch(() => {})
            } catch { /* ok */ }
          }
          await sleep(300)
          result.result = result.result?.replace(/\[COORDS:\d+,\d+\]/, '').replace('WARNING:', 'retried with CDP click.')
        }
      }

      return result
    } catch (err) {
      if (attempt < MAX_INJECT_RETRIES) {
        await sleep(500)
        continue
      }
      return { action: action.action, success: false, error: `Could not execute action: ${err}` }
    }
  }

  return { action: action.action, success: false, error: 'Max retries exceeded' }
}

async function executeReadPage(action: AIAction, tabId: number): Promise<AIActionResult> {
  const filter: string = action.value ?? 'all'
  const wantInteractive = filter === 'interactive' || filter === 'all'
  const wantForms = filter === 'forms' || filter === 'all'
  const wantText = filter === 'text' || filter === 'all'

  // Try CDP accessibility tree first (most accurate)
  const cdpResult = await getCDPAccessibilityTree(tabId).catch(() => null)
  if (cdpResult && wantInteractive) {
    const snapshot = await requestFreshSnapshot(tabId)
    let result = `Page: ${snapshot?.url ?? 'unknown'}\nTitle: ${snapshot?.title ?? 'unknown'}\n\n`

    result += `## Interactive Elements (${cdpResult.elements.length} found)\n`
    result += cdpResult.treeText

    if (wantForms && snapshot?.forms?.length) {
      result += '\n\n## Forms\n'
      for (const form of snapshot.forms) {
        result += `Form: ${form.selector} (${form.method} ${form.action})\n`
        for (const field of form.fields) {
          const opts = field.options?.map(o => `"${o.label}"`).join(', ') ?? ''
          result += `  [${field.type}] "${field.label || field.name}" ${field.required ? '[required]' : ''} ${field.value ? `[value: "${field.value}"]` : ''} ${opts ? `[options: ${opts}]` : ''}\n`
        }
      }
    }

    if (wantText && snapshot) {
      result += '\n\n## Page Text (excerpt)\n'
      result += (snapshot.visibleText ?? snapshot.pageText ?? '').slice(0, 4000)
    }

    return { action: 'read_page', success: true, result, snapshot }
  }

  // Fallback: DOM-based markers
  const alive = await ensureContentScript(tabId)
  if (!alive) return { action: 'read_page', success: false, error: 'Content script unreachable' }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MSG.READ_PAGE,
      filter,
    }) as { ok: boolean; result?: string; snapshot?: PageSnapshot; error?: string }

    if (response.ok) {
      if (response.snapshot) tabState.set(tabId, response.snapshot)
      return { action: 'read_page', success: true, result: response.result, snapshot: response.snapshot }
    }
    return { action: 'read_page', success: false, error: response.error ?? 'Failed to read page' }
  } catch (err) {
    return { action: 'read_page', success: false, error: String(err) }
  }
}

async function executeMarkerAction(action: AIAction, tabId: number): Promise<AIActionResult> {
  for (let attempt = 0; attempt <= MAX_INJECT_RETRIES; attempt++) {
    const alive = await ensureContentScript(tabId)
    if (!alive) {
      if (attempt < MAX_INJECT_RETRIES) { await sleep(500); continue }
      return { action: action.action, success: false, error: 'Content script unreachable' }
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: MSG.CLICK_MARKER,
        markerId: action.markerId,
      }) as { ok: boolean; result?: string; error?: string; snapshot?: PageSnapshot; userActive?: boolean }

      if (response.error === 'USER_ACTIVE' && attempt < MAX_INJECT_RETRIES) {
        await sleep(USER_ACTIVE_RETRY_DELAY)
        continue
      }

      if (response.snapshot) {
        tabState.set(tabId, response.snapshot)
      }

      return {
        action: action.action,
        success: response.ok,
        result: response.result,
        error: response.error,
        userActive: response.userActive,
      }
    } catch (err) {
      if (attempt < MAX_INJECT_RETRIES) { await sleep(500); continue }
      return { action: action.action, success: false, error: `Marker click failed: ${err}` }
    }
  }

  return { action: action.action, success: false, error: 'Max retries exceeded for marker action' }
}

async function executeAIIdAction(action: AIAction, tabId: number): Promise<AIActionResult> {
  for (let attempt = 0; attempt <= MAX_INJECT_RETRIES; attempt++) {
    const alive = await ensureContentScript(tabId)
    if (!alive) {
      if (attempt < MAX_INJECT_RETRIES) { await sleep(500); continue }
      return { action: action.action, success: false, error: 'Content script unreachable' }
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: MSG.EXECUTE_BY_AI_ID,
        aiId: action.markerId,
        actionType: action.action,
        value: action.value,
      }) as { ok: boolean; result?: string; error?: string; snapshot?: PageSnapshot; userActive?: boolean }

      if (response.error === 'USER_ACTIVE' && attempt < MAX_INJECT_RETRIES) {
        await sleep(USER_ACTIVE_RETRY_DELAY)
        continue
      }

      if (response.snapshot) tabState.set(tabId, response.snapshot)

      return {
        action: action.action,
        success: response.ok,
        result: response.result,
        error: response.error,
        userActive: response.userActive,
      }
    } catch (err) {
      if (attempt < MAX_INJECT_RETRIES) { await sleep(500); continue }
      return { action: action.action, success: false, error: `AI ID action failed: ${err}` }
    }
  }

  return { action: action.action, success: false, error: 'Max retries exceeded for AI ID action' }
}

export type { ParsedAction }

interface ActionVerification {
  preUrl: string
  postUrl: string
  preTitle: string
  postTitle: string
  urlChanged: boolean
  contentChanged: boolean
}

async function captureVerificationState(tabId: number): Promise<{ url: string; title: string; textHash: number }> {
  try {
    const snapshot = await requestFreshSnapshot(tabId)
    const url = snapshot?.url ?? ''
    const title = snapshot?.title ?? ''
    const textHash = simpleHash(snapshot?.visibleText ?? snapshot?.pageText ?? '')
    return { url, title, textHash }
  } catch {
    return { url: '', title: '', textHash: 0 }
  }
}

function simpleHash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0
  }
  return h
}

function buildVerificationContext(
  pre: { url: string; title: string; textHash: number },
  post: { url: string; title: string; textHash: number }
): string {
  const urlChanged = pre.url !== post.url
  const contentChanged = pre.textHash !== post.textHash
  const nothingChanged = !urlChanged && !contentChanged

  let msg = `VERIFICATION: Before your actions, the page was at "${pre.url}" with title "${pre.title}". After your actions, the page is at "${post.url}" with title "${post.title}". The page content ${contentChanged ? 'DID change' : 'did NOT change'}. URL ${urlChanged ? 'changed' : 'unchanged'}.`

  if (nothingChanged) {
    msg += ` CRITICAL WARNING: NOTHING on the page changed after your actions. This strongly suggests your actions DID NOT execute or targeted the wrong element. You MUST try a completely different approach — different selector, scroll to reveal the element, or use the accessibility tree IDs. Do NOT repeat the same action.`
  } else {
    msg += ` Verify: did your intended action actually succeed? If the page changed as expected, report the result. If not, adjust your approach.`
  }

  return msg
}

function buildStateDiff(
  preElements: { aiId: number; role: string; name: string; state: string }[],
  postElements: { aiId: number; role: string; name: string; state: string }[]
): string {
  const preMap = new Map(preElements.map(e => [e.aiId, e]))
  const diffs: string[] = []

  for (const post of postElements) {
    const pre = preMap.get(post.aiId)
    if (!pre) continue
    if (pre.state !== post.state && (pre.state || post.state)) {
      const preState = pre.state || 'none'
      const postState = post.state || 'none'
      const success = preState !== postState
      diffs.push(`[ID:${post.aiId}] ${post.role} "${post.name.slice(0, 40)}": ${preState} -> ${postState}${success ? '' : ' (UNCHANGED)'}`)
    }
  }

  // Check for elements that disappeared
  const postIds = new Set(postElements.map(e => e.aiId))
  for (const pre of preElements) {
    if (!postIds.has(pre.aiId)) {
      diffs.push(`[ID:${pre.aiId}] ${pre.role} "${pre.name.slice(0, 40)}": REMOVED from page`)
    }
  }

  return diffs.length > 0 ? diffs.join('\n') : ''
}

export async function executeWithFollowUp(
  aiResponse: string,
  tabId: number,
  settings: Settings,
  port: StreamPort,
  sessionMessages: Pick<ChatMessage, 'role' | 'content'>[],
  maxRounds = 25
): Promise<void> {
  let response = aiResponse
  let round = 0
  let hadSuccess = false
  let hadFailure = false
  let stuckCount = 0
  let lastActionSignature = ''
  let lastErrorSignature = ''
  let errorRepeatCount = 0
  const allParsedActions: ParsedAction[] = []
  const allResults: AIActionResult[] = []

  // Clear any stale cancellation for this tab, then show stop overlay
  clearCancellation(tabId)
  signalActivity(tabId, true)

  // ── Acquire CDP session for the entire automation sequence ──────────
  // This attaches the debugger ONCE and keeps it attached for all rounds,
  // avoiding ~100ms attach/detach overhead per action.
  const cdpSession = await acquireSession(tabId).catch(() => null)
  if (cdpSession) {
    console.log(`[LocalAI] CDP session acquired for tab ${tabId} — using trusted events`)
    invalidateTreeCache() // fresh tree for new sequence
  }

  // Helper: check if current tab is restricted (no DOM interaction possible)
  async function isTabRestricted(): Promise<boolean> {
    if (tabId <= 0) return true
    try {
      const tab = await chrome.tabs.get(tabId)
      const u = tab.url ?? ''
      return !u || u.startsWith('chrome://') || u.startsWith('chrome-extension://') || u.startsWith('about:') || u.startsWith('edge://') || u.startsWith('brave://') || u.startsWith('devtools://')
    } catch { return true }
  }

  // Ensure content script is alive before starting
  let restricted = await isTabRestricted()
  if (!restricted && tabId > 0) {
    await ensureContentScript(tabId).catch(() => false)
  } else if (restricted) {
    console.log(`[LocalAI] Tab is on restricted/blank page. DOM actions will use background alternatives.`)
  }

  let consecutiveFailures = 0

  while (round < maxRounds) {
    // Check if user clicked the stop button
    if (isCancelled(tabId)) {
      port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Automation stopped by user.\n\n' })
      break
    }

    // Check for is_complete signal from AI
    if (checkIsComplete(response)) {
      port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '' })
      break
    }

    let actions = parseActionsFromText(response)
    console.log(`[LocalAI] Round ${round + 1}: parsed ${actions.length} actions from AI response (${response.length} chars)`)
    if (actions.length > 0) {
      console.log(`[LocalAI] Actions: ${actions.map(a => `${a.action}(${JSON.stringify(a.params)})`).join(', ')}`)
    }
    // Log raw response for debugging empty selectors
    if (actions.some(a => !a.params.selector && !a.params.url && !a.params.query && !a.params.markerId && !a.params.key && !a.params.direction)) {
      console.log(`[LocalAI] Raw AI response: ${response.slice(0, 300)}`)
    }

    // If no actions found on first round, try auto-kickstart based on user intent
    if (actions.length === 0 && round === 0) {
      const userGoal = sessionMessages.filter(m => m.role === 'user').pop()?.content ?? ''
      console.log(`[LocalAI] No actions parsed. Trying auto-kickstart from user intent...`)
      const kickstart = detectIntentAndKickstart(userGoal)
      if (kickstart.length > 0) {
        console.log(`[LocalAI] Auto-kickstart: ${kickstart.map(a => `${a.action}(${JSON.stringify(a.params)})`).join(', ')}`)
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Starting actions...\n\n' })
        actions = kickstart
      }
    }

    // If still no actions, retry once with a clearer prompt
    if (actions.length === 0 && round <= 1) {
      const hasWrongFormat = containsMalformedActions(response)
      const retryPrompt = hasWrongFormat
        ? `Your response used an unsupported format. You MUST use either:\n1. [ACTION:SEARCH query="..."] bracket syntax\n2. {"action": "click", "element_id": 5} JSON format\n\nTry again. What action should you take?`
        : `You did not emit any actions. You MUST take action now.\nIf the user wants to search/find something: [ACTION:SEARCH query="relevant terms"]\nIf the user wants to navigate: [ACTION:NAVIGATE url="..."]\nIf the user wants to read the page: [ACTION:GET_PAGE_TEXT]\nWhat is the FIRST action to take? Emit it now.`

      const retryMessages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] = [
        ...sessionMessages.map(m => ({ ...m, imageData: undefined as string | undefined })),
        { role: 'assistant' as const, content: response, imageData: undefined },
        { role: 'user' as const, content: retryPrompt, imageData: undefined },
      ]

      console.log(`[LocalAI] Retrying with clearer prompt (hasWrongFormat: ${hasWrongFormat})...`)
      const retryResponse = await callAI(retryMessages, settings, 2048)
      if (retryResponse) {
        console.log(`[LocalAI] Retry response: ${retryResponse.slice(0, 200)}`)
        const cleanedRetry = stripActionMarkersForDisplay(retryResponse)
        if (cleanedRetry.trim()) {
          port.postMessage({ type: MSG.STREAM_CHUNK, chunk: cleanedRetry })
        }
        actions = parseActionsFromText(retryResponse)
        console.log(`[LocalAI] Retry parsed ${actions.length} actions`)
        if (actions.length > 0) {
          response = retryResponse
        }
      } else {
        console.warn(`[LocalAI] Retry returned empty response`)
      }
    }

    if (actions.length === 0) {
      console.warn(`[LocalAI] No actions after all attempts on round ${round + 1}. Breaking.`)
      if (round === 0) {
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Could not determine actions to take. Try rephrasing your request.\n\n' })
      }
      break
    }

    // Loop detection: only trigger after 4 identical action+selector+value signatures
    // AND only if none of those rounds had any success
    const actionSig = actions.map(a => `${a.action}:${a.params.selector ?? ''}:${a.params.value ?? ''}`).join('|')
    if (actionSig === lastActionSignature) {
      stuckCount++
    } else {
      stuckCount = 0
    }
    lastActionSignature = actionSig
    // Note: we check stuckCount AFTER execution — if actions succeed, we reset below

    // Track error patterns across rounds
    const errorSig = lastErrorSignature

    // Pre-action DOM ops: only when tab has a real page loaded
    let preState: Awaited<ReturnType<typeof captureVerificationState>> | undefined
    let preTree: Awaited<ReturnType<typeof getCDPAccessibilityTree>> | null = null

    if (!restricted && tabId > 0) {
      const csAlive = await ensureContentScript(tabId).catch(() => false)
      if (!csAlive) {
        console.warn(`[LocalAI] Content script not available for tab ${tabId} — actions needing DOM will fail`)
      }
      await captureAutomationScreenshot(tabId).catch(() => null)
      preState = await captureVerificationState(tabId)
      preTree = await getCDPAccessibilityTree(tabId).catch(() => null)
    }

    // Execute using the pre-parsed actions array (may include kickstart/retry actions)
    let results = await executeParsedActions(actions, tabId)
    console.log(`[LocalAI] Executed ${results.length} actions: ${results.map(r => `${r.action}=${r.success ? 'OK' : 'FAIL'}${r.error ? `(${r.error.slice(0, 60)})` : ''}`).join(', ')}`)

    // If ALL actions failed due to content script unreachable (blank/restricted tab),
    // auto-recover: convert the user's intent into a background search action
    const allContentScriptFails = results.length > 0 && results.every(r => !r.success && r.error?.includes('Content script unreachable'))
    if (allContentScriptFails && round <= 1) {
      console.log(`[LocalAI] All actions failed (restricted/blank page). Converting to background search...`)
      const userGoal = sessionMessages.filter(m => m.role === 'user').pop()?.content ?? ''
      if (userGoal.length > 5) {
        // Use the search action which works without content script — strip filler words
        const query = userGoal
          .replace(/["""'']/g, '')
          .replace(/\b(bitte|please|kannst du|can you|ich möchte|i want|zeig mir|show me|finde|find|suche|search|go to|open|navigate|visit)\b/gi, '')
          .trim()
          .slice(0, 120)
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Blank tab — searching the web...\n\n' })
        results = await executeParsedActions(
          [{ action: 'search', params: { query } }],
          tabId
        )
        console.log(`[LocalAI] Search fallback results: ${results.map(r => `${r.action}=${r.success ? 'OK' : 'FAIL'}`).join(', ')}`)
        if (results.some(r => r.success)) {
          // Search worked — continue the loop so AI can process results
          hadSuccess = true
        }
      }
    }

    if (results.length === 0 || results.every(r => !r.success)) {
      if (allContentScriptFails && !hadSuccess) {
        console.warn(`[LocalAI] Content script unreachable even after fallback.`)
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Cannot interact with this page. Navigate to a website first.\n\n' })
        break
      }
      // Don't break immediately — let the AI see the error and retry with
      // a different approach (up to 2 consecutive all-fail rounds before giving up)
      consecutiveFailures = (consecutiveFailures ?? 0) + 1
      if (consecutiveFailures >= 3) {
        console.warn(`[LocalAI] ${consecutiveFailures} consecutive all-fail rounds. Stopping.`)
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Actions failed repeatedly. Try a different approach or rephrase your request.\n\n' })
        break
      }
      console.warn(`[LocalAI] All actions failed (attempt ${consecutiveFailures}/3). Letting AI retry...`)
    } else {
      consecutiveFailures = 0  // reset on any success
      stuckCount = 0  // also reset stuck detection on any success
    }

    // Check stuck AFTER execution: only break if 4+ identical rounds AND all failed
    if (stuckCount >= 4 && results.every(r => !r.success)) {
      port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Same action failed 4 times. Try rephrasing or a different approach.\n\n' })
      break
    }

    // Re-check restriction state (may change after navigate actions)
    restricted = await isTabRestricted()

    allParsedActions.push(...actions)
    allResults.push(...results)

    if (results.every(r => r.success)) hadSuccess = true
    if (results.some(r => !r.success)) hadFailure = true

    const progressLine = buildProgressLine(results, round + 1, maxRounds)
    port.postMessage({ type: MSG.STREAM_CHUNK, chunk: `\n\n${progressLine}\n\n` })

    const resultSummary = results
      .map(r => `${r.action}: ${r.success ? r.result : `FAILED - ${r.error}`}`)
      .join('\n')

    if (round >= maxRounds - 1) break

    // --- DOM-dependent ops: SKIP on restricted/blank tabs to avoid wasted time ---
    let postScreenshot: string | undefined
    let followUpA11y: string | undefined
    let freshContext = ''
    let freshPageText = ''
    let stateDiff = ''
    let verification = ''
    const suspiciousSuccess = results.some(r => r.success && r.result?.includes('WARNING: no visible'))
    const anyFailed = results.some(r => !r.success) || suspiciousSuccess
    const userIsActive = results.some(r => r.userActive)

    if (!restricted && tabId > 0) {
      const postState = await captureVerificationState(tabId)
      if (preState) verification = buildVerificationContext(preState, postState)

      const postShot = await captureAutomationScreenshot(tabId).catch(() => null)
      if (postShot) {
        postScreenshot = postShot.dataUrl
        tabState.setScreenshot(tabId, postShot.dataUrl)
        const snap = tabState.get(tabId)
        if (snap?.url) {
          recordPageVisit(extractDomainFromUrl(snap.url), snap.url, snap, postShot.dataUrl).catch(() => {})
        }
      }

      const hasNav = results.some(r => r.success && (NAV_ACTIONS.has(r.action) || r.result?.includes('navigated')))
      if (hasNav) {
        await sleep(1500)
        await ensureContentScript(tabId).catch(() => false)
        await sleep(500)
        await requestFreshSnapshot(tabId)
        restricted = await isTabRestricted()
      }

      if (!restricted) {
        // Get fresh page state via CDP accessibility tree (no markers needed —
        // text selectors are more reliable than element IDs on dynamic sites)
        const postTree2 = await getCDPAccessibilityTree(tabId).catch(() => null)
        if (postTree2) {
          followUpA11y = postTree2.treeText
          if (preTree) stateDiff = buildStateDiff(preTree.elements, postTree2.elements)
        }

        await requestFreshSnapshot(tabId)
        freshContext = tabState.summarize(tabId)
        const freshSnap = tabState.get(tabId)
        freshPageText = (freshSnap?.completePageText ?? '').slice(0, 6000)
      }
    } else {
      console.log(`[LocalAI] Skipping DOM ops on restricted tab — building lightweight follow-up`)
    }

    // Error tracking
    const failedActions = results.filter(r => !r.success)
    const failDetail = failedActions.map(r => `- ${r.action}: ${r.error ?? 'failed'}`).join('\n')
    const currentErrorSig = failedActions.map(r => classifyError(r.error ?? '')).sort().join('|')
    if (currentErrorSig && currentErrorSig === errorSig) { errorRepeatCount++ }
    else { errorRepeatCount = currentErrorSig ? 1 : 0 }
    lastErrorSignature = currentErrorSig

    let palaceHints = ''
    if (anyFailed) {
      const s = await getAllSettings().catch(() => null)
      if (s && mempalaceEnabled(s)) {
        const failQuery = failedActions.map(r => r.error ?? r.action).join(' ').slice(0, 200)
        const snap = tabState.get(tabId)
        const domain = snap?.url ? extractDomainFromUrl(snap.url) : ''
        const hints = await recallRelevantMemories(s, failQuery, domain).catch(() => '')
        if (hints) palaceHints = `\n\nMEMORY FROM PAST SESSIONS:\n${hints}\n`
        for (const r of failedActions) {
          recordActionFailure(s, r, {
            url: snap?.url ?? '',
            domain,
            userGoal: sessionMessages.filter(m => m.role === 'user').pop()?.content?.slice(0, 200),
            attempt: actions.map(a => `${a.action}(${a.params.selector ?? ''})`).join(', ').slice(0, 300),
          }).catch(() => {})
        }
      }
    }

    // Build follow-up content based on tab state
    let followUpContent: string

    if (restricted) {
      // LIGHTWEIGHT follow-up for blank/restricted tabs — no DOM context, just results + clear guidance
      const hasSearchResults = results.some(r => r.action === 'search' && r.success && r.result)
      const guidance = hasSearchResults
        ? `\nYou searched successfully. Now you MUST use the URLs from the results above:\n- [ACTION:OPEN_TAB url="<url>"] — read a search result page (can open multiple in parallel)\n- [ACTION:NAVIGATE url="<url>"] — go to a specific website in this tab\nDo NOT search again. Read the pages, then answer the user.\n`
        : `\nYou are on a blank tab. Use [ACTION:SEARCH query="..."] or [ACTION:NAVIGATE url="..."].\n`

      followUpContent = `Action results:\n${resultSummary}\n${guidance}${palaceHints}\nRound ${round + 2}/${maxRounds}. Act on the results above — do NOT repeat the same action.`
    } else {
      let failureInstructions = ''
      if (anyFailed) {
        const errorTypes = new Set(failedActions.map(r => classifyError(r.error ?? '')))
        const specificHints = buildErrorSpecificHints(errorTypes, errorRepeatCount, suspiciousSuccess)
        failureInstructions = `\nACTIONS FAILED:\n${failDetail}\n${specificHints}\nTry a DIFFERENT approach.\n`
      }
      let visualVerification = ''
      if (postScreenshot) {
        visualVerification = '\nScreenshot attached — verify actions worked visually.\n'
      }
      // Cap a11y tree and page text to prevent context overflow on later rounds
      const a11yMaxChars = round < 2 ? 8000 : 4000
      const pageTextMaxChars = round < 2 ? 4000 : 2000
      const cappedA11y = followUpA11y ? followUpA11y.slice(0, a11yMaxChars) : ''
      const a11ySection = cappedA11y ? `\nAccessibility Tree:\n${cappedA11y}\n` : ''
      // freshContext from tabState.summarize() already includes page text excerpts,
      // so only add freshPageText when a11y tree is NOT present (it provides richer info)
      const extraPageText = (!cappedA11y && freshPageText) ? freshPageText.slice(0, pageTextMaxChars) : ''
      followUpContent = `Action results:\n${resultSummary}\n\n${verification}${stateDiff ? `\nELEMENT STATE CHANGES:\n${stateDiff}\n` : ''}${visualVerification}\n${failureInstructions}${palaceHints.slice(0, 1000)}${userIsActive ? '\nUser is also interacting.\n' : ''}Updated page state:\n${freshContext}${a11ySection}${extraPageText ? `\n\nPage Content (excerpt):\n${extraPageText}\n` : ''}\n\nRound ${round + 2}/${maxRounds}. ${anyFailed ? 'RETRY with a DIFFERENT approach.' : 'Continue if more steps needed, or give a SHORT summary.'}`
    }

    const followUpMessages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] = [
      ...sessionMessages.map(m => ({ ...m, imageData: undefined as string | undefined })),
      { role: 'assistant' as const, content: response, imageData: undefined },
      { role: 'user' as const, content: followUpContent, imageData: postScreenshot },
    ]

    if (isCancelled(tabId)) {
      port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Automation stopped by user.\n\n' })
      break
    }

    // ── Token-aware context management ────────────────────────────────
    const isLocal = (settings.activeProvider ?? 'local') === 'local'
    const ctxWindow = settings.contextWindowTokens || (isLocal ? 32768 : 131072)
    const followUpMaxTokens = isLocal ? 1024 : 4096
    const hasScreenshot = followUpMessages.some(m => !!m.imageData)

    // Estimate total input tokens and truncate if needed
    const totalInputTokens = followUpMessages.reduce((sum, m) =>
      sum + estimateTokens(m.content ?? '') + (m.imageData ? 1000 : 0), 0)
    const safeInputLimit = ctxWindow - followUpMaxTokens - 500 // 500 token safety margin

    let truncatedMessages = followUpMessages
    if (totalInputTokens > safeInputLimit) {
      console.log(`[LocalAI] Follow-up context too large: ~${totalInputTokens} tokens (limit ~${safeInputLimit}). Truncating...`)
      truncatedMessages = truncateMessagesToFit(followUpMessages, 0, ctxWindow, followUpMaxTokens + 500)
    }

    console.log(`[LocalAI] Calling AI for round ${round + 2}... (tokens≈${totalInputTokens}, maxCtx=${ctxWindow}, restricted=${restricted})`)
    // Notify user that a follow-up is in progress (model may be slow)
    port.postMessage({ type: MSG.STREAM_CHUNK, chunk: `\n\n> Round ${round + 2}: thinking...\n` })

    // Generous timeout — local models can be very slow (user accepts 20-30 min waits)
    const followUpPromise = callAI(truncatedMessages, settings, followUpMaxTokens, hasScreenshot)
    const timeoutMs = isLocal ? 30 * 60_000 : 5 * 60_000
    let followUp = await Promise.race([
      followUpPromise,
      new Promise<string>(resolve => setTimeout(() => resolve(''), timeoutMs)),
    ])

    // ── Retry logic: up to 3 attempts on empty response with progressive context reduction
    const MAX_FOLLOWUP_RETRIES = 3
    for (let retryAttempt = 0; retryAttempt < MAX_FOLLOWUP_RETRIES && !followUp; retryAttempt++) {
      if (retryAttempt === 0 && hasScreenshot) {
        // First retry: remove images (might be too large for model)
        console.log(`[LocalAI] Follow-up empty, retry 1/${MAX_FOLLOWUP_RETRIES}: removing images...`)
        const noImageMsgs = truncatedMessages.map(m => ({ ...m, imageData: undefined }))
        followUp = await callAI(noImageMsgs, settings, followUpMaxTokens)
      } else if (retryAttempt === 1) {
        // Second retry: aggressively truncate — keep only last 2 messages + reduce output
        console.log(`[LocalAI] Follow-up empty, retry 2/${MAX_FOLLOWUP_RETRIES}: minimal context...`)
        const minimalMsgs = truncatedMessages.slice(-2).map(m => ({ ...m, imageData: undefined }))
        followUp = await callAI(minimalMsgs, settings, Math.min(followUpMaxTokens, 2048))
      } else {
        // Third retry: last 2 messages with image, small output — give model visual cues
        console.log(`[LocalAI] Follow-up empty, retry 3/${MAX_FOLLOWUP_RETRIES}: last resort with screenshot...`)
        await new Promise(r => setTimeout(r, 2000))
        const lastResort = truncatedMessages.slice(-2)
        followUp = await callAI(lastResort, settings, Math.min(followUpMaxTokens, 1024), hasScreenshot)
      }
    }

    if (followUp) {
      if (isRepetitiveOutput(followUp)) {
        break
      }
      const cleanedFollowUp = stripActionMarkersForDisplay(followUp)
      if (cleanedFollowUp.trim()) {
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: cleanedFollowUp })
      }
      response = followUp
    } else {
      port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> AI did not respond after multiple retries — model may be overloaded or request too large.\n\n' })
      break
    }

    round++
  }

  if (hadFailure && !hadSuccess && !isCancelled(tabId)) {
    const failedCount = allResults.filter(r => !r.success).length
    const totalCount = allResults.length
    port.postMessage({
      type: MSG.STREAM_CHUNK,
      chunk: `\n\n> Task incomplete: ${failedCount}/${totalCount} actions failed after ${round} rounds. The requested changes may not have been applied. Please verify the page state manually.\n\n`,
    })
  }

  clearCancellation(tabId)
  signalActivity(tabId, false)

  // ── Release CDP session ──────────────────────────────────────────────
  if (cdpSession) {
    await releaseSession(tabId).catch(() => {})
    console.log(`[LocalAI] CDP session released for tab ${tabId}`)
  }

  learnFromExecution(tabId, sessionMessages, allParsedActions, allResults, hadSuccess, hadFailure)
}

const MALFORMED_RE = /call:[\w]*:?[\w]*\{/i

function containsMalformedActions(text: string): boolean {
  // Check for known wrong formats
  if (MALFORMED_RE.test(text)) return true
  // Check for bracket actions that failed to parse (e.g., [ACTION:click ...] exists but params didn't match)
  if (/\[ACTION:\w+/i.test(text) && parseActionsFromText(text).length === 0) return true
  // Check for tool-call-like formats
  if (/<\|?tool_?call/i.test(text)) return true
  return false
}

// ─── Smart intent detection & auto-kickstart ────────────────────────────────
// When the AI doesn't produce actions, detect what the user wants and inject actions

const SEARCH_INTENT_RE = /\b(suche?n?|find|search|flug|fl[üu]ge?|tickets?|book|buchen|finde|zeig mir|compare|vergleich|price|preis|hotel|rental|miete|kaufen?|shop|cheapest|günstigste|billigste|angebot|reise|travel|flight)\b/i
const NAVIGATE_INTENT_RE = /\b(go to|open|navigate|visit|gehe? zu|öffne|besuche?)\b/i
const ANALYZE_INTENT_RE = /\b(analy[sz]e?|report|bericht|check|prüfe?|investigate|untersuche?|research|recherche)\b/i

function detectIntentAndKickstart(userText: string): ParsedAction[] {
  const lower = userText.toLowerCase()

  // URL in the text — navigate to it (any URL in the message implies navigation)
  const urlMatch = userText.match(/https?:\/\/[^\s]+/)
  if (urlMatch) {
    return [{ action: 'navigate', params: { url: urlMatch[0] } }]
  }

  // Search intent — extract key terms and search Google
  if (SEARCH_INTENT_RE.test(lower)) {
    // Build a search query from the user's text, stripping filler
    const query = userText
      .replace(/["""'']/g, '')
      .replace(/\b(bitte|please|kannst du|can you|ich möchte|i want|zeig mir|show me|finde|find|suche|search)\b/gi, '')
      .trim()
      .slice(0, 120)
    if (query.length > 5) {
      return [{ action: 'search', params: { query } }]
    }
  }

  // Analyze intent — read the current page first
  if (ANALYZE_INTENT_RE.test(lower)) {
    return [{ action: 'get_page_text', params: {} }]
  }

  return []
}

/** Check if the AI signalled task completion via is_complete: true in JSON. */
function checkIsComplete(text: string): boolean {
  const match = text.match(/"is_complete"\s*:\s*(true|false)/i)
  return match?.[1]?.toLowerCase() === 'true'
}

function isRepetitiveOutput(text: string): boolean {
  if (text.length > 2000) {
    const first500 = text.slice(0, 500)
    const rest = text.slice(500)
    if (rest.includes(first500.slice(0, 200))) return true
  }
  const malformedCount = (text.match(/call:[\w]*:?[\w]*\{/gi) ?? []).length
  if (malformedCount >= 3) return true
  return false
}

function buildProgressLine(results: AIActionResult[], round: number, maxRounds: number): string {
  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length
  const actions = results.map(r => {
    const icon = r.success ? '✓' : '✗'
    const raw = r.success
      ? (r.result ?? r.action).slice(0, 40)
      : `${r.action}: ${(r.error ?? 'failed').slice(0, 40)}`
    const desc = sanitizeProgressText(raw)
    return `${icon} ${desc}`
  })
  const stepLabel = `Step ${round}/${maxRounds}`
  const summary = failed > 0
    ? `${stepLabel} — ${succeeded} done, ${failed} failed`
    : `${stepLabel} — ${succeeded} action${succeeded !== 1 ? 's' : ''} completed`
  return `> ${summary}\n${actions.map(a => `> ${a}`).join('\n')}`
}

function sanitizeProgressText(text: string): string {
  const jsPattern = /^\(function|^var |^const |^let |^\/\/|^\/\*|^\{|^import |^export |^if\s*\(|^try\s*\{|^window\./
  if (jsPattern.test(text.trimStart())) return '(element)'
  return text.slice(0, 40)
}

function stripActionMarkersForDisplay(text: string): string {
  let out = stripMalformedActions(text)
  out = out.replace(/\[ACTION:\w+[^\]]*\]/g, '')
  out = out.replace(/\{[\s\S]*?"action"\s*:\s*"[^"]+?"[\s\S]*?\}/g, '')
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return sanitizeModelOutput(out)
}

function signalActivity(tabId: number, show: boolean): void {
  if (tabId <= 0) return
  const type = show ? MSG.SHOW_ACTIVITY_BORDER : MSG.HIDE_ACTIVITY_BORDER
  chrome.tabs.sendMessage(tabId, { type }).catch(() => {})
}

function learnFromExecution(
  tabId: number,
  sessionMessages: Pick<ChatMessage, 'role' | 'content'>[],
  allActions: ParsedAction[],
  allResults: AIActionResult[],
  hadSuccess: boolean,
  hadFailure: boolean
): void {
  const snap = tabState.get(tabId)
  if (!snap?.url) return

  const domain = extractDomainFromUrl(snap.url)
  if (!domain) return

  const userMsgs = sessionMessages.filter(m => m.role === 'user')
  const lastUserMsg = userMsgs[userMsgs.length - 1]?.content ?? ''
  const taskPattern = extractTaskPattern(lastUserMsg)

  getAllSettings()
    .then(settings => {
      const ctx = { url: snap.url, domain, userGoal: lastUserMsg.slice(0, 200) }

      for (const r of allResults) {
        if (!r.success) {
          recordActionFailure(settings, r, {
            ...ctx,
            attempt: allActions.map(a => `${a.action}(${a.params.selector ?? ''})`).join(', ').slice(0, 300),
          }).catch(() => {})
        }
      }

      if (hadSuccess) {
        const successResults = allResults.filter(r => r.success)
        if (successResults.length > 0) {
          const approach = allActions.map(a => `${a.action}(${a.params.selector ?? a.params.value ?? ''})`).join(' -> ').slice(0, 400)
          recordActionSuccess(settings, successResults[successResults.length - 1], {
            ...ctx,
            approach,
          }).catch(() => {})
        }
      }
    })
    .catch(() => {})

  if (!taskPattern) return

  if (hadSuccess) {
    const sequence = buildCompactSequence(allActions, allResults)
    if (sequence) {
      saveOrReinforceSkill({
        domain,
        taskPattern,
        actionSequence: sequence,
        successCount: 1,
        failureCount: 0,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      }).catch(() => {})
    }
  }

  if (hadFailure && !hadSuccess) {
    recordSkillFailure(domain, taskPattern).catch(() => {})
  }
}

function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

type ErrorCategory = 'not_found' | 'nothing_changed' | 'unreachable' | 'user_active' | 'other'

function classifyError(error: string): ErrorCategory {
  const lower = error.toLowerCase()
  if (lower.includes('not found') || lower.includes('not on page') || lower.includes('recovery failed')) return 'not_found'
  if (lower.includes('no visible') || lower.includes('nothing changed') || lower.includes('unchanged')) return 'nothing_changed'
  if (lower.includes('unreachable') || lower.includes('restricted page')) return 'unreachable'
  if (lower.includes('user_active')) return 'user_active'
  return 'other'
}

function buildErrorSpecificHints(errorTypes: Set<ErrorCategory>, repeatCount: number, suspiciousSuccess: boolean): string {
  const hints: string[] = []

  if (errorTypes.has('not_found')) {
    if (repeatCount >= 2) {
      hints.push(`ELEMENT NOT FOUND (repeated ${repeatCount}x) — ESCALATED STRATEGIES:
1. The element may not exist. Use [ACTION:READ_PAGE filter="all"] to see the FULL page content.
2. The page may have changed — use [ACTION:SCREENSHOT] to see what's actually visible.
3. Try [ACTION:NAVIGATE url="..."] to go directly to the target page.
4. The element may be inside an iframe or shadow DOM — try a completely different approach.`)
    } else {
      hints.push(`ELEMENT NOT FOUND — try:
1. [ACTION:SCROLL direction="down"] then [ACTION:READ_PAGE filter="interactive"] — element may be off-screen.
2. Use [ACTION:READ_PAGE filter="interactive"] to get fresh element IDs, then use JSON format {"element_id": ID, "action": "click"}.
3. Try SHORTER/PARTIAL text — the element text may differ from what you expect.
4. Try a CSS SELECTOR from the page state instead of text.`)
    }
  }

  if (errorTypes.has('nothing_changed') || suspiciousSuccess) {
    if (repeatCount >= 2) {
      hints.push(`NOTHING CHANGED (repeated ${repeatCount}x) — ESCALATED STRATEGIES:
1. You are clicking the WRONG element. STOP and use [ACTION:READ_PAGE filter="interactive"] to find the correct one.
2. The target may be a LABEL, not the actual control — try the PARENT or NEARBY interactive element.
3. Use [ACTION:TOGGLE] instead of [ACTION:CLICK] for checkboxes/switches.
4. The page may use JavaScript handlers — try dispatching keyboard events: [ACTION:KEYPRESS key="Enter"] after focusing.`)
    } else {
      hints.push(`NOTHING CHANGED — your click may have hit the wrong element:
1. Use [ACTION:READ_PAGE filter="interactive"] to see element states and find the correct target.
2. Try the PARENT or a NEARBY interactive element — you may have clicked a label instead of the control.
3. Use [ACTION:TOGGLE] for switches/checkboxes instead of [ACTION:CLICK].
4. Verify with [ACTION:SCREENSHOT] — the visual layout may not match what you expect.`)
    }
  }

  if (errorTypes.has('unreachable')) {
    hints.push(`CONTENT SCRIPT UNREACHABLE — the tab may be:
1. A chrome:// or extension page (cannot automate).
2. Closed or navigated away. Check with [ACTION:GET_PAGE_STATE].
3. Try [ACTION:WAIT ms="2000"] and retry — the page may still be loading.`)
  }

  if (hints.length === 0) {
    hints.push(`RETRY STRATEGIES:
1. Use [ACTION:READ_PAGE filter="interactive"] to see current page elements with IDs.
2. Use [ACTION:SCREENSHOT] to visually confirm page state.
3. Try a completely different selector or approach.
4. Use element IDs from the accessibility tree: {"element_id": ID, "action": "click"}.`)
  }

  return hints.join('\n\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
