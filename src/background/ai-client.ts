import { TOKEN_BUCKET_STORAGE } from '../shared/constants'
import type { ChatMessage, Settings, APICapabilities } from '../shared/types'
import { MSG } from '../shared/constants'

// ─── Token Bucket ─────────────────────────────────────────────────────────────

interface BucketState {
  tokens: number
  lastRefillMs: number
  capacity: number
}

class TokenBucket {
  private state: BucketState = { tokens: 10, lastRefillMs: Date.now(), capacity: 10 }

  async load(capacity: number): Promise<void> {
    this.state.capacity = capacity
    const stored = await chrome.storage.session.get(TOKEN_BUCKET_STORAGE)
    if (stored[TOKEN_BUCKET_STORAGE]) {
      this.state = { ...this.state, ...(stored[TOKEN_BUCKET_STORAGE] as BucketState) }
      this.state.capacity = capacity
    } else {
      this.state = { tokens: capacity, lastRefillMs: Date.now(), capacity }
    }
    this.refill()
  }

  private refill(): void {
    const now = Date.now()
    const elapsedMs = now - this.state.lastRefillMs
    const refillRate = this.state.capacity / 60_000
    const refilled = elapsedMs * refillRate
    this.state.tokens = Math.min(this.state.capacity, this.state.tokens + refilled)
    this.state.lastRefillMs = now
  }

  private async persist(): Promise<void> {
    await chrome.storage.session.set({ [TOKEN_BUCKET_STORAGE]: this.state })
  }

  consume(): boolean {
    this.refill()
    if (this.state.tokens >= 1) {
      this.state.tokens -= 1
      this.persist().catch(() => {})
      return true
    }
    return false
  }

  async consumeWithWait(maxWaitMs = 5000): Promise<boolean> {
    const startMs = Date.now()
    while (Date.now() - startMs < maxWaitMs) {
      if (this.consume()) return true
      await sleep(200)
    }
    return false
  }
}

export const rateLimiter = new TokenBucket()

// ─── Abort controller registry ────────────────────────────────────────────────

const abortControllers = new Map<number | string, AbortController>()

export function abortStream(key: number | string): void {
  abortControllers.get(key)?.abort()
  abortControllers.delete(key)
}

// ─── Port interface ───────────────────────────────────────────────────────────

export interface StreamPort {
  postMessage(msg: object): void
}

// ─── Format detection ─────────────────────────────────────────────────────────

function getApiFormat(settings: Settings): 'openai' | 'anthropic' {
  const caps = settings.apiCapabilities
  if (!caps) return 'openai'
  if (caps.apiFormat === 'anthropic') return 'anthropic'
  return 'openai'
}

function getBaseUrl(settings: Settings): string {
  const url = settings.apiCapabilities?.baseUrl || settings.lmStudioUrl
  return url.replace(/\/+$/, '')
}

function getAuthHeaders(settings: Settings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = settings.authToken || 'lm-studio'
  const format = getApiFormat(settings)

  if (format === 'anthropic') {
    headers['x-api-key'] = token
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

// ─── Vision support ───────────────────────────────────────────────────────────

function supportsVision(settings: Settings): boolean {
  return settings.visionEnabled && (settings.apiCapabilities?.supportsVision ?? false)
}

interface OpenAIMessageContent {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string }
}

function buildOpenAIMessages(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  visionEnabled: boolean
): Array<{ role: string; content: string | OpenAIMessageContent[] }> {
  return messages.map(m => {
    if (visionEnabled && m.imageData && m.role === 'user') {
      const parts: OpenAIMessageContent[] = [
        { type: 'text', text: m.content },
        { type: 'image_url', image_url: { url: m.imageData, detail: 'low' } },
      ]
      return { role: m.role, content: parts }
    }
    return { role: m.role, content: m.content }
  })
}

interface AnthropicContentBlock {
  type: 'text' | 'image'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

function buildAnthropicMessages(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[]
): { system: string; messages: Array<{ role: string; content: AnthropicContentBlock[] | string }> } {
  let system = ''
  const anthropicMessages: Array<{ role: string; content: AnthropicContentBlock[] | string }> = []

  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + m.content
      continue
    }
    if (m.imageData && m.role === 'user') {
      const match = m.imageData.match(/^data:([^;]+);base64,(.+)$/)
      const blocks: AnthropicContentBlock[] = [{ type: 'text', text: m.content }]
      if (match) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        })
      }
      anthropicMessages.push({ role: m.role, content: blocks })
    } else {
      anthropicMessages.push({ role: m.role, content: m.content })
    }
  }

  return { system, messages: anthropicMessages }
}

// ─── OpenAI streaming ─────────────────────────────────────────────────────────

async function streamOpenAI(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  settings: Settings,
  port: StreamPort,
  controller: AbortController
): Promise<string> {
  const baseUrl = getBaseUrl(settings)
  const hasVision = supportsVision(settings)
  const body = {
    model: settings.lmStudioModel || undefined,
    messages: buildOpenAIMessages(messages, hasVision),
    stream: true,
    temperature: 0.7,
    max_tokens: 4096,
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: getAuthHeaders(settings),
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  if (!response.ok) {
    const text = await response.text()
    port.postMessage({ type: MSG.STREAM_ERROR, error: `API error ${response.status}: ${text.slice(0, 200)}` })
    return ''
  }

  return parseSSEStream(response, port, (parsed) => {
    const choices = parsed?.choices as Array<{ delta?: { content?: string } }> | undefined
    return choices?.[0]?.delta?.content ?? ''
  })
}

// ─── Anthropic streaming ──────────────────────────────────────────────────────

async function streamAnthropic(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  settings: Settings,
  port: StreamPort,
  controller: AbortController
): Promise<string> {
  const baseUrl = getBaseUrl(settings)
  const { system, messages: anthropicMsgs } = buildAnthropicMessages(messages)

  const body: Record<string, unknown> = {
    model: settings.lmStudioModel || undefined,
    messages: anthropicMsgs,
    stream: true,
    max_tokens: 4096,
  }
  if (system) body.system = system

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: getAuthHeaders(settings),
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  if (!response.ok) {
    const text = await response.text()
    port.postMessage({ type: MSG.STREAM_ERROR, error: `Anthropic error ${response.status}: ${text.slice(0, 200)}` })
    return ''
  }

  return parseAnthropicSSE(response, port)
}

// ─── SSE parsers ──────────────────────────────────────────────────────────────

async function parseSSEStream(
  response: Response,
  port: StreamPort,
  extractChunk: (parsed: Record<string, unknown>) => string
): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') break
      try {
        const parsed = JSON.parse(data)
        const chunk = extractChunk(parsed)
        if (chunk) {
          fullText += chunk
          port.postMessage({ type: MSG.STREAM_CHUNK, chunk })
        }
      } catch { /* skip malformed SSE */ }
    }
  }

  port.postMessage({ type: MSG.STREAM_END, fullText })
  return fullText
}

async function parseAnthropicSSE(response: Response, port: StreamPort): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      try {
        const event = JSON.parse(data)
        if (event.type === 'content_block_delta' && event.delta?.text) {
          fullText += event.delta.text
          port.postMessage({ type: MSG.STREAM_CHUNK, chunk: event.delta.text })
        }
        if (event.type === 'message_stop') break
      } catch { /* skip */ }
    }
  }

  port.postMessage({ type: MSG.STREAM_END, fullText })
  return fullText
}

// ─── Main streaming entry point ───────────────────────────────────────────────

export async function streamChat(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  settings: Settings,
  port: StreamPort,
  streamKey: number | string,
  highPriority = true
): Promise<string> {
  const got = highPriority
    ? await rateLimiter.consumeWithWait(5000)
    : rateLimiter.consume()

  if (!got) {
    port.postMessage({ type: MSG.STREAM_ERROR, error: 'Rate limit reached — model is busy. Try again shortly.' })
    return ''
  }

  const controller = new AbortController()
  abortControllers.set(streamKey, controller)

  try {
    const format = getApiFormat(settings)
    if (format === 'anthropic') {
      return await streamAnthropic(messages, settings, port, controller)
    }
    return await streamOpenAI(messages, settings, port, controller)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return ''
    const message = err instanceof Error ? err.message : String(err)
    port.postMessage({ type: MSG.STREAM_ERROR, error: `Connection error: ${message}` })
    return ''
  } finally {
    abortControllers.delete(streamKey)
  }
}

// ─── Non-streaming call (for background tasks) ───────────────────────────────

export async function callAI(
  messages: Pick<ChatMessage, 'role' | 'content'>[],
  settings: Settings,
  maxTokens = 512
): Promise<string> {
  const format = getApiFormat(settings)
  const baseUrl = getBaseUrl(settings)
  const headers = getAuthHeaders(settings)

  try {
    if (format === 'anthropic') {
      const { system, messages: msgs } = buildAnthropicMessages(messages)
      const body: Record<string, unknown> = { model: settings.lmStudioModel, messages: msgs, max_tokens: maxTokens }
      if (system) body.system = system

      const res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) })
      if (!res.ok) return ''
      const json = await res.json() as { content?: Array<{ text?: string }> }
      return json.content?.[0]?.text ?? ''
    }

    const body = {
      model: settings.lmStudioModel,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature: 0.7,
    }
    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) return ''
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return json.choices?.[0]?.message?.content ?? ''
  } catch {
    return ''
  }
}

// ─── Fetch models ─────────────────────────────────────────────────────────────

export async function fetchModels(baseUrl: string, authToken?: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {}
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`

  try {
    const response = await fetch(`${url}/v1/models`, { headers })
    if (!response.ok) return []
    const json = await response.json() as { data?: Array<{ id: string }> }
    return (json.data ?? []).map(m => m.id)
  } catch {
    return []
  }
}

// ─── System prompt builder ────────────────────────────────────────────────────

export function buildSystemPrompt(pageContext: string, recentMemory: string, capabilities?: APICapabilities): string {
  const now = new Date().toLocaleString()
  const hasVision = capabilities?.supportsVision ?? false

  return `You are LocalAI Assistant, an intelligent browser AI running locally on the user's machine. You have deep understanding of web pages and can help with anything the user needs.

Current time: ${now}

Your capabilities:
- Read and analyze the current page (forms, buttons, links, text content)
- Fill forms, click buttons, navigate pages when the user asks
- Answer questions about page content, emails, chats
- Remember context across tabs and browsing sessions
- Detect appointments and offer calendar entries
- Rewrite and improve user text (grammar, tone)
- Draft email replies and analyze conversations
${hasVision ? '- Analyze screenshots of the page (vision model active)' : ''}

When the user asks you to interact with the page, respond with structured actions:
- Click an element: [ACTION:CLICK selector="CSS_SELECTOR"]
- Type into a field: [ACTION:TYPE selector="CSS_SELECTOR" value="TEXT"]
- Select a dropdown option: [ACTION:SELECT_OPTION selector="CSS_SELECTOR" value="OPTION_VALUE_OR_LABEL"]
- Toggle a checkbox/radio: [ACTION:CHECK selector="CSS_SELECTOR" value="true|false"]
- Clear a field: [ACTION:CLEAR selector="CSS_SELECTOR"]
- Navigate to a URL: [ACTION:NAVIGATE url="URL"]
- Scroll the page: [ACTION:SCROLL direction="down|up"]
- Read an element's text: [ACTION:READ selector="CSS_SELECTOR"]
- Read all options of a select/radio: [ACTION:READ_OPTIONS selector="CSS_SELECTOR"]
- Take a screenshot: [ACTION:SCREENSHOT]
- Wait for page to load: [ACTION:WAIT ms="MILLISECONDS"]
- Get fresh page state: [ACTION:GET_PAGE_STATE]

Action guidelines:
- Use the CSS selectors provided in the page context below. Prefer #id selectors, then [name="..."], then the full path.
- For <select> dropdowns, use SELECT_OPTION with the option's value or visible label text.
- For checkboxes and radio buttons, use CHECK with value="true" to check or value="false" to uncheck.
- After complex interactions (e.g. clicking a button that loads new content), use WAIT followed by GET_PAGE_STATE to see the result.
- You can chain multiple actions in one response. They execute sequentially.
- If a form has many fields, fill them all in one response using multiple TYPE/SELECT_OPTION/CHECK actions.
- The user may be interacting with the page simultaneously. If an action fails because the user is active, it will be retried automatically.

General guidelines:
- Be concise and direct. Lead with the answer.
- When filling forms, use vault data when available.
- Never request sensitive data — it's in the vault.
- If you detect an appointment or date in a conversation, mention it proactively.
- If you see the user writing text, offer to improve it.
- Always analyze field values and available options before choosing what to fill.
- If unsure about the correct value for a field, ASK the user before acting.

${pageContext ? `\n## Current Page\n${pageContext}` : ''}
${recentMemory ? `\n## Recent Context\n${recentMemory}` : ''}`.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
