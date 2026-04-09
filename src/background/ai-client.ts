import { TOKEN_BUCKET_STORAGE } from '../shared/constants'
import type { ChatMessage, Settings, APICapabilities } from '../shared/types'
import { MSG } from '../shared/constants'
import { streamGemini, callGemini } from './gemini-client'

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

/** Wraps a runtime port so postMessage never throws after the side panel disconnects. */
export function wrapStreamPort(port: chrome.runtime.Port): StreamPort {
  return {
    postMessage(msg: object) {
      try {
        port.postMessage(msg)
      } catch {
        /* Port disconnected (side panel closed) — ignore */
      }
    },
  }
}

/** Abort every in-flight streaming request (e.g. when the ai-stream port disconnects). */
export function abortAllStreams(): void {
  for (const controller of abortControllers.values()) {
    controller.abort()
  }
  abortControllers.clear()
}

// ─── Format detection ─────────────────────────────────────────────────────────

function resolveProvider(settings: Settings): { format: 'openai' | 'anthropic' | 'gemini'; baseUrl: string; model: string; authToken: string } {
  const provider = settings.activeProvider || 'local'

  switch (provider) {
    case 'gemini':
      return {
        format: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: settings.geminiModel || 'gemini-2.0-flash',
        authToken: settings.geminiApiKey || '',
      }
    case 'openai':
      return {
        format: 'openai',
        baseUrl: 'https://api.openai.com',
        model: settings.openaiModel || 'gpt-4o-mini',
        authToken: settings.openaiApiKey || '',
      }
    case 'anthropic':
      return {
        format: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: settings.anthropicModel || 'claude-sonnet-4-20250514',
        authToken: settings.anthropicApiKey || '',
      }
    default: {
      const caps = settings.apiCapabilities
      const format = caps?.apiFormat === 'anthropic' ? 'anthropic' as const : 'openai' as const
      const baseUrl = (caps?.baseUrl || settings.lmStudioUrl).replace(/\/+$/, '')
      return {
        format,
        baseUrl,
        model: settings.lmStudioModel || '',
        authToken: settings.authToken || 'lm-studio',
      }
    }
  }
}

function getApiFormat(settings: Settings): 'openai' | 'anthropic' | 'gemini' {
  return resolveProvider(settings).format
}

function getBaseUrl(settings: Settings): string {
  return resolveProvider(settings).baseUrl
}

function getActiveModel(settings: Settings): string {
  return resolveProvider(settings).model
}

function getAuthHeaders(settings: Settings): Record<string, string> {
  const { format, authToken } = resolveProvider(settings)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (format === 'anthropic') {
    headers['x-api-key'] = authToken
    headers['anthropic-version'] = '2023-06-01'
  } else if (format !== 'gemini') {
    headers['Authorization'] = `Bearer ${authToken}`
  }
  return headers
}

// ─── Vision support ───────────────────────────────────────────────────────────

function supportsVision(settings: Settings): boolean {
  if (!settings.visionEnabled) return false
  // Check actual model capability for local models
  const provider = settings.activeProvider || 'local'
  if (provider === 'local') {
    return settings.apiCapabilities?.supportsVision ?? false
  }
  // External providers (openai, anthropic, gemini) all support vision on modern models
  return true
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
  // Only use vision format when the model actually supports it (prevents text-only LLMs from choking on image_url content)
  const hasVision = supportsVision(settings)
  const body = {
    model: getActiveModel(settings) || undefined,
    messages: buildOpenAIMessages(messages, hasVision),
    stream: true,
    temperature: getAdaptiveTemperature(settings),
    max_tokens: getAdaptiveMaxTokens(settings, true),
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
    const choices = parsed?.choices as Array<{ delta?: { content?: string; reasoning_content?: string } }> | undefined
    const delta = choices?.[0]?.delta
    // Prefer content; also capture reasoning_content for reasoning models (Gemma 4, etc.)
    // so actions embedded in reasoning are not lost
    return delta?.content || delta?.reasoning_content || ''
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
    model: getActiveModel(settings) || undefined,
    messages: anthropicMsgs,
    stream: true,
    temperature: getAdaptiveTemperature(settings),
    max_tokens: getAdaptiveMaxTokens(settings, true),
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
  let lastCheckLen = 0

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

    if (fullText.length - lastCheckLen > 500) {
      lastCheckLen = fullText.length
      if (detectStreamRepetition(fullText)) {
        reader.cancel().catch(() => {})
        break
      }
    }
  }

  if (buffer.trim()) {
    const line = buffer.trim()
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim()
      if (data && data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data)
          const chunk = extractChunk(parsed)
          if (chunk) {
            fullText += chunk
            port.postMessage({ type: MSG.STREAM_CHUNK, chunk })
          }
        } catch { /* skip */ }
      }
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
  let lastCheckLen = 0

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

    if (fullText.length - lastCheckLen > 500) {
      lastCheckLen = fullText.length
      if (detectStreamRepetition(fullText)) {
        reader.cancel().catch(() => {})
        break
      }
    }
  }

  if (buffer.trim()) {
    const line = buffer.trim()
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim()
      try {
        const event = JSON.parse(data)
        if (event.type === 'content_block_delta' && event.delta?.text) {
          fullText += event.delta.text
          port.postMessage({ type: MSG.STREAM_CHUNK, chunk: event.delta.text })
        }
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
    if (format === 'gemini') {
      return await streamGemini(messages, settings, port, controller)
    }
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
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  settings: Settings,
  maxTokens = 512,
  forceVision = false
): Promise<string> {
  const format = getApiFormat(settings)

  if (format === 'gemini') {
    return callGemini(messages, settings, maxTokens)
  }

  const baseUrl = getBaseUrl(settings)
  const headers = getAuthHeaders(settings)
  const hasVision = forceVision || supportsVision(settings)
  const model = getActiveModel(settings)

  try {
    if (format === 'anthropic') {
      const { system, messages: msgs } = buildAnthropicMessages(messages)
      const body: Record<string, unknown> = { model, messages: msgs, max_tokens: maxTokens, temperature: getAdaptiveTemperature(settings) }
      if (system) body.system = system

      const res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) })
      if (!res.ok) {
        console.warn(`[LocalAI] callAI Anthropic error: ${res.status} ${res.statusText}`)
        return ''
      }
      const json = await res.json() as { content?: Array<{ text?: string }>; error?: { message?: string } }
      if (json.error?.message) {
        console.warn(`[LocalAI] callAI Anthropic API error: ${json.error.message}`)
        return ''
      }
      return json.content?.[0]?.text ?? ''
    }

    const body = {
      model,
      messages: buildOpenAIMessages(messages, hasVision),
      max_tokens: maxTokens,
      temperature: getAdaptiveTemperature(settings),
    }
    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) {
      // Try to read the error body for details (e.g., LM Studio "insufficient system resources")
      try {
        const errBody = await res.text()
        console.warn(`[LocalAI] callAI error ${res.status}: ${errBody.slice(0, 300)}`)
      } catch {
        console.warn(`[LocalAI] callAI error: ${res.status} ${res.statusText}`)
      }
      return ''
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      error?: { message?: string; code?: string };
    }
    // LM Studio sometimes returns 200 OK with an error object in the body
    if (json.error?.message) {
      console.warn(`[LocalAI] callAI model error: ${json.error.message}`)
      return ''
    }
    const msg = json.choices?.[0]?.message
    // Prefer content; fall back to reasoning_content if content is empty
    // (reasoning models like Gemma 4 may put actions in reasoning when
    // they exhaust max_tokens before producing content)
    return msg?.content || msg?.reasoning_content || ''
  } catch (err) {
    console.warn(`[LocalAI] callAI network error:`, err)
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

// ─── Token estimation & adaptive parameters ──────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export function getAdaptiveTemperature(settings: Settings): number {
  // Local small models need low temperature for deterministic action output
  if (settings.activeProvider === 'local') {
    return settings.liteMode ? 0.2 : 0.4
  }
  return 0.7
}

export function getAdaptiveMaxTokens(settings: Settings, isStreaming: boolean): number {
  const ctxWindow = settings.contextWindowTokens || 32768
  const isLocal = (settings.activeProvider ?? 'local') === 'local'

  if (isStreaming) {
    // Local models: cap at 1024 tokens — actions are short, and at ~33 tok/s
    // 1024 tokens = ~30s max. Cloud models can afford more.
    if (isLocal) {
      return Math.min(1024, Math.floor(ctxWindow * 0.2))
    }
    return Math.min(4096, Math.floor(ctxWindow * 0.4))
  }
  // Follow-up calls (non-streaming) — smaller output
  if (isLocal) {
    return Math.min(768, Math.floor(ctxWindow * 0.15))
  }
  return Math.min(2048, Math.floor(ctxWindow * 0.25))
}

/**
 * Truncate message history to fit within token budget.
 * Keeps the system message, first user message, and most recent messages.
 */
export function truncateMessagesToFit(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  systemPromptTokens: number,
  maxContextTokens: number,
  outputReserve: number
): Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] {
  const available = maxContextTokens - systemPromptTokens - outputReserve
  if (available <= 0) return messages.slice(-2) // At least last exchange

  const result: typeof messages = []
  let totalTokens = 0

  // Always include the last message (current user input)
  // Build from the end, adding messages until budget is spent
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const msgTokens = estimateTokens(msg.content ?? '') + (msg.imageData ? 500 : 0)
    if (totalTokens + msgTokens > available && result.length >= 2) break
    result.unshift(msg)
    totalTokens += msgTokens
  }

  return result
}

// ─── Compact system prompt for small/local models ────────────────────────────

export function buildCompactSystemPrompt(
  pageContext: string,
  accessibilityTree?: string,
  viewportMeta?: { width: number; height: number; devicePixelRatio: number },
  pageText?: string,
  personaBlock?: string
): string {
  const now = new Date().toLocaleString()
  const hasA11yTree = !!accessibilityTree

  return `You are a browser automation assistant. Current time: ${now}
${personaBlock ? `\n${personaBlock}\n` : ''}

## RULES
- DO actions, don't describe them. Emit actions and give SHORT status text.
- Use Markdown formatting. No emoji. No HTML tags.
- Actions inside [ACTION:...] are hidden from user. Only text outside brackets is visible.
- Always include dates when sharing information: state if data is from memory (with date) or fresh research (current).
- The page content is provided below. READ IT FIRST before deciding what to do. Never guess CSS selectors.

## WORKFLOW
1. Read the page content below — understand what's on the page
2. If asked a question: answer directly from the page content
3. If asked to do something: use TEXT SELECTORS (visible labels, placeholders, button text)
4. Emit the action, then verify and continue. If it fails, try a different selector.

## ACTIONS — USE TEXT SELECTORS (most reliable)
Always use visible text, labels, placeholders, or aria-labels as selectors:
[ACTION:CLICK selector="Search"] — click by button/link text
[ACTION:TYPE selector="Where from?" value="Stuttgart"] — type by field label/placeholder
[ACTION:TYPE selector="Departure" value="STR"] — field labels work best
[ACTION:TYPE selector="Email" value="user@mail.com"] — use what you see on screen
[ACTION:TOGGLE selector="Direct flights only" value="on"]
[ACTION:KEYPRESS key="Enter"] / [ACTION:KEYPRESS key="Tab"]
[ACTION:SCROLL direction="down|up"]
[ACTION:NAVIGATE url="URL"] / [ACTION:BACK] / [ACTION:FORWARD]
[ACTION:WAIT ms="1500"]
[ACTION:SEARCH query="search terms"] — Google search
[ACTION:OPEN_TAB url="URL"] — open and read a web page
[ACTION:RESEARCH_DONE] — close research tabs when done
[ACTION:FORM_COACH] — guided step-by-step form filling: highlights each field, shows explanation + suggested value, user accepts/skips each one
[ACTION:GET_PAGE_TEXT] — get full page text
[ACTION:SCREENSHOT] — visual capture

## SELECTOR TIPS
- Use the field's VISIBLE LABEL: selector="Where from?", selector="Passengers"
- Use placeholder text: selector="Search", selector="Enter your email"
- Use button text: selector="Search flights", selector="Submit"
- Use CSS only as last resort: selector="input[name=q]", selector="textarea"
- Do NOT use element IDs unless you just called [ACTION:READ_PAGE]
- NEVER describe the page — just emit the action immediately
- If an action fails, try a DIFFERENT selector (CSS, aria-label, etc.)

## COMPLETION
When the task is done, include {"is_complete": true} in your response.
${hasA11yTree ? `
## ACCESSIBILITY TREE
${viewportMeta ? `Viewport: ${viewportMeta.width}x${viewportMeta.height}` : ''}
Elements listed with [ID], [Role], [Name], [State], [Coords]. Use element_id to target precisely.
${accessibilityTree}` : ''}
${pageContext ? `\n## PAGE STATE\n${pageContext}` : ''}
${pageText ? `\n## PAGE CONTENT\nFull text content of the current page. Use this to answer questions and understand the page.\n\n${pageText}` : ''}`.trim()
}

// ─── System prompt builder ────────────────────────────────────────────────────

export function buildSystemPrompt(
  pageContext: string,
  recentMemory: string,
  capabilities?: APICapabilities,
  knownUserData?: string,
  domainSkills?: string,
  accessibilityTree?: string,
  behaviorKnowledge?: string,
  userInstructions?: string,
  mempalaceContext?: string,
  viewportMeta?: { width: number; height: number; devicePixelRatio: number },
  sitemapContext?: string,
  pageText?: string,
  personaBlock?: string
): string {
  const now = new Date().toLocaleString()
  const hasVision = capabilities?.supportsVision ?? false
  const hasA11yTree = !!accessibilityTree

  return `You are Orion — an autonomous browser agent. Current time: ${now}
${personaBlock ? `\n${personaBlock}\n` : ''}

## CORE PRINCIPLES
1. **READ first, ACT second.** The page content is provided below. Read it before doing anything. Answer questions directly from the page text — do NOT issue read actions when the answer is already in front of you.
2. **ACT, don't describe.** When asked to do something, DO IT with actions. Never narrate — emit the action and move on.
3. **Be autonomous.** Chain actions across rounds until the task is COMPLETE. Only ask permission for destructive/financial actions.
4. **Recover from failures.** If an action fails, try a different approach immediately.
5. **Verify results.** After important actions, check that the page changed as expected.
6. **Date your information.** When citing memory, state the date. When citing research, note it is current. When citing page content, say "the page currently shows..."
7. **Use Markdown.** Format with **bold**, bullet lists, headings. Never raw HTML tags. Never emoji.
8. **Be concise.** Short status updates (1-3 sentences). Longer formatted output for reports/summaries.
9. **Never output internal markers.** No CSS selectors, no [ACTION_RESULT], no call:Orion, no raw page state.

## READING THE PAGE
The page content is provided below under "Page Content". Use it to answer questions directly.
- If the excerpt was truncated and you need MORE text: [ACTION:GET_PAGE_TEXT]
- If you need interactive elements with IDs for clicking: [ACTION:READ_PAGE filter="interactive"]
- **Use visible text, labels, and placeholders as selectors.** Do NOT use element IDs unless you just called READ_PAGE.
${hasA11yTree ? `
## ACCESSIBILITY TREE (reference only — use text selectors, not IDs)
${viewportMeta ? `Viewport: ${viewportMeta.width}x${viewportMeta.height} at ${viewportMeta.devicePixelRatio}x DPR.` : ''}
${accessibilityTree}` : ''}

## ACTIONS — TEXT SELECTORS (primary, most reliable)
Always prefer visible text, labels, placeholders, or aria-labels:
[ACTION:CLICK selector="Search flights"] — click by button/link text
[ACTION:TYPE selector="Where from?" value="Stuttgart"] — type by field label
[ACTION:TYPE selector="Departure" value="STR"] — placeholder text works too
[ACTION:TOGGLE selector="Direct flights only" value="on"]
[ACTION:KEYPRESS key="Enter"] / [ACTION:KEYPRESS key="Tab"]
[ACTION:HOVER selector="text"] / [ACTION:DOUBLECLICK selector="text"]
[ACTION:SELECT_OPTION selector="Currency" value="EUR"]
[ACTION:FILL_FORM assignments='[{"selector":"Email","value":"user@mail.com","inputType":"text"}]']

## ACTIONS — NAVIGATION & RESEARCH
[ACTION:NAVIGATE url="URL"] / [ACTION:BACK] / [ACTION:FORWARD]
[ACTION:SCROLL direction="down|up"] / [ACTION:SCROLL_TO selector="text"]
[ACTION:WAIT ms="1500"]
[ACTION:SEARCH query="terms"] — Google search
[ACTION:OPEN_TAB url="URL"] — open and read a web page
[ACTION:RESEARCH_DONE] — close research tabs when done

## ACTIONS — FORM ASSISTANCE
[ACTION:FORM_COACH] — start guided form filling: walks through each field step-by-step, highlights it, shows explanation + suggested value, user accepts or skips. Use when user asks for help filling a form (visa, registration, application, etc.)

## ACTIONS — PAGE READING
[ACTION:GET_PAGE_TEXT] — full page text
[ACTION:READ_PAGE filter="interactive"] — get elements with IDs (for complex pages)
[ACTION:SCREENSHOT] — visual capture

## ACTIONS — ELEMENT IDs (only after READ_PAGE)
After calling READ_PAGE, you may use JSON format with element_id:
{"element_id": 5, "action": "click", "is_complete": false}
{"element_id": 5, "action": "type", "text_content": "hello"}
But text selectors are preferred — element IDs can become stale on dynamic pages.

## WORKFLOW
1. **READ**: Page content is below. If you need more, use GET_PAGE_TEXT.
2. **ACT**: Use text selectors (labels, placeholders, button text). Emit actions immediately.
3. **VERIFY**: Check results. If a selector failed, try a different one (CSS, aria-label, etc.).
4. **COMPLETE**: When done, include {"is_complete": true} in your response.

## TOGGLES & CHECKBOXES
Check [State: ON/OFF] before toggling. Use TOGGLE action (reads state, only clicks if needed). Bulk toggles: JSON array.

## WEB RESEARCH
When asked about topics, products, or anything needing external context:
1. [ACTION:SEARCH query="..."] — find relevant results
2. [ACTION:OPEN_TAB url="..."] — read 2-3 best results (tabs grouped under "Orion")
3. Synthesize findings with source citations and dates
4. [ACTION:RESEARCH_DONE] — close research tabs
Always cite sources and publication/access dates. Group findings by date.

## USER WIDGETS
Choices: [CHOICE:id="id"] Option A | Option B | Option C [/CHOICE]
Confirmations: [CONFIRM:id="id"] Button Label [/CONFIRM]
Use only for genuinely ambiguous or destructive decisions.

## SECURITY
Analyze emails/messages for phishing: urgency language, mismatched domains, credential requests, suspicious links. Warn if threats detected.
${sitemapContext ? `\n## SITE MAP\n${sitemapContext}\n` : ''}${hasVision ? `\n## VISION\nScreenshot attached for visual layout. Cross-reference with accessibility tree.${viewportMeta ? ` Viewport: ${viewportMeta.width}x${viewportMeta.height} px.` : ''}\n` : ''}${knownUserData ? `\n## Known User Data\n${knownUserData}` : ''}${domainSkills ? `\n${domainSkills}` : ''}${behaviorKnowledge ? `\n${behaviorKnowledge}` : ''}${userInstructions ? `\n${userInstructions}` : ''}
${pageContext ? `\n## Current Page State\n${pageContext}` : '\n## Current Page State\nNo page data available.'}
${pageText ? `\n## Page Content\nFull text content of the current page. READ THIS to answer questions and understand the page. Do NOT issue read actions when the answer is here.\n\n${pageText}` : ''}
${mempalaceContext ? `\n## MemPalace (long-term memory — check dates)\n${mempalaceContext}` : ''}
${recentMemory ? `\n## Recent Context (entries prefixed with [date] — cite dates)\n${recentMemory}` : ''}`.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function detectStreamRepetition(text: string): boolean {
  if (text.length < 600) return false

  const tail = text.slice(-400)
  const body = text.slice(0, -400)
  if (body.includes(tail.slice(0, 150))) return true

  const malformedCount = (text.match(/call:[\w]*:?[\w]*\{/gi) ?? []).length
  if (malformedCount >= 5) return true

  return false
}
