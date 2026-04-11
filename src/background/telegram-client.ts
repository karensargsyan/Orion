/**
 * Telegram Bot Client — full browser automation via tab-backed sessions.
 *
 * Each Telegram chat can manage multiple browser tabs, each backed by a
 * real Chrome tab and tab group. Messages are routed through the same
 * handleAIChat() pipeline as the side panel, giving Telegram users full
 * page context, navigation, form-filling, and multi-step automation.
 *
 * Commands:
 *   /start         — Welcome + command list
 *   /newgrouptab   — Create new Chrome tab + group, set as active
 *   /tabs          — List all tab groups (auto-named)
 *   /tab N         — Switch active tab group, show recent history
 *   /close N       — Close a tab group
 *   /status        — Provider, model, tab count
 *   /memory <q>    — Search local memory
 *   /clear         — Clear current session context
 *   Any other text — Route through handleAIChat() on active tab
 *
 * Setup: User creates a bot via @BotFather, enters token in Settings.
 */

import type { Settings } from '../shared/types'
import { MSG } from '../shared/constants'
import type { StreamPort } from './ai-client'
import { getSessionMessages, getAllSettings } from './memory-manager'
import { localMemoryEnabled, searchLocalMemory } from './local-memory'
import { createGroupForTab, updateGroupTitle, registerExtensionTab, unregisterExtensionTab } from './web-researcher'
import { handleConfirmResponse } from './confirmation-manager'
import { captureHighQualityScreenshot } from './minimap-screenshot'

// ─── Telegram API Types ────────────────────────────────────────────────────

interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
}

interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
}

interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  reply_to_message?: TelegramMessage
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

// ─── Tab-Backed Session Types ──────────────────────────────────────────────

interface TelegramTab {
  tabId: number            // Real Chrome tab ID
  groupId: number          // Chrome tab group ID
  chatId: number           // Telegram chat ID that owns this tab
  name: string             // Display name (auto-named from domain)
  sessionId: string        // Chat session ID (shared with side panel)
  createdAt: number
  autoNameApplied: boolean // Whether name was auto-updated from domain
}

// ─── State ─────────────────────────────────────────────────────────────────

/** Last processed update ID. Persisted in chrome.storage.local. */
let lastUpdateOffset = 0
const STORAGE_KEY = 'telegram_last_update_id'

/** Per-chatId list of managed tabs */
const chatTabs = new Map<number, TelegramTab[]>()

/** Per-chatId active tab index (0-based into chatTabs array) */
const activeTabIndex = new Map<number, number>()

/** Per-chatId sequential tab counter for naming */
const tabCounters = new Map<number, number>()

/** Reverse lookup: Chrome tabId → TelegramTab (for cleanup on external close) */
const tabIdToTelegramTab = new Map<number, TelegramTab>()

// ─── Dependency Injection ──────────────────────────────────────────────────

type ChatHandler = (
  msg: Record<string, unknown>,
  settings: Settings,
  port: StreamPort,
) => Promise<void>

let chatHandler: ChatHandler | null = null

/**
 * Register the handleAIChat function from service-worker.ts.
 * Called once during initSW() to avoid circular imports.
 */
export function registerChatHandler(handler: ChatHandler): void {
  chatHandler = handler
}

// ─── TelegramStreamPort ────────────────────────────────────────────────────

/**
 * Virtual StreamPort adapter that collects AI stream chunks and sends
 * the assembled response to Telegram when streaming completes.
 * Auto-accepts confirmation prompts so automation doesn't stall.
 */
class TelegramStreamPort implements StreamPort {
  private chunks: string[] = []
  private readonly token: string
  private readonly chatId: number
  private flushPromise: Promise<void> | null = null

  constructor(token: string, chatId: number) {
    this.token = token
    this.chatId = chatId
  }

  postMessage(msg: object): void {
    const m = msg as Record<string, unknown>

    if (m.type === 'STREAM_CHUNK' || m.type === MSG.STREAM_CHUNK) {
      this.chunks.push(m.chunk as string)
    } else if (m.type === 'STREAM_END' || m.type === MSG.STREAM_END) {
      // Stream finished — flush collected text to Telegram
      this.flushPromise = this.flush()
    } else if (m.type === 'STREAM_ERROR' || m.type === MSG.STREAM_ERROR) {
      const errText = `Error: ${m.error ?? 'Unknown error'}`
      sendMessage(this.token, this.chatId, errText).catch(() => {})
    } else if (m.type === 'CONFIRM_ACTION' || m.type === MSG.CONFIRM_ACTION) {
      // Auto-accept confirmations — Telegram user implicitly trusts the bot
      // to execute actions they requested. This mirrors globalAutoAccept.
      const confirmId = m.id as string
      const actions = (m.actions as string[]) ?? []
      handleConfirmResponse(confirmId, 'once', actions, '').catch(() => {})
    }
  }

  /** Send collected chunks as a single Telegram message */
  async flush(): Promise<void> {
    const text = this.chunks.join('')
    this.chunks = []
    if (text.trim()) {
      await sendLongMessage(this.token, this.chatId, text)
    }
  }

  /** Wait for any pending flush to complete */
  async waitForFlush(): Promise<void> {
    if (this.flushPromise) await this.flushPromise
  }
}

// ─── Telegram API Helpers ──────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org'

async function telegramAPI<T>(
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<TelegramResponse<T>> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    })
    return (await res.json()) as TelegramResponse<T>
  } catch (err) {
    console.warn(`[Telegram] API error (${method}):`, err)
    return { ok: false, description: String(err) }
  }
}

/**
 * Send a photo to Telegram from a base64 data URL.
 * Converts to a Blob and uses multipart/form-data upload.
 */
async function sendPhoto(
  token: string,
  chatId: number | string,
  dataUrl: string,
  caption?: string,
): Promise<boolean> {
  try {
    // Convert data URL to Blob
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return false

    const byteString = atob(match[2])
    const ab = new ArrayBuffer(byteString.length)
    const ia = new Uint8Array(ab)
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i)
    }
    const blob = new Blob([ab], { type: match[1] })

    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('photo', blob, 'screenshot.jpg')
    if (caption) form.append('caption', caption)

    const url = `${TELEGRAM_API}/bot${token}/sendPhoto`
    const res = await fetch(url, { method: 'POST', body: form })
    const json = await res.json() as TelegramResponse<unknown>
    return json.ok === true
  } catch (err) {
    console.warn('[Telegram] sendPhoto failed:', err)
    return false
  }
}

async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
): Promise<void> {
  await telegramAPI(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  }).catch(async () => {
    // Retry without Markdown if parsing fails
    await telegramAPI(token, 'sendMessage', { chat_id: chatId, text })
  })
}

/** Split long messages (Telegram limit: 4096 chars) */
async function sendLongMessage(
  token: string,
  chatId: number | string,
  text: string,
): Promise<void> {
  const MAX_LEN = 4000
  if (text.length <= MAX_LEN) {
    await sendMessage(token, chatId, text)
    return
  }

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN)
    if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN)
    if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  for (const chunk of chunks) {
    await sendMessage(token, chatId, chunk)
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export function telegramEnabled(settings: Settings): boolean {
  return settings.telegramBotEnabled === true && !!settings.telegramBotToken?.trim()
}

/** Validate bot token by calling getMe */
export async function testTelegramBot(
  token: string,
): Promise<{ ok: boolean; botName?: string; error?: string }> {
  const res = await telegramAPI<TelegramUser>(token, 'getMe')
  if (res.ok && res.result) {
    return { ok: true, botName: `@${res.result.username ?? res.result.first_name}` }
  }
  return { ok: false, error: res.description ?? 'Invalid token' }
}

/** Main polling function — called by chrome.alarms handler */
export async function pollTelegramUpdates(settings: Settings): Promise<void> {
  if (!telegramEnabled(settings)) return

  // Load last offset from storage
  if (lastUpdateOffset === 0) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY)
      lastUpdateOffset = stored[STORAGE_KEY] ?? 0
    } catch {
      /* ignore */
    }
  }

  const token = settings.telegramBotToken!
  const res = await telegramAPI<TelegramUpdate[]>(token, 'getUpdates', {
    offset: lastUpdateOffset + 1,
    limit: 10,
    timeout: 0,
    allowed_updates: ['message'],
  })

  if (!res.ok || !res.result || res.result.length === 0) return

  const allowed = settings.telegramAllowedChatIds ?? []

  for (const update of res.result) {
    lastUpdateOffset = Math.max(lastUpdateOffset, update.update_id)

    if (!update.message?.text) continue

    const chatId = update.message.chat.id
    if (allowed.length > 0 && !allowed.includes(String(chatId))) {
      console.warn(`[Telegram] Ignoring message from non-allowed chat ${chatId}`)
      continue
    }

    try {
      await handleIncomingMessage(token, update.message, settings)
    } catch (err) {
      console.warn(`[Telegram] Error handling message:`, err)
      await sendMessage(token, chatId, 'Sorry, something went wrong processing your message.')
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: lastUpdateOffset }).catch(() => {})
}

/** Reset offset (e.g., when token changes) */
export function resetTelegramOffset(): void {
  lastUpdateOffset = 0
  chrome.storage.local.remove(STORAGE_KEY).catch(() => {})
}

// ─── Tab Management ────────────────────────────────────────────────────────

/** Create a new Chrome tab + group for a Telegram chat */
async function createTelegramTab(
  token: string,
  chatId: number,
): Promise<TelegramTab | null> {
  try {
    // Create a new Chrome tab
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
    if (!tab.id) return null

    // Register with global tab registry so it counts toward GLOBAL_TAB_LIMIT
    registerExtensionTab(tab.id)

    // Get sequential name
    const counter = (tabCounters.get(chatId) ?? 0) + 1
    tabCounters.set(chatId, counter)
    const name = `TG: ${counter}`

    // Create tab group with the name
    const groupId = await createGroupForTab(tab.id, name)

    const sessionId = `session_telegram_${chatId}_${Date.now()}`

    const telegramTab: TelegramTab = {
      tabId: tab.id,
      groupId,
      chatId,
      name,
      sessionId,
      createdAt: Date.now(),
      autoNameApplied: false,
    }

    // Store in state maps
    const tabs = chatTabs.get(chatId) ?? []
    tabs.push(telegramTab)
    chatTabs.set(chatId, tabs)
    activeTabIndex.set(chatId, tabs.length - 1)
    tabIdToTelegramTab.set(tab.id, telegramTab)

    return telegramTab
  } catch (err) {
    console.warn('[Telegram] Failed to create tab:', err)
    return null
  }
}

/** Get the active TelegramTab for a chat, or null */
function getActiveTab(chatId: number): TelegramTab | null {
  const tabs = chatTabs.get(chatId)
  if (!tabs || tabs.length === 0) return null
  const idx = activeTabIndex.get(chatId) ?? 0
  return tabs[idx] ?? null
}

/** Check if a Chrome tab is still alive */
async function isTabAlive(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId)
    return true
  } catch {
    return false
  }
}

/** Remove a dead tab from tracking */
function removeTelegramTab(chatId: number, tabId: number): void {
  const tabs = chatTabs.get(chatId)
  if (!tabs) return

  const idx = tabs.findIndex((t) => t.tabId === tabId)
  if (idx < 0) return

  tabs.splice(idx, 1)
  tabIdToTelegramTab.delete(tabId)

  // Adjust active index
  const currentActive = activeTabIndex.get(chatId) ?? 0
  if (tabs.length === 0) {
    activeTabIndex.delete(chatId)
  } else if (currentActive >= tabs.length) {
    activeTabIndex.set(chatId, tabs.length - 1)
  } else if (idx < currentActive) {
    activeTabIndex.set(chatId, currentActive - 1)
  }
}

/** Clean up when a Chrome tab is closed externally */
export function cleanupTelegramTab(tabId: number): void {
  const tgTab = tabIdToTelegramTab.get(tabId)
  if (!tgTab) return

  const chatId = tgTab.chatId
  removeTelegramTab(chatId, tabId)
  tabIdToTelegramTab.delete(tabId)

  console.warn(`[Telegram] Tab ${tabId} closed externally, removed from chat ${chatId}`)
}

/** Check if a tab is owned by Telegram */
export function isTelegramTab(tabId: number): boolean {
  return tabIdToTelegramTab.has(tabId)
}

/** Auto-rename a tab when the user navigates to a real domain */
export async function notifyTabUrlChange(tabId: number, url: string): Promise<void> {
  const tgTab = tabIdToTelegramTab.get(tabId)
  if (!tgTab || tgTab.autoNameApplied) return

  // Extract domain from URL
  try {
    const parsed = new URL(url)
    const domain = parsed.hostname
    if (!domain || domain === '' || url === 'about:blank' || url.startsWith('chrome://')) return

    const oldName = tgTab.name
    tgTab.name = domain
    tgTab.autoNameApplied = true

    // Update session to domain-based (so side panel can share it)
    tgTab.sessionId = `session_domain_${domain}`

    // Update Chrome tab group title
    await updateGroupTitle(tabId, domain)

    console.warn(`[Telegram] Tab renamed: "${oldName}" → "${domain}"`)

    // Notify the Telegram user about the rename
    const settings = await getAllSettings().catch(() => null)
    if (settings?.telegramBotToken) {
      await sendMessage(
        settings.telegramBotToken,
        tgTab.chatId,
        `Tab renamed: *${domain}*`,
      ).catch(() => {})
    }
  } catch {
    /* invalid URL — ignore */
  }
}

// ─── Command Handlers ──────────────────────────────────────────────────────

async function handleStart(token: string, chatId: number): Promise<void> {
  await sendMessage(
    token,
    chatId,
    `Hello! I am *Orion*, your AI browser assistant.\n\n` +
      `I can control your browser remotely — navigate pages, fill forms, search the web, and more.\n\n` +
      `*Commands:*\n` +
      `/newgrouptab — Create a new browser tab\n` +
      `/tabs — List all open tabs\n` +
      `/tab N — Switch to tab N\n` +
      `/close N — Close tab N\n` +
      `/screenshot — Screenshot active tab\n` +
      `/screenshot all — Screenshot all tabs\n` +
      `/status — Check connection status\n` +
      `/memory <query> — Search local memory\n` +
      `/clear — Clear chat context\n\n` +
      `Send any message to interact with the active browser tab.`,
  )
}

async function handleNewGroupTab(
  token: string,
  chatId: number,
): Promise<void> {
  const tab = await createTelegramTab(token, chatId)
  if (!tab) {
    await sendMessage(token, chatId, 'Failed to create a new tab. Is the browser running?')
    return
  }
  await sendMessage(
    token,
    chatId,
    `Created new tab *${tab.name}*.\nThis is now your active tab. Send any message to start.`,
  )
}

async function handleListTabs(
  token: string,
  chatId: number,
): Promise<void> {
  const tabs = chatTabs.get(chatId)
  if (!tabs || tabs.length === 0) {
    await sendMessage(
      token,
      chatId,
      'No open tabs. Use /newgrouptab to create one.',
    )
    return
  }

  const currentIdx = activeTabIndex.get(chatId) ?? 0

  // Check which tabs are still alive
  const lines: string[] = []
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]
    const alive = await isTabAlive(t.tabId)
    const marker = i === currentIdx ? ' ✓' : ''
    const status = alive ? '' : ' (closed)'
    lines.push(`${i + 1}. *${t.name}*${marker}${status}`)
  }

  await sendMessage(
    token,
    chatId,
    `*Open tabs:*\n${lines.join('\n')}\n\nUse /tab N to switch.`,
  )
}

async function handleSwitchTab(
  token: string,
  chatId: number,
  indexStr: string,
  settings: Settings,
): Promise<void> {
  const tabs = chatTabs.get(chatId)
  if (!tabs || tabs.length === 0) {
    await sendMessage(token, chatId, 'No open tabs. Use /newgrouptab to create one.')
    return
  }

  const idx = parseInt(indexStr, 10) - 1 // 1-based to 0-based
  if (isNaN(idx) || idx < 0 || idx >= tabs.length) {
    await sendMessage(token, chatId, `Invalid tab number. Use 1–${tabs.length}.`)
    return
  }

  const tab = tabs[idx]

  // Check if tab is still alive
  if (!(await isTabAlive(tab.tabId))) {
    removeTelegramTab(chatId, tab.tabId)
    await sendMessage(
      token,
      chatId,
      `Tab "${tab.name}" was closed. Removed from list.`,
    )
    return
  }

  activeTabIndex.set(chatId, idx)

  // Send recent chat history
  const history = await getSessionMessages(tab.sessionId, 5).catch(() => [])
  let historyText = ''
  if (history.length > 0) {
    const lines = history.map((m) => {
      const role = m.role === 'user' ? 'You' : 'Orion'
      const text = m.content.slice(0, 150) + (m.content.length > 150 ? '...' : '')
      return `*${role}:* ${text}`
    })
    historyText = `\n\n*Recent history:*\n${lines.join('\n')}`
  }

  await sendMessage(
    token,
    chatId,
    `Switched to tab *${tab.name}* (#${idx + 1}).${historyText}`,
  )
}

async function handleCloseTab(
  token: string,
  chatId: number,
  indexStr: string,
): Promise<void> {
  const tabs = chatTabs.get(chatId)
  if (!tabs || tabs.length === 0) {
    await sendMessage(token, chatId, 'No open tabs.')
    return
  }

  const idx = parseInt(indexStr, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= tabs.length) {
    await sendMessage(token, chatId, `Invalid tab number. Use 1–${tabs.length}.`)
    return
  }

  const tab = tabs[idx]
  const tabName = tab.name

  // Close the Chrome tab and unregister from global registry
  unregisterExtensionTab(tab.tabId)
  try {
    await chrome.tabs.remove(tab.tabId)
  } catch {
    /* already gone */
  }

  removeTelegramTab(chatId, tab.tabId)

  await sendMessage(token, chatId, `Closed tab *${tabName}*.`)
}

async function handleStatus(
  token: string,
  chatId: number,
  settings: Settings,
): Promise<void> {
  const provider = settings.activeProvider
  const model =
    settings.lmStudioModel ||
    settings.geminiModel ||
    settings.openaiModel ||
    settings.anthropicModel ||
    'default'
  const tabs = chatTabs.get(chatId)
  const tabCount = tabs?.length ?? 0
  const activeIdx = activeTabIndex.get(chatId)
  const activeTab = tabs && activeIdx !== undefined ? tabs[activeIdx] : null

  await sendMessage(
    token,
    chatId,
    `*Orion Status*\n` +
      `Provider: ${provider}\n` +
      `Model: ${model}\n` +
      `Open tabs: ${tabCount}\n` +
      `Active tab: ${activeTab ? activeTab.name : 'none'}`,
  )
}

async function handleMemory(
  token: string,
  chatId: number,
  query: string,
  settings: Settings,
): Promise<void> {
  if (!query) {
    await sendMessage(token, chatId, 'Usage: /memory <search query>')
    return
  }
  if (localMemoryEnabled(settings)) {
    const results = await searchLocalMemory(query, { limit: 5 }).catch(() => '')
    await sendMessage(token, chatId, results || 'No results found.')
  } else {
    await sendMessage(token, chatId, 'Local memory is disabled.')
  }
}

async function handleClear(
  token: string,
  chatId: number,
): Promise<void> {
  const tab = getActiveTab(chatId)
  if (tab) {
    // Reset session ID to force a fresh context
    tab.sessionId = `session_telegram_${chatId}_${Date.now()}`
    tab.autoNameApplied = false
  }
  await sendMessage(token, chatId, 'Chat context cleared.')
}

/**
 * /screenshot [N] — Capture and send a screenshot of the active tab (or tab N).
 * If no tab is specified, screenshots the current active tab.
 * Supports: /screenshot, /screenshot 1, /screenshot all
 */
async function handleScreenshot(
  token: string,
  chatId: number,
  arg: string,
): Promise<void> {
  const tabs = chatTabs.get(chatId)
  if (!tabs || tabs.length === 0) {
    await sendMessage(token, chatId, 'No open tabs. Use /newgrouptab to create one.')
    return
  }

  // Determine which tabs to screenshot
  const targetsToCapture: TelegramTab[] = []

  if (arg === 'all') {
    // Screenshot all tabs
    for (const tab of tabs) {
      if (await isTabAlive(tab.tabId)) targetsToCapture.push(tab)
    }
  } else if (arg && /^\d+$/.test(arg)) {
    // Screenshot specific tab by number
    const idx = parseInt(arg, 10) - 1
    if (idx >= 0 && idx < tabs.length) {
      targetsToCapture.push(tabs[idx])
    } else {
      await sendMessage(token, chatId, `Tab ${arg} not found. Use /tabs to see available tabs.`)
      return
    }
  } else {
    // Screenshot active tab
    const active = getActiveTab(chatId)
    if (active) targetsToCapture.push(active)
  }

  if (targetsToCapture.length === 0) {
    await sendMessage(token, chatId, 'No live tabs to screenshot.')
    return
  }

  await telegramAPI(token, 'sendChatAction', { chat_id: chatId, action: 'upload_photo' })

  let sent = 0
  let failed = 0

  for (const tab of targetsToCapture) {
    try {
      // Focus the tab briefly so captureVisibleTab works
      await chrome.tabs.update(tab.tabId, { active: true })
      await new Promise(r => setTimeout(r, 500)) // Brief wait for render

      const dataUrl = await captureHighQualityScreenshot(tab.tabId)

      if (dataUrl) {
        // Get tab info for caption
        let tabTitle = tab.name
        try {
          const chromeTab = await chrome.tabs.get(tab.tabId)
          tabTitle = chromeTab.title ?? tab.name
        } catch { /* use stored name */ }

        const caption = `${tabTitle}`
        const ok = await sendPhoto(token, chatId, dataUrl, caption)
        if (ok) sent++
        else failed++
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }

  if (sent === 0) {
    await sendMessage(token, chatId, 'Could not capture screenshot. The tab may be on a restricted page (chrome://, devtools, etc.).')
  } else if (failed > 0) {
    await sendMessage(token, chatId, `Sent ${sent} screenshot${sent > 1 ? 's' : ''}. ${failed} failed (restricted pages).`)
  }
}

// ─── Message Routing ───────────────────────────────────────────────────────

async function handleIncomingMessage(
  token: string,
  msg: TelegramMessage,
  settings: Settings,
): Promise<void> {
  const chatId = msg.chat.id
  const userText = msg.text ?? ''

  if (!userText.trim()) return

  // ── Command routing ──
  const cmd = userText.toLowerCase().trim()

  if (cmd === '/start') {
    await handleStart(token, chatId)
    return
  }

  if (cmd === '/newgrouptab') {
    await handleNewGroupTab(token, chatId)
    return
  }

  if (cmd === '/tabs') {
    await handleListTabs(token, chatId)
    return
  }

  if (cmd.startsWith('/tab ')) {
    await handleSwitchTab(token, chatId, cmd.slice(5).trim(), settings)
    return
  }

  if (cmd.startsWith('/close ')) {
    await handleCloseTab(token, chatId, cmd.slice(7).trim())
    return
  }

  if (cmd === '/status') {
    await handleStatus(token, chatId, settings)
    return
  }

  if (cmd.startsWith('/memory ')) {
    await handleMemory(token, chatId, userText.slice(8).trim(), settings)
    return
  }

  if (cmd === '/clear') {
    await handleClear(token, chatId)
    return
  }

  if (cmd === '/screenshot' || cmd.startsWith('/screenshot ')) {
    await handleScreenshot(token, chatId, cmd.slice(12).trim())
    return
  }

  // ── Natural language screenshot detection ──
  const screenshotRequest = /\b(screenshot|screen\s*shot|capture\s*(the\s+)?screen|show\s+(me\s+)?(the\s+)?screen|bildschirmfoto|bildschirm\s+zeigen|zeig\s+(mir\s+)?(den\s+)?bildschirm)\b/i
  if (screenshotRequest.test(cmd)) {
    const allMatch = /\b(all|alle|every|jede)\b/i.test(cmd)
    await handleScreenshot(token, chatId, allMatch ? 'all' : '')
    return
  }

  // ── Regular message → route through handleAIChat ──

  if (!chatHandler) {
    await sendMessage(
      token,
      chatId,
      'Orion is still initializing. Please try again in a moment.',
    )
    return
  }

  // Get or auto-create active tab
  let activeTab = getActiveTab(chatId)

  // Clean up dead tabs
  if (activeTab && !(await isTabAlive(activeTab.tabId))) {
    removeTelegramTab(chatId, activeTab.tabId)
    activeTab = getActiveTab(chatId)
  }

  // Auto-create tab if none exists
  if (!activeTab) {
    activeTab = await createTelegramTab(token, chatId)
    if (!activeTab) {
      await sendMessage(
        token,
        chatId,
        'Could not create a browser tab. Is Chrome running?',
      )
      return
    }
    await sendMessage(
      token,
      chatId,
      `Auto-created tab *${activeTab.name}*. Processing your message...`,
    )
  }

  // Show typing indicator
  await telegramAPI(token, 'sendChatAction', {
    chat_id: chatId,
    action: 'typing',
  })

  // Create virtual port and route through the full AI pipeline
  const streamPort = new TelegramStreamPort(token, chatId)

  try {
    await chatHandler(
      {
        type: MSG.AI_CHAT,
        text: userText,
        sessionId: activeTab.sessionId,
        tabId: activeTab.tabId,
      },
      settings,
      streamPort,
    )

    // Wait for any pending flush (stream response to Telegram)
    await streamPort.waitForFlush()
  } catch (err) {
    console.warn('[Telegram] handleAIChat error:', err)
    // Try to send any collected chunks
    await streamPort.flush()
    // If nothing was sent, send a fallback error message
    await sendMessage(
      token,
      chatId,
      'Something went wrong processing your request.',
    )
  }
}
