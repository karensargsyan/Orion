import { MSG } from '../shared/constants'
import type { AIAction, AIActionResult, Settings, ChatMessage, PageSnapshot, FillAssignment } from '../shared/types'
import { streamChat, callAI } from './ai-client'
import type { StreamPort } from './ai-client'
import { tabState } from './tab-state'
import { searchGoogle, openAndReadTab } from './web-researcher'
import { sanitizeModelOutput, stripMalformedActions } from '../shared/sanitize-output'
import { extractTaskPattern, buildCompactSequence, saveOrReinforceSkill, recordSkillFailure } from './skill-manager'
import { recordActionFailure, recordActionSuccess, recallRelevantMemories } from './mempalace-learner'
import { getAllSettings } from './memory-manager'
import { mempalaceEnabled, searchMempalace } from './mempalace-client'
import { getCDPAccessibilityTree } from './cdp-accessibility'
import { captureMiniMap } from './minimap-screenshot'
import { recordPageVisit, getPageScreenshot } from './visual-sitemap'

const ACTION_PATTERN = /\[ACTION:(\w+)([^\]]*)\]/g
const MAX_INJECT_RETRIES = 2
const USER_ACTIVE_RETRY_DELAY = 2000
const NAV_ACTIONS = new Set(['navigate', 'back', 'forward'])

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

    const paramPattern = /(\w+)=(?:"([^"]*)"|'([^']*)')/g
    let pm: RegExpExecArray | null
    while ((pm = paramPattern.exec(paramStr)) !== null) {
      params[pm[1]] = pm[2] ?? pm[3]
    }

    actions.push({ action, params })
  }

  if (actions.length === 0) {
    const jsonActions = parseJSONActions(text)
    actions.push(...jsonActions)
  }

  return actions
}

interface JSONActionPayload {
  thought?: string
  element_id?: string | number
  action?: string
  text_content?: string
  point?: [number, number]
  selector?: string
  url?: string
  value?: string
  is_complete?: boolean
}

function payloadToParsed(payload: JSONActionPayload): ParsedAction | null {
  if (!payload.action) return null

  const action = payload.action.toLowerCase()
  const params: Record<string, string> = {}

  if (payload.element_id !== undefined) params.markerId = String(payload.element_id)
  if (payload.selector) params.selector = payload.selector
  if (payload.text_content) params.value = payload.text_content
  if (payload.value) params.value = payload.value
  if (payload.url) params.url = payload.url
  if (payload.point) {
    params.x = String(payload.point[0])
    params.y = String(payload.point[1])
  }

  if (action === 'scroll_down') return { action: 'scroll', params: { direction: 'down' } }
  if (action === 'scroll_up') return { action: 'scroll', params: { direction: 'up' } }
  if (action === 'wait') return { action: 'wait', params: { ms: '1500' } }

  return { action, params }
}

function parseJSONActions(text: string): ParsedAction[] {
  // Try 1: JSON array  [{...}, {...}]
  const arrayMatch = text.match(/\[[\s\S]*?\{[\s\S]*?"action"[\s\S]*?\}[\s\S]*?\]/)
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[0]) as unknown
      if (Array.isArray(arr)) {
        const results: ParsedAction[] = []
        for (const item of arr) {
          const p = payloadToParsed(item as JSONActionPayload)
          if (p) results.push(p)
        }
        if (results.length > 0) return results
      }
    } catch { /* not valid JSON array, try next */ }
  }

  // Try 2: Multiple JSON objects (line-delimited or separated by text)
  const jsonObjectPattern = /\{[^{}]*?"action"\s*:\s*"[^"]+?"[^{}]*?\}/g
  const matches = text.match(jsonObjectPattern)
  if (matches && matches.length > 1) {
    const results: ParsedAction[] = []
    for (const m of matches) {
      try {
        const payload = JSON.parse(m) as JSONActionPayload
        const p = payloadToParsed(payload)
        if (p) results.push(p)
      } catch { /* skip invalid */ }
    }
    if (results.length > 0) return results
  }

  // Try 3: Single JSON object
  if (matches && matches.length === 1) {
    try {
      const payload = JSON.parse(matches[0]) as JSONActionPayload
      const p = payloadToParsed(payload)
      if (p) return [p]
    } catch { /* not valid */ }
  }

  return []
}

function toAIAction(parsed: ParsedAction): AIAction {
  const selector = parsed.params.selector ?? parsed.params.text
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
    default:
      return { action: parsed.action as AIAction['action'], selector, value: parsed.params.value }
  }
}

export async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      return false
    }
  } catch {
    return false
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.PING })
    return true
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-main.js'],
      })
      await sleep(400)
      await chrome.tabs.sendMessage(tabId, { type: MSG.PING })
      return true
    } catch {
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
  'screenshot', 'get_page_state', 'read_page',
  'fill_form', 'search', 'read_tab',
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

export async function executeActionsFromText(
  text: string,
  tabId: number
): Promise<AIActionResult[]> {
  const parsed = parseActionsFromText(text)
  if (parsed.length === 0) return []

  const allActions = parsed.map(p => toAIAction(p))
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
        if (isNavAction) await sleep(1500)
      }
    } else {
      // Parallel batch — execute all simultaneously
      const batchResults = await Promise.all(
        batch.map(action => executeSingleAction(action, tabId))
      )
      results.push(...batchResults)
    }

    // Refresh snapshot + capture verification screenshot after each batch
    const lastResult = results[results.length - 1]
    if (lastResult?.success) {
      await requestFreshSnapshot(tabId)
      // Take a verification screenshot after every action batch
      try {
        const verifyShot = await captureMiniMap(tabId).catch(() => null)
        if (verifyShot) {
          tabState.setScreenshot(tabId, verifyShot.dataUrl)
          // Record in visual sitemap
          const snap = tabState.get(tabId)
          if (snap?.url) {
            const domain = extractDomainFromUrl(snap.url)
            recordPageVisit(domain, snap.url, snap, verifyShot.dataUrl).catch(() => {})
          }
        }
      } catch { /* screenshot not critical */ }
    }
    await sleep(200)
  }

  return results
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

  if (action.action === 'read_page') {
    return await executeReadPage(action, tabId)
  }

  if (action.action === 'search') {
    try {
      const results = await searchGoogle(action.value ?? '')
      const formatted = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
      return { action: 'search', success: true, result: formatted || 'No results found' }
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
    return { action: 'close_tab', success: true, result: 'Research tab closed' }
  }

  if (action.markerId && (action.action === 'click' || action.action === 'type')) {
    return await executeMarkerAction(action, tabId)
  }

  const AI_ID_ROUTABLE_ACTIONS = new Set([
    'hover', 'doubleclick', 'focus', 'check', 'toggle', 'select_option', 'clear', 'scroll_to',
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
  maxRounds = 12
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

  signalActivity(tabId, true)

  while (round < maxRounds) {
    const actions = parseActionsFromText(response)
    if (actions.length === 0) {
      if (containsMalformedActions(response)) {
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Model used wrong action format. Retrying...\n\n' })
      } else if (round === 0) {
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> No executable actions found in model response. The model may have described actions instead of emitting them.\n\n' })
      }
      break
    }

    const actionSig = actions.map(a => `${a.action}:${a.params.selector ?? a.params.value ?? ''}`).join('|')
    if (actionSig === lastActionSignature) {
      stuckCount++
      if (stuckCount >= 2) {
        port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n> Detected repeated actions. Stopping to avoid loops.\n\n' })
        break
      }
    } else {
      stuckCount = 0
    }
    lastActionSignature = actionSig

    // Track error patterns across rounds
    const errorSig = lastErrorSignature

    let preScreenshot: string | undefined
    if (tabId > 0) {
      const preMiniMap = await captureMiniMap(tabId).catch(() => null)
      if (preMiniMap) preScreenshot = preMiniMap.dataUrl
    }

    // Capture pre-action state including accessibility tree for state diff
    const preState = await captureVerificationState(tabId)
    const preTree = tabId > 0 ? await getCDPAccessibilityTree(tabId).catch(() => null) : null

    const results = await executeActionsFromText(response, tabId)
    if (results.length === 0) break
    const postState = await captureVerificationState(tabId)

    let postScreenshot: string | undefined
    if (tabId > 0) {
      const postMiniMap = await captureMiniMap(tabId).catch(() => null)
      if (postMiniMap) {
        postScreenshot = postMiniMap.dataUrl
        tabState.setScreenshot(tabId, postMiniMap.dataUrl)
        // Record post-action state in visual sitemap
        const snap = tabState.get(tabId)
        if (snap?.url) {
          const domain = extractDomainFromUrl(snap.url)
          recordPageVisit(domain, snap.url, snap, postMiniMap.dataUrl).catch(() => {})
        }
      }
    }

    allParsedActions.push(...actions)
    allResults.push(...results)

    const roundAllSucceeded = results.every(r => r.success)
    if (roundAllSucceeded) {
      hadSuccess = true
      if (hadFailure) {
        const s = await getAllSettings().catch(() => null)
        if (s && mempalaceEnabled(s)) {
          const snap = tabState.get(tabId)
          const domain = snap?.url ? extractDomainFromUrl(snap.url) : ''
          const successR = results[results.length - 1]
          const approach = actions.map(a => `${a.action}(${a.params.selector ?? a.params.value ?? ''})`).join(' -> ').slice(0, 400)
          recordActionSuccess(s, successR, {
            url: snap?.url ?? '',
            domain,
            userGoal: sessionMessages.filter(m => m.role === 'user').pop()?.content?.slice(0, 200),
            approach: `After earlier failures, THIS approach worked: ${approach}`,
          }).catch(() => {})
        }
      }
    }
    if (results.some(r => !r.success)) hadFailure = true

    const verification = buildVerificationContext(preState, postState)

    const progressLine = buildProgressLine(results, round + 1, maxRounds)
    port.postMessage({ type: MSG.STREAM_CHUNK, chunk: `\n\n${progressLine}\n\n` })

    const resultSummary = results
      .map(r => `${r.action}: ${r.success ? r.result : `FAILED - ${r.error}`}`)
      .join('\n')

    const suspiciousSuccess = results.some(r => r.success && r.result?.includes('WARNING: no visible'))

    if (round >= maxRounds - 1) break

    let followUpA11y: string | undefined
    let postTree: Awaited<ReturnType<typeof getCDPAccessibilityTree>> | null = null

    if (tabId > 0) {
      postTree = await getCDPAccessibilityTree(tabId).catch(() => null)
      if (postTree) {
        followUpA11y = postTree.treeText
      } else {
        try {
          const markerResult = await chrome.tabs.sendMessage(tabId, { type: MSG.INJECT_MARKERS }) as { ok: boolean; accessibilityTree?: string }
          if (markerResult?.ok) followUpA11y = markerResult.accessibilityTree
        } catch { /* ignore */ }

        try {
          await chrome.tabs.sendMessage(tabId, { type: MSG.REMOVE_MARKERS })
        } catch { /* ignore */ }
      }
    }

    // Build element state diff
    const stateDiff = (preTree && postTree) ? buildStateDiff(preTree.elements, postTree.elements) : ''

    const imageData = postScreenshot

    await requestFreshSnapshot(tabId)
    const freshContext = tabState.summarize(tabId)
    const userIsActive = results.some(r => r.userActive)
    const anyFailed = results.some(r => !r.success) || suspiciousSuccess
    const a11ySection = followUpA11y ? `\nAccessibility Tree:\n${followUpA11y}\n` : ''

    const failedActions = results.filter(r => !r.success)
    const failDetail = failedActions.map(r => `- ${r.action}: ${r.error ?? 'failed'}`).join('\n')

    // Track error patterns for adaptive recovery
    const currentErrorSig = failedActions.map(r => classifyError(r.error ?? '')).sort().join('|')
    if (currentErrorSig && currentErrorSig === errorSig) {
      errorRepeatCount++
    } else {
      errorRepeatCount = currentErrorSig ? 1 : 0
    }
    lastErrorSignature = currentErrorSig

    let palaceHints = ''
    if (anyFailed) {
      const s = await getAllSettings().catch(() => null)
      if (s && mempalaceEnabled(s)) {
        const failQuery = failedActions.map(r => r.error ?? r.action).join(' ').slice(0, 200)
        const snap = tabState.get(tabId)
        const domain = snap?.url ? extractDomainFromUrl(snap.url) : ''
        const hints = await recallRelevantMemories(s, failQuery, domain).catch(() => '')
        if (hints) palaceHints = `\n\nMEMORY FROM PAST SESSIONS (lessons from previous mistakes):\n${hints}\n`

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

    let failureInstructions = ''
    if (anyFailed) {
      // Build error-type-specific recovery hints
      const errorTypes = new Set(failedActions.map(r => classifyError(r.error ?? '')))
      const specificHints = buildErrorSpecificHints(errorTypes, errorRepeatCount, suspiciousSuccess)

      failureInstructions = `
ACTIONS FAILED OR HAD NO VISIBLE EFFECT — YOU MUST TRY A COMPLETELY DIFFERENT APPROACH:
${failDetail}
${errorRepeatCount >= 2 ? `\nCRITICAL: The SAME error type has repeated ${errorRepeatCount} times. You MUST use a fundamentally different strategy — not a variation of what you tried before.\n` : ''}
${specificHints}
DO NOT repeat the same selector that already failed. DO NOT give up after one failure.
`
    }

    let visualVerification = ''
    if (postScreenshot) {
      visualVerification = '\n\nVISUAL CONFIRMATION: A screenshot of the page AFTER your actions is attached. LOOK at it carefully:\n- Did the element you targeted actually change state?\n- Are toggles/checkboxes in the expected state?\n- Did the page visually change as expected?\n- If it looks wrong, try a different approach immediately.\n'
    }

    const followUpMessages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] = [
      ...sessionMessages.map(m => ({ ...m, imageData: undefined as string | undefined })),
      { role: 'assistant' as const, content: response, imageData: undefined },
      {
        role: 'user' as const,
        content: `Action results:\n${resultSummary}\n\n${verification}${stateDiff ? `\nELEMENT STATE CHANGES:\n${stateDiff}\n` : ''}${visualVerification}\n${failureInstructions}${palaceHints}${userIsActive ? '\nThe user is also interacting. Coordinate carefully.\n' : ''}Updated page state:\n${freshContext}${a11ySection}\n\nRound ${round + 2}/${maxRounds}. ${anyFailed ? 'RETRY with a DIFFERENT approach now.' : 'LOOK at the screenshot to confirm your actions worked. Continue if more steps needed, or give a SHORT summary.'}`,
        imageData,
      },
    ]

    const followUp = await callAI(followUpMessages, settings, 4096)

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
      break
    }

    round++
  }

  if (hadFailure && !hadSuccess) {
    const failedCount = allResults.filter(r => !r.success).length
    const totalCount = allResults.length
    port.postMessage({
      type: MSG.STREAM_CHUNK,
      chunk: `\n\n> Task incomplete: ${failedCount}/${totalCount} actions failed after ${round} rounds. The requested changes may not have been applied. Please verify the page state manually.\n\n`,
    })
  }

  signalActivity(tabId, false)

  learnFromExecution(tabId, sessionMessages, allParsedActions, allResults, hadSuccess, hadFailure)
}

const MALFORMED_RE = /call:[\w]*:?[\w]*\{/i

function containsMalformedActions(text: string): boolean {
  return MALFORMED_RE.test(text)
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
