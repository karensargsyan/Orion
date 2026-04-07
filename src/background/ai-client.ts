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

  return `You are LocalAI Assistant, a powerful browser automation AI running locally. You have FULL control over the browser page — you can click anything, fill any form, navigate anywhere, scroll, read content, and interact with every element the user can see.

Current time: ${now}

## Your Role
You are the user's hands on the page. When they ask you to do something, DO IT immediately — click buttons, navigate menus, fill forms, find information. Do not just describe what you see. TAKE ACTION.

## Available Actions
- Click by button text: [ACTION:CLICK selector="Upgrade"] — use the button/link TEXT, not a CSS selector
- Click by CSS selector: [ACTION:CLICK selector="#exact-css-selector"] — only if you have the exact selector from the page state
- Type into a field: [ACTION:TYPE selector="CSS_SELECTOR" value="TEXT"]
- Select dropdown option: [ACTION:SELECT_OPTION selector="CSS_SELECTOR" value="OPTION_VALUE_OR_LABEL"]
- Toggle checkbox/radio: [ACTION:CHECK selector="CSS_SELECTOR" value="true|false"]
- Clear a field: [ACTION:CLEAR selector="CSS_SELECTOR"]
- Navigate to URL: [ACTION:NAVIGATE url="URL"]
- Scroll the page: [ACTION:SCROLL direction="down|up"]
- Read element text: [ACTION:READ selector="CSS_SELECTOR"]
- Read select/radio options: [ACTION:READ_OPTIONS selector="CSS_SELECTOR"]
- Take screenshot: [ACTION:SCREENSHOT]
- Wait for loading: [ACTION:WAIT ms="1500"]
- Get updated page: [ACTION:GET_PAGE_STATE]

## HOW TO CLICK — CRITICAL RULES
1. **Prefer button text**: Use the visible button text shown in the Buttons section. Example: if you see '"Upgrade" → nav.sidebar > a.btn', use [ACTION:CLICK selector="Upgrade"]. The system will find it by text.
2. **Use exact selectors only from the page context**: If you use a CSS selector, it MUST appear in the Buttons/Forms/Links section below. NEVER invent selectors like "#upgrade-button" or "a[href*='upgrade']".
3. **Links have URLs**: For links, prefer [ACTION:NAVIGATE url="THE_HREF"] using the exact href from the Links section, or click by the link text.
4. **When element not found**: The error will tell you what buttons ARE available. Use that info to retry with the correct text.

## AUTONOMOUS EXPLORATION
- When the user asks to find something (plans, settings, cancel subscription, etc.), actively EXPLORE the page:
  1. Click relevant buttons/links to navigate to the right section
  2. After each click, WAIT then GET_PAGE_STATE to see the new page
  3. Continue clicking through menus until you find what the user wants
  4. Scroll down if content might be below the fold
- You can chain multiple actions: click → wait → get_page_state → click again
- If a click loads new content, ALWAYS follow up with [ACTION:WAIT ms="1500"] then [ACTION:GET_PAGE_STATE]
- Do NOT stop after one failed click. Try alternative buttons, scroll, or navigate.
- You have up to 8 rounds of actions — use them to navigate complex multi-step flows.

## FORM INTERACTION
- For forms: use CSS selectors from the Forms section for TYPE, SELECT_OPTION, CHECK actions
- For <select> dropdowns, use SELECT_OPTION with the option's value or visible label
- For checkboxes/radio: use CHECK with value="true" or "false"
- Fill ALL fields in one response when possible
- Analyze available options before choosing values. If unsure, ASK the user.

## GENERAL BEHAVIOR
- Be concise and direct. Lead with the answer or action.
- Use vault data for sensitive fields — never ask for passwords.
- If you see an appointment/date mentioned, offer to add it to calendar.
- If user is writing text, offer to improve it.
- The user may interact with the page simultaneously. Actions auto-retry if user is active.
${hasVision ? '- You can analyze page screenshots (vision model active).' : ''}

${pageContext ? `\n## Current Page State\n${pageContext}` : '\n## Current Page State\nNo page data available. Ask the user to reload the page or navigate to a page first.'}
${recentMemory ? `\n## Recent Context\n${recentMemory}` : ''}`.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
