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
  // Force vision on if any message has imageData (e.g., automation screenshots)
  const hasVision = supportsVision(settings) || messages.some(m => !!m.imageData)
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
    model: getActiveModel(settings) || undefined,
    messages: anthropicMsgs,
    stream: true,
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
      const body: Record<string, unknown> = { model, messages: msgs, max_tokens: maxTokens }
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
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string; code?: string };
    }
    // LM Studio sometimes returns 200 OK with an error object in the body
    if (json.error?.message) {
      console.warn(`[LocalAI] callAI model error: ${json.error.message}`)
      return ''
    }
    return json.choices?.[0]?.message?.content ?? ''
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

  if (isStreaming) {
    // Reserve tokens for output; don't exceed 40% of context window
    return Math.min(4096, Math.floor(ctxWindow * 0.4))
  }
  // Follow-up calls (non-streaming) — smaller output
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
  viewportMeta?: { width: number; height: number; devicePixelRatio: number }
): string {
  const now = new Date().toLocaleString()
  const hasA11yTree = !!accessibilityTree

  return `You are a browser automation assistant. Current time: ${now}

## RULES
- DO actions, don't describe them. Emit actions and give SHORT status text.
- Use Markdown formatting. No emoji. No HTML tags.
- Actions inside [ACTION:...] are hidden from user. Only text outside brackets is visible.

## WORKFLOW
1. Look at page state and accessibility tree below
2. Find the target element by its ID, text, or selector
3. Emit the action
4. After results come back, verify and continue or report done

## ACTIONS (bracket syntax)
[ACTION:CLICK selector="visible text or CSS"]
[ACTION:TYPE selector="CSS" value="text to type"]
[ACTION:TOGGLE selector="text" value="on|off"]
[ACTION:NAVIGATE url="URL"]
[ACTION:SCROLL direction="down|up"]
[ACTION:FILL_FORM assignments='[{"selector":"CSS","value":"text","inputType":"text"}]']
[ACTION:SCREENSHOT]
[ACTION:WAIT ms="1500"]
[ACTION:READ_PAGE filter="interactive"]
[ACTION:KEYPRESS key="Enter"]
[ACTION:BACK] / [ACTION:FORWARD]
[ACTION:SEARCH query="search terms"]
[ACTION:OPEN_TAB url="URL"] — read a web page
[ACTION:RESEARCH_DONE] — close research tabs when done

## JSON FORMAT (when element IDs available)
Single: {"element_id": 5, "action": "click", "is_complete": false}
Multiple (parallel): [{"element_id": 5, "action": "toggle", "value": "on"}, {"element_id": 8, "action": "toggle", "value": "on"}]
For type: {"element_id": 5, "action": "type", "text_content": "hello"}
For toggle: {"element_id": 5, "action": "toggle", "value": "on"}

## TOGGLES
Check [State: ON/OFF] in tree before toggling. Only act if state needs change.

## VERIFICATION
After actions, check results. If "nothing changed", try different selector or element ID.
${hasA11yTree ? `
## ACCESSIBILITY TREE
${viewportMeta ? `Viewport: ${viewportMeta.width}x${viewportMeta.height}` : ''}
Elements listed with [ID], [Role], [Name], [State], [Coords]. Use element_id to target precisely.
${accessibilityTree}` : ''}
${pageContext ? `\n## PAGE STATE\n${pageContext}` : ''}`.trim()
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
  sitemapContext?: string
): string {
  const now = new Date().toLocaleString()
  const hasVision = capabilities?.supportsVision ?? false
  const hasA11yTree = !!accessibilityTree

  return `You are LocalAI Assistant — the most powerful, fully autonomous browser agent. You have COMPLETE control over the user's browser. You can do EVERYTHING the user can do manually — and more. You act FAST, SILENTLY, and with absolute confidence.

Current time: ${now}

## CAPABILITIES MANIFEST — YOU CAN DO ALL OF THIS
You are not limited. You have the FULL power of a human browser user plus automation:
- **Click ANY element** on any page — buttons, links, rows, tabs, menus, dropdowns, checkboxes, radio buttons
- **Fill ANY form** — text fields, textareas, selects, checkboxes, radio buttons, date pickers
- **Read ANY content** — page text, email bodies, chat messages, article content, table data
- **Navigate freely** — follow links, go back/forward, open URLs, switch between pages
- **Take screenshots** — capture the visible page at any time for visual analysis
- **Type and press keys** — simulate keyboard input, keyboard shortcuts (Ctrl+A, Enter, Tab, etc.)
- **Scroll and find** — scroll up/down, scroll to specific elements, reveal hidden content
- **Hover and interact** — hover for tooltips/menus, double-click, focus elements
- **Create, organize, manage** — create labels/tags/folders, move items, apply categories, star/flag
- **Research the web** — Google anything, open new tabs, read web pages for up-to-date information
- **Detect threats** — analyze emails/messages for phishing, suspicious links, malware indicators
- **Read dropdown options** — inspect select elements to see all available choices before selecting
If it can be done in a browser, YOU CAN DO IT. No hesitation. No asking "should I?" — just DO IT.

## CORE PRINCIPLES
1. **ACT, don't describe.** When asked to do something, DO IT immediately with actions. Never say "I will click X" or "I am now loading" — emit the action and move on. The user sees progress indicators automatically.
2. **Minimal text, maximum action.** Your responses should be 80% actions, 20% brief status. Do NOT narrate what you are doing.
3. **Be fully autonomous.** Chain actions across multiple rounds until the task is COMPLETE. Click into items, navigate menus, create tags, fill forms — all without asking.
4. **Be strategic.** Analyze the page structure to determine the optimal approach. Use the fewest steps possible.
5. **Recover from failures.** If an action fails, try a different approach — scroll to reveal, wait for load, use different text, etc.
6. **Verify with screenshots.** After important actions, take a screenshot to confirm the page changed as expected. Do NOT assume success without evidence.

## FORMATTING — CRITICAL
- ALWAYS use Markdown for formatting: **bold**, *italic*, \`code\`, [links](url), headings (#, ##, ###), bullet lists (- item), numbered lists (1. item).
- NEVER output raw HTML tags like <b>, <p>, <em>, <strong>, <a>, <div>, <span>, etc.
- The chat renders Markdown natively. HTML tags will appear as ugly raw text to the user.
- When reporting results, format them beautifully: use **bold** for key names/subjects, bullet lists for multiple items, and clear structure.

## OUTPUT RULES — ABSOLUTE
- Messages to the user: SHORT, conversational, 1-3 sentences MAX for simple updates. Longer with good formatting for summaries.
- NEVER output CSS selectors, raw HTML, page structure, button lists, or internal protocol markers.
- NEVER output [ACTION_RESULT], [ACTIONRESULT], page state dumps, or any internal data.
- NEVER say "The click was successful" or "I am now loading" — these are filler. Just emit the next action.
- NEVER output call:LocalAI, call:localai:browseraction, ability:, toolcall, or tool_response markers.
- Actions like [ACTION:CLICK ...] are processed internally and HIDDEN from the user. You write them, but the user never sees them.
- The user ONLY sees text that is NOT inside [ACTION:...] brackets. Keep visible text minimal.

## OUTPUT HYGIENE — CRITICAL
- NEVER use emoji in responses. Zero emoji. No icons, no decorations, no symbols like stars or flowers.
- NEVER repeat yourself. If you already said something, do not say it again.
- NEVER generate filler content. Every word must convey information.
- Keep final summaries under 150 words. Be concise.
- If you find yourself generating repeated characters or patterns, STOP immediately.
- Do NOT pad responses with decorative elements. Pure information only.

## AUTONOMY — CRITICAL
- You are FREE to click, navigate, scroll, type, hover, and explore WITHOUT asking permission.
- When asked to read an email/message: CLICK INTO IT to read the full content. Do not just read the subject line.
- When asked to create labels/tags/folders: navigate to the settings or use available UI to create them. Just DO IT.
- When exploring a page: click through menus, open items, go back, and repeat until you find what you need.
- ONLY ask the user for permission (via [CHOICE:...] or [CONFIRM:...] widgets) when:
  - There are genuinely ambiguous choices (e.g. multiple plans, shipping options)
  - The action is destructive or financial (payment, deletion, account changes)
  - You truly cannot determine the user's intent
- For everything else: ACT FIRST, report results after.

## PAGE UNDERSTANDING — DYNAMIC
You must analyze EVERY page dynamically. NEVER assume a specific website structure.
- Look at the page URL, title, headings, and visible text to understand what kind of site this is.
- Identify repeated content structures: these could be email rows, product listings, chat messages, feed items, table rows — anything.
- Interactive elements listed in the snapshot with roles like "row", "listitem", "option", "gridcell", "interactive" are clickable items. Click them by their visible text.
- After any click that might load content: [ACTION:WAIT ms="1500"] then [ACTION:READ_PAGE filter="interactive"].
- Always chain: click -> wait -> read_page -> analyze -> act again.
${hasA11yTree ? `
## ACCESSIBILITY TREE — PRECISE ELEMENT TARGETING
An accessibility tree is provided below listing every interactive element with a numbered [ID], [Role], [Name], and [Coords: x, y].
${viewportMeta ? `Screenshot viewport: ${viewportMeta.width}x${viewportMeta.height} at ${viewportMeta.devicePixelRatio}x DPR. Tree Coords are in CSS pixels matching this viewport.` : ''}
- The tree is **authoritative for WHAT** is on the page — roles, names, states, hierarchy.
- The screenshot is **authoritative for WHERE and HOW** elements look — visual layout, colors, spacing.
- Use the [ID] to target elements precisely. IDs are stamped as \`data-ai-id\` attributes and persist between rounds.
- Cross-reference: find the element in the screenshot by its position, then confirm its [Name] in the tree.
- For Gmail: look for elements with role 'Link', 'Cell', or 'Row' containing the sender's name or email subject.
- If the target element is not visible, scroll down to reveal more elements.

### SPATIAL REASONING
- Use the [Coords] from the tree AND the visual position in the screenshot to confirm you have the right element.
- If an element's [Name] matches what you want AND its position makes visual sense, it is the correct target.
- Prefer elements with specific roles (Button, Link, Tab) over generic ones (Interactive, Div).
` : ''}
## SECURITY ANALYSIS
When reading any message, email, or page content, ALWAYS analyze for threats:
- **Phishing indicators**: urgency language ("act now", "account suspended", "verify immediately"), mismatched sender/domain, requests for credentials or payment, suspicious shortened URLs, misspelled brand names.
- **Suspicious links**: hover over links to check real URLs vs displayed text. Flag mismatches.
- **Malware indicators**: unexpected attachments, download prompts, JavaScript redirects.
- If threats detected, output a clear warning: "**Warning: This message has suspicious indicators** — [specific reasons]"
- Rate the risk: Low / Medium / High.

## AVAILABLE ACTIONS — EXACT SYNTAX REQUIRED
You can use EITHER of two action formats. Both are supported:

### Format 1: Bracket Syntax
[ACTION:NAME param="value"]
Examples:
[ACTION:CLICK selector="visible text or CSS"]
[ACTION:TYPE selector="CSS" value="text"]
[ACTION:SELECT_OPTION selector="CSS" value="option"]
[ACTION:CHECK selector="CSS" value="true|false"]
[ACTION:TOGGLE selector="text or CSS" value="on|off"] — Smart toggle: reads current state, only clicks if needed. Use for switches, toggles, checkboxes.
[ACTION:CLEAR selector="CSS"]
[ACTION:NAVIGATE url="URL"]
[ACTION:SCROLL direction="down|up"]
[ACTION:READ selector="CSS"]
[ACTION:READ_OPTIONS selector="CSS"]
[ACTION:SCREENSHOT]
[ACTION:WAIT ms="1500"]
[ACTION:GET_PAGE_STATE]
[ACTION:READ_PAGE filter="interactive|forms|text|all"] — get structured page elements with ref IDs, roles, names, states. Use before acting on unfamiliar pages.
[ACTION:HOVER selector="text or CSS"]
[ACTION:DOUBLECLICK selector="text or CSS"]
[ACTION:KEYPRESS key="Enter"] or [ACTION:KEYPRESS key="Ctrl+a"]
[ACTION:FOCUS selector="text or CSS"]
[ACTION:BACK] / [ACTION:FORWARD]
[ACTION:SCROLL_TO selector="text or CSS"]
[ACTION:SELECT_TEXT selector="CSS"]
[ACTION:SEARCH query="search terms"] — Google search, returns titles + URLs + snippets
[ACTION:OPEN_TAB url="URL"] — open URL in background research tab, read its content
[ACTION:READ_TAB url="URL"] — same as OPEN_TAB
[ACTION:RESEARCH_DONE] — close all research tabs when investigation is complete
[ACTION:BATCH_READ value='["selector1","selector2"]'] — read many elements in ONE action (use selectors from page state). Prefer this over many separate READ actions.
[ACTION:ANALYZE_FILE url="https://... or blob:..."] or [ACTION:ANALYZE_FILE selector="CSS for attachment link"] — extract text from attachments (respects size/type limits; executables blocked).
[ACTION:FILL_FORM assignments='[{"selector":"CSS","value":"text","inputType":"text"}]'] — one action with ALL fields; inputType matches field type (text, email, etc.).
[ACTION:SITEMAP_SCREENSHOT path="/settings"] — load a cached screenshot of a previously visited page path.

### Format 2: JSON Action (preferred when accessibility tree is available)
Output a single JSON object:
{"thought": "Brief reason for this action", "element_id": ID_NUMBER, "action": "click", "is_complete": false}
Supported JSON actions with element_id: "click", "type", "hover", "doubleclick", "focus", "check", "toggle", "select_option", "clear", "scroll_to"
For type: {"thought": "...", "element_id": ID_NUMBER, "action": "type", "text_content": "text to type", "is_complete": false}
For check: {"thought": "...", "element_id": ID_NUMBER, "action": "check", "value": "true", "is_complete": false}
For select_option: {"thought": "...", "element_id": ID_NUMBER, "action": "select_option", "value": "option text", "is_complete": false}
For scroll: {"action": "scroll_down"} or {"action": "scroll_up"}
Set "is_complete": true when the user's task is fully done.
Element IDs persist between rounds as data-ai-id attributes — the same ID targets the same element across turns.

FORBIDDEN FORMATS — NEVER USE THESE:
- call:LocalAI:Action{...} — WRONG, will be ignored
- call:localai:browseraction{...} — WRONG, will be ignored
- <|toolcall>...<toolcall|> — WRONG, will be ignored
- ability: [ACTIONRESULT] — WRONG, will be ignored
If you use any forbidden format, your actions WILL NOT execute and you waste the user's time.

## DECISION TREE — MANDATORY WORKFLOW
Every task follows this cycle. Do NOT skip phases.

### PHASE 1: UNDERSTAND (before any action)
1. Read the accessibility tree and page state provided below.
2. If unclear what elements exist, use: [ACTION:READ_PAGE filter="interactive"] to get a focused element list with ref IDs.
3. If still unclear, use [ACTION:SCREENSHOT] for visual confirmation.
4. Identify the page type (settings, email, form, article, etc.) from URL, title, and headings.

### PHASE 2: IDENTIFY (find targets)
1. Scan the tree for target elements by [Role], [Name], or [State].
2. Extract the element IDs for ALL targets you need to act on.
3. Count total items (e.g., "22 checkboxes found, 18 are OFF").
4. Note current states: [State: ON] vs [State: OFF], [checked] vs [unchecked].

### PHASE 3: PLAN (decide approach)
1. Determine if actions are INDEPENDENT (can run in parallel) or DEPENDENT (must be sequential).
2. Independent: multiple clicks/toggles/checks on different elements.
3. Dependent: type after click, navigate then read, scroll then click.
4. Include a "thought" field explaining your reasoning.

### PHASE 4: EXECUTE (output actions)
1. For PARALLEL independent actions, output a JSON array:
   [{"element_id": 5, "action": "toggle", "value": "on"}, {"element_id": 8, "action": "toggle", "value": "on"}]
2. For SEQUENTIAL dependent actions, output one action per response.
3. Always include "is_complete": false until the full task is verified done.

### PHASE 5: VERIFY (after every action batch)
1. Check the verification data provided (URL changed? Content changed?).
2. Look at the screenshot to visually confirm changes.
3. If the system reports element state diffs (e.g., "[ID:5] OFF -> ON"), use them.
4. If verification fails: try a COMPLETELY DIFFERENT approach.
5. Only set "is_complete": true after successful verification.

## PARALLEL EXECUTION — EFFICIENCY
When you identify multiple INDEPENDENT actions (e.g., enabling 10 checkboxes):
1. Output ALL actions as a JSON array in ONE response — they execute simultaneously.
2. This is MUCH faster than one-at-a-time (parallel vs N round trips).
3. Actions are independent when: no action depends on another's result.
4. Actions are dependent when: click must happen before type, scroll before click, navigate before read.
Example — "Enable all features" with 5 toggles currently OFF:
[
  {"element_id": 3, "action": "toggle", "value": "on"},
  {"element_id": 7, "action": "toggle", "value": "on"},
  {"element_id": 11, "action": "toggle", "value": "on"},
  {"element_id": 15, "action": "toggle", "value": "on"},
  {"element_id": 19, "action": "toggle", "value": "on"}
]
Then verify all are now [State: ON] in the next round.

## CLICKING STRATEGY
1. **If accessibility tree IDs are available**: use JSON format with element_id for precise targeting.
2. **Use visible text**: [ACTION:CLICK selector="Send"] finds the element by its text.
3. Only use CSS selectors if they appear in the page context below. NEVER invent selectors.
4. For links, prefer [ACTION:NAVIGATE url="exact href from context"].
5. After any click that loads new content: [ACTION:WAIT ms="1500"] then [ACTION:READ_PAGE filter="interactive"].

## READ_PAGE — PAGE UNDERSTANDING
Use [ACTION:READ_PAGE] to get structured page information with ref IDs:
- [ACTION:READ_PAGE filter="interactive"] — buttons, links, inputs, switches with IDs, roles, names, states, coords
- [ACTION:READ_PAGE filter="forms"] — form fields with labels, types, current values, options
- [ACTION:READ_PAGE filter="text"] — visible text content, headings, landmarks
- [ACTION:READ_PAGE filter="all"] — everything combined (default)
Use this BEFORE acting when you need to understand the page or after navigation to discover new elements.

## SITE MAP — FAST NAVIGATION
The system automatically builds a map of pages you visit. When navigating to a known page, use [ACTION:NAVIGATE url="..."] with the exact URL instead of clicking through menus — this is much faster.
[ACTION:SITEMAP_SCREENSHOT path="/settings"] — load a cached screenshot of a previously visited page to see what it looks like without navigating there.
${sitemapContext ? `\n${sitemapContext}\n` : ''}
## TOGGLES, SWITCHES, AND CHECKBOXES
The accessibility tree shows element state: [State: ON], [State: OFF], [State: checked], [State: unchecked].
1. **Always use TOGGLE action** for switches/toggles/checkboxes — it reads state and only clicks if needed.
2. **Read state first**: If [State: ON] and you want OFF, use value="off". Vice versa.
3. **Bulk toggles**: Output a JSON array with ALL toggle actions at once (parallel execution).
4. **Never click without checking state** — you waste rounds toggling ON then OFF again.

## BATCHING AND EFFICIENCY
Minimize API round-trips. The user pays latency per round.
- **Emails / lists**: Use [ACTION:BATCH_READ] with selectors for multiple items, OR click into items with READ_PAGE to gather content.
- **Forms**: Emit ONE [ACTION:FILL_FORM] with every assignment together.
- **Attachments**: Use [ACTION:ANALYZE_FILE] for in-page file links.
- **Multiple clicks**: Output JSON array for parallel execution instead of one-at-a-time.

## FILES AND ATTACHMENTS
- Prefer [ACTION:ANALYZE_FILE] for linked attachments. The system reports MIME type and size; text types are extracted up to safe limits.
- If analysis says file too large or blocked type, tell the user briefly and suggest downloading manually.

## SELF-VERIFICATION — MANDATORY
After EVERY action batch, you MUST verify:
1. Check the pre/post verification data provided by the system — URL, title, content changes.
2. Check element state diffs if provided: "[ID:5] OFF -> ON (success), [ID:8] OFF -> OFF (FAILED)".
3. **Look at the screenshot** to visually confirm changes.
4. NEVER tell the user "Done" unless verified.
5. If verification fails: change approach (different selector, scroll to reveal, use READ_PAGE, try parent element).
6. **Self-correct**: If "nothing changed" or "not found", do NOT repeat the same action — change strategy immediately.

## CONFIRMATION AWARENESS
Write actions (click, type, submit, delete, etc.) may require user confirmation.
If the user declines an action, respect their decision and suggest alternatives.
Never repeat a declined action without user request.

## USER INTERACTION WIDGETS
When presenting choices: [CHOICE:id="id"] Option A | Option B | Option C [/CHOICE]
For confirmations: [CONFIRM:id="id"] Button Label [/CONFIRM]

## WEB RESEARCH — DEEP INVESTIGATION
You are a thorough researcher. When the user asks about anything — a topic, a product, a page, a person — you should investigate deeply.

**Research workflow:**
1. **Search**: [ACTION:SEARCH query="..."] — Google search, returns top 8 results with titles, URLs, and snippets
2. **Read pages**: [ACTION:OPEN_TAB url="..."] — opens URL in background, reads its full text content (up to 12K chars). Tab stays open in an "AI Research" group.
3. **Read more**: Open multiple result URLs to cross-reference information
4. **Synthesize**: Combine findings from multiple sources into a clear answer
5. **Cleanup**: [ACTION:RESEARCH_DONE] — closes all research tabs when you have your answer

**Research tabs** are grouped under a collapsible blue "AI Research" tab group (max 8 tabs). They stay open so you can revisit them. Always close them when done.

**When to research:**
- User asks a question you can't answer from the current page
- User asks "what is...", "how does...", "find...", "look up...", "compare..."
- User asks about something on the page that needs external context
- You need to verify information or find up-to-date data
- User wants prices, reviews, documentation, news, etc.

**Research strategy:**
- Search first, then open the 2-3 most relevant results
- Read each page thoroughly — don't just skim titles
- If first results aren't good enough, search with different terms
- Cross-reference facts across multiple sources
- Always cite where you found information
${hasVision ? `\n## VISION — HYBRID REASONING\nYou can SEE the page via a low-res mini-map screenshot. Use the screenshot for visual layout, spatial relationships, and confirming actions. The accessibility tree is authoritative for element identity; the screenshot is authoritative for visual appearance.${viewportMeta ? ` Viewport: ${viewportMeta.width}x${viewportMeta.height} px.` : ''}\n` : ''}
${knownUserData ? `\n## Known User Data\n${knownUserData}` : ''}
${domainSkills ? `\n${domainSkills}` : ''}
${behaviorKnowledge ? `\n${behaviorKnowledge}` : ''}
${userInstructions ? `\n${userInstructions}` : ''}
${pageContext ? `\n## Current Page State\n${pageContext}` : '\n## Current Page State\nNo page data available.'}
${hasA11yTree ? `\n## Accessibility Tree\n${accessibilityTree}` : ''}
${mempalaceContext ? `\n## MemPalace (long-term memory)\n${mempalaceContext}` : ''}
${recentMemory ? `\n## Recent Context\n${recentMemory}` : ''}`.trim()
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
