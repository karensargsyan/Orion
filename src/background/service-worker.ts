import { MSG, DEFAULTS, PORT_AI_STREAM } from '../shared/constants'
import type { Settings, VaultData, VaultCategory, PageSnapshot, ChatMessage } from '../shared/types'
import { tabState } from './tab-state'
import { rateLimiter, streamChat, fetchModels, buildSystemPrompt, abortStream, callAI } from './ai-client'
import {
  setupPin, unlockWithPin, isSessionUnlocked, encryptData, decryptData, changePin,
} from './crypto-manager'
import {
  appendChatMessage, getSessionMessages, getAllSessions, getAllSettings, setSettings,
  vaultList, vaultGet, vaultSet, vaultDelete,
  addSessionMemory, getRecentSessionMemory, getSessionMemoryByDomain, getTabMemory,
  clearSessionMemory, clearGlobalMemory, getAllGlobalMemory, exportMemory, clearChatHistory,
  getDomainStats,
} from './memory-manager'
import { recordAction, flushAllBuffers, flushBuffer, clearTabBuffer } from './action-recorder'
import { matchVaultToForm, matchCredentialsToForm, describeForm } from './form-intelligence'
import { probeEndpoint, quickHealthCheck } from './api-detector'
import { startScreenshotLoop, stopScreenshotLoop, captureScreenshot } from './screenshot-loop'
import { executeActionsFromText, parseActionsFromText, executeWithFollowUp } from './action-executor'
import { analyzeHabits, getHabitPatterns } from './habit-tracker'
import { getAllCalendarEvents } from './calendar-detector'

// ─── Initialization ───────────────────────────────────────────────────────────

let settings: Settings | null = null
const sessionId = `session_${Date.now()}`

async function getSettings(): Promise<Settings> {
  if (!settings) {
    try {
      settings = await getAllSettings()
    } catch {
      settings = {
        lmStudioUrl: '', lmStudioModel: '', authToken: '',
        rateLimitRpm: 10, monitoringEnabled: true, visionEnabled: false,
        maxContextMessages: 20, hasPinSetup: false,
        screenshotIntervalSec: 10, textRewriteEnabled: true,
        calendarDetectionEnabled: true, onboardingComplete: false,
      }
    }
  }
  return settings
}

async function initSW(): Promise<void> {
  try {
    settings = await getAllSettings()
  } catch {
    console.warn('[LocalAI] IDB init failed, using defaults')
    settings = {
      lmStudioUrl: '', lmStudioModel: '', authToken: '',
      rateLimitRpm: 10, monitoringEnabled: true, visionEnabled: false,
      maxContextMessages: 20, hasPinSetup: false,
      screenshotIntervalSec: 10, textRewriteEnabled: true,
      calendarDetectionEnabled: true, onboardingComplete: false,
    }
  }
  await rateLimiter.load(settings.rateLimitRpm)
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  await chrome.alarms.create('bg-summarize', {
    periodInMinutes: DEFAULTS.BG_SUMMARIZE_INTERVAL_MINUTES,
  })

  if (settings.onboardingComplete && settings.visionEnabled) {
    startScreenshotLoop(settings.screenshotIntervalSec)
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => { initSW().catch(console.error) })
chrome.runtime.onStartup.addListener(() => { initSW().catch(console.error) })

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bg-summarize') {
    await flushAllBuffers()
    await runBackgroundSummarization()
  }
})

async function runBackgroundSummarization(): Promise<void> {
  const s = await getSettings()
  if (!s.monitoringEnabled || !s.onboardingComplete) return

  const recentMemory = await getRecentSessionMemory(30)
  if (recentMemory.length === 0) return

  const memoryText = recentMemory.map(m =>
    `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.type}: ${m.content}`
  ).join('\n')

  const summary = await callAI([
    {
      role: 'system',
      content: 'You are a browser activity summarizer. Summarize the user\'s recent browser activity in 2-3 sentences. Note key tasks, domains, and patterns. Be concise.',
    },
    {
      role: 'user',
      content: `Recent browser activity:\n${memoryText}\n\nProvide a 2-3 sentence summary.`,
    },
  ], s, 256)

  if (summary.length > 20) {
    const domains = [...new Set(recentMemory.map(m => m.domain).filter(Boolean))]
    for (const domain of domains.slice(0, 3)) {
      await addSessionMemory({
        type: 'ai_summary',
        url: '',
        domain,
        content: summary,
        tags: ['ai-summary', ...domains.map(d => `domain:${d}`)],
        timestamp: Date.now(),
        sessionId,
      })
    }
  }
}

// ─── Tab events ───────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId)
  flushBuffer(tabId).then(() => clearTabBuffer(tabId)).catch(() => {})
})

chrome.tabs.onActivated.addListener(async (info) => {
  const s = await getSettings()
  if (s.visionEnabled && s.onboardingComplete) {
    await captureScreenshot(info.tabId).catch(() => {})
  }
})

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return
  await flushBuffer(details.tabId)
  tabState.delete(details.tabId)
  const s = await getSettings()
  if (!s.monitoringEnabled) return

  await addSessionMemory({
    type: 'page_visit',
    url: details.url,
    domain: extractDomain(details.url),
    content: `Navigated to: ${details.url}`,
    tags: ['navigation', `domain:${extractDomain(details.url)}`],
    timestamp: Date.now(),
    sessionId,
    tabId: details.tabId,
  })
})

// ─── Port-based streaming (sidepanel -> SW) ───────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_AI_STREAM) return

  port.onMessage.addListener(async (msg: Record<string, unknown>) => {
    const s = await getSettings()

    if (msg.type === MSG.AI_CHAT) {
      await handleAIChat(msg, s, port)
    }

    if (msg.type === MSG.AI_RECALL) {
      await handleAIRecall(msg, s, port)
    }

    if (msg.type === MSG.AI_REWRITE) {
      await handleAIRewrite(msg, s, port)
    }

    if (msg.type === MSG.AI_ABORT) {
      abortStream(msg.tabId as number ?? 0)
      abortStream(`recall_${msg.tabId ?? 0}`)
    }
  })
})

async function handleAIChat(
  msg: Record<string, unknown>,
  s: Settings,
  port: chrome.runtime.Port
): Promise<void> {
  const userText = msg.text as string ?? ''
  const chatSessionId = msg.sessionId as string ?? sessionId
  const tabId = msg.tabId as number ?? 0

  await appendChatMessage({
    sessionId: chatSessionId,
    role: 'user',
    content: userText,
    timestamp: Date.now(),
    tabId,
  })

  const pageContext = tabState.summarize(tabId)
  const history = await getSessionMessages(chatSessionId, s.maxContextMessages)
  const tabMem = await getTabMemory(tabId, 5)
  const recentMem = await getRecentSessionMemory(5)
  const memText = [...tabMem, ...recentMem]
    .map(m => m.content)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('\n')
    .slice(0, 1200)

  let screenshotData: string | undefined
  if (s.visionEnabled && tabId > 0) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 50 })
      tabState.setScreenshot(tabId, dataUrl)
      screenshotData = dataUrl
    } catch { /* not capturable */ }
  }

  const systemPrompt = buildSystemPrompt(pageContext, memText, s.apiCapabilities)
  const messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] = [
    { role: 'system', content: systemPrompt },
    ...history.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.content,
      imageData: undefined as string | undefined,
    })),
  ]

  if (screenshotData) {
    const lastIdx = messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1)
    if (lastIdx >= 0) messages[lastIdx].imageData = screenshotData
  }

  const fullText = await streamChat(messages, s, port, tabId)
  if (fullText) {
    await appendChatMessage({
      sessionId: chatSessionId,
      role: 'assistant',
      content: fullText,
      timestamp: Date.now(),
      tabId,
    })

    const actions = parseActionsFromText(fullText)
    if (actions.length > 0 && tabId > 0) {
      await executeWithFollowUp(
        fullText, tabId, s, port,
        messages.map(m => ({ role: m.role, content: m.content }))
      )
    }
  }
}

async function handleAIRecall(
  msg: Record<string, unknown>,
  s: Settings,
  port: chrome.runtime.Port
): Promise<void> {
  const query = msg.query as string ?? ''
  const chatSessionId = msg.sessionId as string ?? sessionId
  const tabId = msg.tabId as number ?? 0

  const sessionMem = await getRecentSessionMemory(50)
  const globalMem = await getAllGlobalMemory(20)
  const memContext = [
    ...sessionMem.map(m => `[${new Date(m.timestamp).toLocaleDateString()} ${m.type}] ${m.content}`),
    ...globalMem.map(m => `[Summary] ${m.summary}`),
  ].join('\n').slice(0, 3000)

  const messages: Pick<ChatMessage, 'role' | 'content'>[] = [
    {
      role: 'system',
      content: 'You are a memory recall assistant. Answer the user\'s question based strictly on the provided browser activity logs. If the information isn\'t in the logs, say so.',
    },
    {
      role: 'user',
      content: `Browser activity log:\n${memContext}\n\nQuestion: ${query}`,
    },
  ]

  await streamChat(messages, s, port, `recall_${tabId}`)
}

async function handleAIRewrite(
  msg: Record<string, unknown>,
  s: Settings,
  port: chrome.runtime.Port
): Promise<void> {
  const text = msg.text as string ?? ''
  const tone = msg.tone as string ?? 'professional'
  const tabId = msg.tabId as number ?? 0

  const messages: Pick<ChatMessage, 'role' | 'content'>[] = [
    {
      role: 'system',
      content: `You are a text improvement assistant. Rewrite the user's text to be more ${tone}. Fix grammar and spelling. Keep the original meaning. Return ONLY the improved text, nothing else.`,
    },
    { role: 'user', content: text },
  ]

  await streamChat(messages, s, port, `rewrite_${tabId}`)
}

// ─── Regular messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err: Error) => {
    sendResponse({ ok: false, error: err.message })
  })
  return true
})

async function handleMessage(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  const tabId = sender.tab?.id ?? 0
  const s = await getSettings()

  switch (msg.type) {
    case MSG.PAGE_SNAPSHOT: {
      const snap = msg.payload as PageSnapshot
      tabState.set(tabId, snap)
      if (s.monitoringEnabled && snap.forms.length > 0) {
        await addSessionMemory({
          type: 'form_detected',
          url: snap.url,
          domain: extractDomain(snap.url),
          content: `Form detected on ${snap.title}: ${snap.forms.map(f => describeForm(f)).join('; ')}`,
          tags: ['form', `domain:${extractDomain(snap.url)}`],
          timestamp: Date.now(),
          sessionId,
          tabId,
        })
      }
      return { ok: true }
    }

    case MSG.PAGE_TEXT: {
      const snap = tabState.get(tabId)
      if (snap) {
        snap.pageText = msg.pageText as string
        snap.visibleText = msg.visibleText as string
        tabState.set(tabId, snap)
      }
      return { ok: true }
    }

    case MSG.TEXT_SELECTED: {
      const snap = tabState.get(tabId)
      if (snap) {
        snap.selectedText = msg.text as string
        tabState.set(tabId, snap)
      }
      return { ok: true }
    }

    case MSG.USER_ACTION: {
      if (s.monitoringEnabled) {
        recordAction(tabId, msg.event as Parameters<typeof recordAction>[1], sessionId)
      }
      return { ok: true }
    }

    // ── Vault CRUD ────────────────────────────────────────────────────────────
    case MSG.VAULT_LIST: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      const entries = await vaultList()
      return { ok: true, entries: entries.map(e => ({ id: e.id, category: e.category, label: e.label, updatedAt: e.updatedAt })) }
    }

    case MSG.VAULT_GET: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      const entry = await vaultGet(msg.id as string)
      if (!entry) return { ok: false, error: 'NOT_FOUND' }
      const plaintext = await decryptData(entry.encryptedData)
      return { ok: true, data: JSON.parse(plaintext) }
    }

    case MSG.VAULT_SET: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      const { id, category, label, data } = msg as { id: string; category: VaultCategory; label: string; data: VaultData }
      const encryptedData = await encryptData(JSON.stringify(data))
      const existing = await vaultGet(id)
      await vaultSet({
        id, category, label, encryptedData,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      })
      return { ok: true }
    }

    case MSG.VAULT_DELETE: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      await vaultDelete(msg.id as string)
      return { ok: true }
    }

    // ── PIN / Session ─────────────────────────────────────────────────────────
    case MSG.SETUP_PIN: {
      await setupPin(msg.pin as string)
      settings = null
      return { ok: true }
    }

    case MSG.UNLOCK_SESSION: {
      const success = await unlockWithPin(msg.pin as string)
      return { ok: success, error: success ? undefined : 'Wrong PIN' }
    }

    case MSG.SESSION_STATUS: {
      const unlocked = await isSessionUnlocked()
      return { ok: true, unlocked, hasPinSetup: s.hasPinSetup }
    }

    case MSG.CHANGE_PIN: {
      const { oldPin, newPin } = msg as { oldPin: string; newPin: string }
      const success = await changePin(oldPin, newPin)
      return { ok: success, error: success ? undefined : 'Wrong PIN' }
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    case MSG.SETTINGS_GET: {
      return { ok: true, settings: s }
    }

    case MSG.SETTINGS_SET: {
      await setSettings(msg.partial as Partial<Settings>)
      settings = null
      return { ok: true }
    }

    case MSG.MODELS_LIST: {
      const url = (msg.url as string) || s.lmStudioUrl
      const token = (msg.authToken as string) || s.authToken
      const models = await fetchModels(url, token)
      return { ok: true, models }
    }

    // ── Endpoint probing ──────────────────────────────────────────────────────
    case MSG.PROBE_ENDPOINT: {
      const url = msg.url as string
      const authToken = msg.authToken as string | undefined
      try {
        const caps = await probeEndpoint(url, authToken)
        return { ok: true, capabilities: caps }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    // ── Chat history ──────────────────────────────────────────────────────────
    case MSG.CHAT_SESSION_LIST: {
      const sessions = await getAllSessions()
      return { ok: true, sessions }
    }

    case MSG.CHAT_LOAD_SESSION: {
      const msgs = await getSessionMessages(msg.sessionId as string, 200)
      return { ok: true, messages: msgs }
    }

    // ── Memory ────────────────────────────────────────────────────────────────
    case MSG.MEMORY_LIST: {
      const [session, global] = await Promise.all([getRecentSessionMemory(50), getAllGlobalMemory(20)])
      return { ok: true, session, global }
    }

    case MSG.MEMORY_CLEAR: {
      const target = msg.target as string
      if (target === 'session') await clearSessionMemory()
      else if (target === 'global') await clearGlobalMemory()
      else if (target === 'chat') await clearChatHistory()
      else {
        await clearSessionMemory()
        await clearGlobalMemory()
        await clearChatHistory()
      }
      return { ok: true }
    }

    case MSG.MEMORY_EXPORT: {
      const data = await exportMemory()
      return { ok: true, data }
    }

    // ── Stats ─────────────────────────────────────────────────────────────────
    case MSG.GET_STATS: {
      const stats = await getDomainStats()
      return { ok: true, stats }
    }

    case MSG.GET_HABITS: {
      await analyzeHabits(s)
      const patterns = await getHabitPatterns(20)
      return { ok: true, patterns }
    }

    case MSG.GET_CALENDAR_EVENTS: {
      const events = await getAllCalendarEvents()
      return { ok: true, events }
    }

    // ── Form fill ─────────────────────────────────────────────────────────────
    case MSG.FILL_FORM: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }

      const { vaultId, formSelector, includePasswords } = msg as { vaultId: string; formSelector: string; includePasswords?: boolean }
      const entry = await vaultGet(vaultId)
      if (!entry) return { ok: false, error: 'Vault entry not found' }

      const plaintext = await decryptData(entry.encryptedData)
      const vaultData = JSON.parse(plaintext) as VaultData

      const snap = tabState.get(tabId)
      if (!snap) return { ok: false, error: 'No page snapshot. Reload the page.' }

      const form = snap.forms.find(f => f.selector === formSelector) ?? snap.forms[0]
      if (!form) return { ok: false, error: 'No form found on this page' }

      const assignments = includePasswords
        ? matchCredentialsToForm(form, vaultData)
        : matchVaultToForm(form, vaultData)

      if (assignments.length === 0) return { ok: false, error: 'No matching fields found' }

      await chrome.tabs.sendMessage(tabId, { type: MSG.DO_FILL, assignments })
      return { ok: true, fieldCount: assignments.length }
    }

    case MSG.GET_TAB_SNAPSHOT: {
      const snap = tabState.get(tabId) ?? tabState.get(msg.tabId as number)
      return { ok: true, snapshot: snap ?? null }
    }

    case MSG.TAKE_SCREENSHOT: {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 })
        return { ok: true, dataUrl }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    // ── Action execution ──────────────────────────────────────────────────────
    case MSG.EXECUTE_ACTION: {
      const action = msg.action as Record<string, unknown>
      const targetTabId = msg.tabId as number ?? tabId
      try {
        const result = await chrome.tabs.sendMessage(targetTabId, { type: MSG.EXECUTE_ACTION, action })
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}
