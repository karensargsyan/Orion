/**
 * Telegram Bot Client — enables communication with Orion via a personal Telegram bot.
 *
 * Uses long-polling (getUpdates) triggered by chrome.alarms to check for new messages.
 * Processes messages through the same AI pipeline as the side panel chat.
 * Sends responses back to Telegram.
 *
 * Setup: User creates a bot via @BotFather, gets a token, enters it in Settings.
 */

import type { Settings, ChatMessage } from '../shared/types'
import { callAI } from './ai-client'
import { buildCompactSystemPrompt, buildSystemPrompt, estimateTokens } from './ai-client'
import { appendChatMessage, getSessionMessages, getAllSettings } from './memory-manager'
import { recallLocalMemories, localMemoryEnabled, searchLocalMemory } from './local-memory'

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── State ──────────────────────────────────────────────────────────────────

/** Last processed update ID. Persisted in chrome.storage.local. */
let lastUpdateOffset = 0
const STORAGE_KEY = 'telegram_last_update_id'

/** In-memory cache of per-chat session IDs for context continuity */
const chatSessions = new Map<number, string>()

// ─── API Helpers ────────────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org'

async function telegramAPI<T>(
  token: string,
  method: string,
  params?: Record<string, unknown>
): Promise<TelegramResponse<T>> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    })
    return await res.json() as TelegramResponse<T>
  } catch (err) {
    console.warn(`[Telegram] API error (${method}):`, err)
    return { ok: false, description: String(err) }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function telegramEnabled(settings: Settings): boolean {
  return settings.telegramBotEnabled === true && !!settings.telegramBotToken?.trim()
}

/** Validate bot token by calling getMe */
export async function testTelegramBot(token: string): Promise<{
  ok: boolean; botName?: string; error?: string
}> {
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
    } catch { /* ignore */ }
  }

  const token = settings.telegramBotToken!
  const res = await telegramAPI<TelegramUpdate[]>(token, 'getUpdates', {
    offset: lastUpdateOffset + 1,
    limit: 10,
    timeout: 0, // Non-blocking poll
    allowed_updates: ['message'],
  })

  if (!res.ok || !res.result || res.result.length === 0) return

  // Allowed chat IDs filter (empty = allow all)
  const allowed = settings.telegramAllowedChatIds ?? []

  for (const update of res.result) {
    lastUpdateOffset = Math.max(lastUpdateOffset, update.update_id)

    if (!update.message?.text) continue

    const chatId = update.message.chat.id
    // Security: check allowed chat IDs
    if (allowed.length > 0 && !allowed.includes(String(chatId))) {
      console.log(`[Telegram] Ignoring message from non-allowed chat ${chatId}`)
      continue
    }

    try {
      await handleIncomingMessage(token, update.message, settings)
    } catch (err) {
      console.warn(`[Telegram] Error handling message:`, err)
      await sendMessage(token, chatId, 'Sorry, something went wrong processing your message.')
    }
  }

  // Persist offset
  await chrome.storage.local.set({ [STORAGE_KEY]: lastUpdateOffset }).catch(() => {})
}

// ─── Message Handling ───────────────────────────────────────────────────────

async function handleIncomingMessage(
  token: string,
  msg: TelegramMessage,
  settings: Settings
): Promise<void> {
  const chatId = msg.chat.id
  const userText = msg.text ?? ''

  if (!userText.trim()) return

  // Handle /start command
  if (userText === '/start') {
    await sendMessage(token, chatId,
      'Hello! I am Orion, your AI browser assistant.\n\n' +
      'Send me any message and I will respond using the same AI model configured in your browser extension.\n\n' +
      'Commands:\n/status - Check connection status\n/memory <query> - Search local memory\n/clear - Clear chat context'
    )
    return
  }

  // Handle /status command
  if (userText === '/status') {
    const provider = settings.activeProvider
    const model = settings.lmStudioModel || settings.geminiModel || settings.openaiModel || settings.anthropicModel || 'default'
    await sendMessage(token, chatId,
      `Connected to Orion extension.\nProvider: ${provider}\nModel: ${model}`
    )
    return
  }

  // Handle /clear command
  if (userText === '/clear') {
    chatSessions.delete(chatId)
    await sendMessage(token, chatId, 'Chat context cleared.')
    return
  }

  // Handle /memory command
  if (userText.startsWith('/memory ')) {
    const query = userText.slice(8).trim()
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
    return
  }

  // Indicate typing
  await telegramAPI(token, 'sendChatAction', { chat_id: chatId, action: 'typing' })

  // Get or create session for this chat
  const sessionId = getOrCreateSession(chatId)

  // Store user message in chat history
  await appendChatMessage({
    sessionId,
    role: 'user',
    content: userText,
    timestamp: Date.now(),
  })

  // Get recent conversation history for context
  const history = await getSessionMessages(sessionId, settings.maxContextMessages ?? 20)

  // Build system prompt (no page context — Telegram has no browser tab)
  let memoryBlock = ''
  if (localMemoryEnabled(settings) && userText.length > 5) {
    const recalled = await recallLocalMemories(userText, '*').catch(() => '')
    if (recalled) memoryBlock = recalled
  }

  const systemPrompt = settings.liteMode
    ? buildCompactSystemPrompt(
        'The user is messaging via Telegram bot. There is no active browser tab. Respond as a helpful general assistant.',
        undefined, undefined, undefined, undefined
      )
    : buildSystemPrompt(
        'The user is messaging via Telegram bot. There is no active browser tab. You cannot perform browser actions — respond with text only.',
        memoryBlock || undefined,
        undefined, // no API capabilities context
        undefined, // no known user data
        undefined, undefined, undefined, undefined,
        memoryBlock || undefined,
        undefined, undefined, undefined, undefined
      )

  // Build messages
  const messages: Pick<ChatMessage, 'role' | 'content'>[] = [
    { role: 'system', content: systemPrompt },
    ...history.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.content,
    })),
  ]

  // Truncate to fit context window
  const maxTokens = settings.contextWindowTokens || 8192
  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0)
  while (totalTokens > maxTokens * 0.7 && messages.length > 2) {
    messages.splice(1, 1)
    totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0)
  }

  // Call AI (non-streaming for simplicity — Telegram doesn't need streaming)
  const response = await callAI(messages as ChatMessage[], settings, 2048)

  if (!response?.trim()) {
    await sendMessage(token, chatId, 'I could not generate a response. The AI model may be unavailable.')
    return
  }

  // Store assistant response
  await appendChatMessage({
    sessionId,
    role: 'assistant',
    content: response,
    timestamp: Date.now(),
  })

  // Send to Telegram (split long messages)
  await sendLongMessage(token, chatId, response)
}

// ─── Telegram Send Helpers ──────────────────────────────────────────────────

async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
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
async function sendLongMessage(token: string, chatId: number | string, text: string): Promise<void> {
  const MAX_LEN = 4000
  if (text.length <= MAX_LEN) {
    await sendMessage(token, chatId, text)
    return
  }

  // Split at paragraph boundaries
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining)
      break
    }
    // Find last paragraph break before limit
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

// ─── Session Management ─────────────────────────────────────────────────────

function getOrCreateSession(chatId: number): string {
  let sessionId = chatSessions.get(chatId)
  if (!sessionId) {
    sessionId = `telegram_${chatId}_${Date.now()}`
    chatSessions.set(chatId, sessionId)
  }
  return sessionId
}

/** Reset offset (e.g., when token changes) */
export function resetTelegramOffset(): void {
  lastUpdateOffset = 0
  chrome.storage.local.remove(STORAGE_KEY).catch(() => {})
}
