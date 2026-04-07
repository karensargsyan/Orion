import { MSG } from '../shared/constants'
import type { AIAction, AIActionResult, Settings, ChatMessage, PageSnapshot } from '../shared/types'
import { streamChat, callAI } from './ai-client'
import type { StreamPort } from './ai-client'
import { tabState } from './tab-state'

const ACTION_PATTERN = /\[ACTION:(\w+)([^\]]*)\]/g
const MAX_INJECT_RETRIES = 2
const USER_ACTIVE_RETRY_DELAY = 2000

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

    const paramPattern = /(\w+)="([^"]*)"/g
    let pm: RegExpExecArray | null
    while ((pm = paramPattern.exec(paramStr)) !== null) {
      params[pm[1]] = pm[2]
    }

    actions.push({ action, params })
  }

  return actions
}

function toAIAction(parsed: ParsedAction): AIAction {
  switch (parsed.action) {
    case 'click':
      return { action: 'click', selector: parsed.params.selector }
    case 'type':
      return { action: 'type', selector: parsed.params.selector, value: parsed.params.value }
    case 'navigate':
      return { action: 'navigate', url: parsed.params.url }
    case 'scroll':
      return { action: 'scroll', value: parsed.params.direction ?? 'down' }
    case 'read':
      return { action: 'read', selector: parsed.params.selector }
    case 'select':
      return { action: 'select', selector: parsed.params.selector }
    case 'screenshot':
      return { action: 'screenshot' }
    case 'select_option':
      return { action: 'select_option', selector: parsed.params.selector, value: parsed.params.value }
    case 'check':
      return { action: 'check', selector: parsed.params.selector, value: parsed.params.value }
    case 'clear':
      return { action: 'clear', selector: parsed.params.selector }
    case 'wait':
      return { action: 'wait', value: parsed.params.ms ?? '1000' }
    case 'read_options':
      return { action: 'read_options', selector: parsed.params.selector }
    case 'get_page_state':
      return { action: 'get_page_state' }
    default:
      return { action: parsed.action as AIAction['action'], selector: parsed.params.selector, value: parsed.params.value }
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

export async function executeActionsFromText(
  text: string,
  tabId: number
): Promise<AIActionResult[]> {
  const parsed = parseActionsFromText(text)
  if (parsed.length === 0) return []

  const results: AIActionResult[] = []

  for (const p of parsed) {
    const action = toAIAction(p)
    const result = await executeSingleAction(action, tabId)
    results.push(result)

    if (result.success) {
      await requestFreshSnapshot(tabId)
    }
    await sleep(300)
  }

  return results
}

async function executeSingleAction(action: AIAction, tabId: number): Promise<AIActionResult> {
  if (action.action === 'screenshot') {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 60 })
      tabState.setScreenshot(tabId, dataUrl)
      return { action: 'screenshot', success: true, result: 'Screenshot captured' }
    } catch (err) {
      return { action: 'screenshot', success: false, error: String(err) }
    }
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

export async function executeWithFollowUp(
  aiResponse: string,
  tabId: number,
  settings: Settings,
  port: StreamPort,
  sessionMessages: Pick<ChatMessage, 'role' | 'content'>[],
  maxRounds = 8
): Promise<void> {
  let response = aiResponse
  let round = 0

  while (round < maxRounds) {
    const actions = parseActionsFromText(response)
    if (actions.length === 0) break

    const results = await executeActionsFromText(response, tabId)
    if (results.length === 0) break

    const resultSummary = results
      .map(r => `${r.action}: ${r.success ? r.result : `FAILED - ${r.error}`}`)
      .join('\n')

    port.postMessage({
      type: MSG.STREAM_CHUNK,
      chunk: `\n\n> Executed ${results.length} action(s):\n> ${resultSummary.replace(/\n/g, '\n> ')}\n\n`,
    })

    const anyFailed = results.some(r => !r.success)
    if (round >= maxRounds - 1) break

    await requestFreshSnapshot(tabId)
    const freshContext = tabState.summarize(tabId)
    const userIsActive = results.some(r => r.userActive)

    const followUp = await callAI([
      ...sessionMessages,
      { role: 'assistant', content: response },
      {
        role: 'user',
        content: `Action results:\n${resultSummary}\n\n${userIsActive ? '⚠️ The user is also interacting with the page right now. Coordinate carefully.\n\n' : ''}${anyFailed ? 'Some actions failed. Look at the error messages — they list available buttons. Try again using the correct button text or selector.\n\n' : ''}Updated page state:\n${freshContext}\n\nYou are round ${round + 2} of ${maxRounds}. Continue clicking/navigating if more steps are needed to complete the user's request. When done, summarize what you found or did.`,
      },
    ], settings, 2048)

    if (followUp) {
      port.postMessage({ type: MSG.STREAM_CHUNK, chunk: followUp })
      response = followUp
    } else {
      break
    }

    round++
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
