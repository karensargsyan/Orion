import { MSG, PORT_AI_STREAM } from '../shared/constants'
import { renderMarkdown, sanitizeHtml } from './markdown'
import { parseWidgets, parseActionResults, renderWidgetsInContainer, attachWidgetHandlers, createActionConfirmElement } from './chat-widgets'
import { sanitizeModelOutput, stripMalformedActions } from '../shared/sanitize-output'
import type { Widget } from './chat-widgets'

// ─── Per-tab chat state ────────────────────────────────────────────────────────

interface TabChatState {
  sessionId: string
  domain: string
  tabId: number
  port: chrome.runtime.Port | null
  isStreaming: boolean
  pendingAbort: AbortController | null
  currentBubble: HTMLElement | null
  currentBubbleRaw: string
  streamBuffer: string
  container: HTMLElement
  historyLoaded: boolean
}

const tabStates = new Map<number, TabChatState>()
let activeTabId = 0

function getTabState(tabId: number): TabChatState | undefined {
  return tabStates.get(tabId)
}

function getActiveState(): TabChatState | undefined {
  return tabStates.get(activeTabId)
}

// ─── Port management (per-tab) ────────────────────────────────────────────────

function getPort(state: TabChatState): chrome.runtime.Port {
  if (state.port?.name) return state.port
  const p = chrome.runtime.connect({ name: PORT_AI_STREAM })
  state.port = p
  const tabId = state.tabId
  p.onMessage.addListener((msg: { type: string; chunk?: string; fullText?: string; error?: string }) => {
    const s = getTabState(tabId)
    if (!s) return
    handlePortMessage(s, msg)
  })
  p.onDisconnect.addListener(() => {
    const s = getTabState(tabId)
    if (s) s.port = null
  })
  return p
}

function handlePortMessage(state: TabChatState, msg: { type: string; chunk?: string; fullText?: string; error?: string; id?: string; description?: string; risk?: string; actions?: string[] }): void {
  switch (msg.type) {
    case MSG.STREAM_CHUNK:
      appendChunk(state, msg.chunk ?? '')
      break
    case MSG.STREAM_END:
      finalizeMessage(state, msg.fullText ?? '')
      break
    case MSG.STREAM_ERROR:
      showError(state, msg.error ?? 'Unknown error')
      break
    case MSG.CONFIRM_ACTION:
      showConfirmationCard(state, msg.id!, msg.description!, msg.risk!, msg.actions ?? [])
      break
  }
}

// ─── Session resolution ────────────────────────────────────────────────────────

async function resolveSession(tabId: number): Promise<{ sessionId: string; domain: string; url: string }> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.RESOLVE_SESSION,
      tabId,
    }) as { ok: boolean; sessionId?: string; domain?: string; url?: string }
    if (res.ok && res.sessionId) {
      return { sessionId: res.sessionId, domain: res.domain ?? '', url: res.url ?? '' }
    }
  } catch { /* fallback */ }
  return { sessionId: `session_tab_${tabId}`, domain: '', url: '' }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initChat(parentContainer: HTMLElement, tabId: number): Promise<void> {
  activeTabId = tabId

  const existing = tabStates.get(tabId)
  if (existing) {
    parentContainer.innerHTML = ''
    parentContainer.appendChild(existing.container)
    updatePageContext(existing)
    wireEvents(existing)
    return
  }

  const { sessionId, domain } = await resolveSession(tabId)

  const wrapper = document.createElement('div')
  wrapper.className = 'chat-wrapper'
  wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;'
  wrapper.innerHTML = `
    <div class="chat-status-bar" id="chat-status-bar-${tabId}">
      <span id="page-context-label-${tabId}" class="context-label">Loading...</span>
      <div class="chat-actions">
        <button class="btn-small btn-describe" title="Describe page">Describe</button>
        <button class="btn-small btn-fill" title="Fill forms">Fill</button>
        <button class="btn-small btn-forget" title="Forget this page's memory">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    </div>
    <div class="quick-actions quick-actions-tab">
      <button class="chip" data-action="summarize">Summarize page</button>
      <button class="chip" data-action="fill">Fill forms</button>
      <button class="chip" data-action="draft">Draft reply</button>
      <button class="chip" data-action="rewrite">Rewrite text</button>
    </div>
    <div class="messages chat-messages-tab">
      <div class="analyzing-state analyzing-state-tab">
        <div class="analyzing-spinner"></div>
        <p>Analyzing page capabilities...</p>
      </div>
    </div>
    <div class="typing-indicator typing-indicator-tab" style="display:none">
      <span></span><span></span><span></span>
    </div>
    <div class="input-row">
      <textarea class="chat-input-tab" placeholder="Ask anything..." rows="1"></textarea>
      <div class="send-buttons">
        <button class="btn-primary btn-send btn-send-tab">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
        <button class="btn-danger btn-send btn-stop-tab" style="display:none">Stop</button>
      </div>
    </div>
  `

  const state: TabChatState = {
    sessionId,
    domain,
    tabId,
    port: null,
    isStreaming: false,
    pendingAbort: null,
    currentBubble: null,
    currentBubbleRaw: '',
    streamBuffer: '',
    container: wrapper,
    historyLoaded: false,
  }
  tabStates.set(tabId, state)

  parentContainer.innerHTML = ''
  parentContainer.appendChild(wrapper)

  wireEvents(state)
  updatePageContext(state)
  loadTabHistory(state).then(() => {
    if (!hasExistingMessages(state)) {
      triggerPageAnalysis(state)
    }
  })
}

// ─── Wire DOM events ──────────────────────────────────────────────────────────

function wireEvents(state: TabChatState): void {
  const c = state.container
  const inputEl = c.querySelector<HTMLTextAreaElement>('.chat-input-tab')!
  const sendBtn = c.querySelector<HTMLButtonElement>('.btn-send-tab')!
  const stopBtn = c.querySelector<HTMLButtonElement>('.btn-stop-tab')!

  const newSend = sendBtn.cloneNode(true) as HTMLButtonElement
  sendBtn.parentNode!.replaceChild(newSend, sendBtn)
  const newStop = stopBtn.cloneNode(true) as HTMLButtonElement
  newStop.style.display = state.isStreaming ? '' : 'none'
  newSend.style.display = state.isStreaming ? 'none' : ''
  stopBtn.parentNode!.replaceChild(newStop, stopBtn)

  const newInput = inputEl.cloneNode(true) as HTMLTextAreaElement
  inputEl.parentNode!.replaceChild(newInput, inputEl)

  newSend.addEventListener('click', () => sendMessage(state))
  newStop.addEventListener('click', () => stopStream(state))

  newInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(state)
      return
    }
    if (e.key === 'ArrowUp' && newInput.value === '' && !state.isStreaming) {
      e.preventDefault()
      editLastUserMessage(state)
    }
  })

  newInput.addEventListener('input', () => {
    newInput.style.height = 'auto'
    newInput.style.height = Math.min(newInput.scrollHeight, 120) + 'px'
  })

  const describeBtn = c.querySelector('.btn-describe')
  if (describeBtn) {
    const nd = describeBtn.cloneNode(true) as HTMLElement
    describeBtn.parentNode!.replaceChild(nd, describeBtn)
    nd.addEventListener('click', () => {
      getInput(state).value = 'Describe this page and what I can do here.'
      sendMessage(state)
    })
  }

  const fillBtn = c.querySelector('.btn-fill')
  if (fillBtn) {
    const nf = fillBtn.cloneNode(true) as HTMLElement
    fillBtn.parentNode!.replaceChild(nf, fillBtn)
    nf.addEventListener('click', () => {
      getInput(state).value = 'Please fill the form on this page using my vault data.'
      sendMessage(state)
    })
  }

  const forgetBtn = c.querySelector('.btn-forget')
  if (forgetBtn) {
    const nfg = forgetBtn.cloneNode(true) as HTMLElement
    forgetBtn.parentNode!.replaceChild(nfg, forgetBtn)
    nfg.addEventListener('click', async () => {
      if (!confirm('Clear chat and memory for this page/domain?')) return
      await chrome.runtime.sendMessage({ type: MSG.CLEAR_SESSION, sessionId: state.sessionId })
      getMessages(state).innerHTML = '<div class="welcome-msg welcome-msg-tab"><p>Memory cleared. Ask me anything.</p></div>'
      const qa = state.container.querySelector<HTMLElement>('.quick-actions-tab')
      if (qa) qa.style.display = ''
    })
  }

  c.querySelectorAll('.chip').forEach(chip => {
    const nc = chip.cloneNode(true) as HTMLElement
    chip.parentNode!.replaceChild(nc, chip)
    nc.addEventListener('click', () => {
      const action = nc.dataset.action
      const prompts: Record<string, string> = {
        summarize: 'Summarize this page for me.',
        fill: 'Fill the forms on this page.',
        draft: 'Help me draft a reply to this conversation/email.',
        rewrite: 'Rewrite the selected text to be more professional.',
      }
      getInput(state).value = prompts[action!] ?? ''
      sendMessage(state)
    })
  })
}

// ─── DOM accessors ────────────────────────────────────────────────────────────

function getMessages(state: TabChatState): HTMLElement {
  return state.container.querySelector('.chat-messages-tab')!
}

function getInput(state: TabChatState): HTMLTextAreaElement {
  return state.container.querySelector('.chat-input-tab')!
}

function getTypingIndicator(state: TabChatState): HTMLElement {
  return state.container.querySelector('.typing-indicator-tab')!
}

// ─── Page context ─────────────────────────────────────────────────────────────

async function updatePageContext(state: TabChatState): Promise<void> {
  const label = state.container.querySelector(`#page-context-label-${state.tabId}`) as HTMLElement | null
  if (!label) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.title) {
      const domainLabel = state.domain ? ` (${state.domain})` : ''
      label.textContent = tab.title.slice(0, 50) + domainLabel
      label.title = tab.url ?? ''
    }
  } catch { label.textContent = 'No page loaded' }
}

async function loadTabHistory(state: TabChatState): Promise<void> {
  if (state.historyLoaded) return
  state.historyLoaded = true
  try {
    const response = await chrome.runtime.sendMessage({
      type: MSG.CHAT_LOAD_SESSION,
      sessionId: state.sessionId,
    }) as { ok: boolean; messages?: Array<{ role: string; content: string }> }

    if (response.ok && response.messages && response.messages.length > 0) {
      const messagesEl = getMessages(state)
      const analyzing = messagesEl.querySelector('.analyzing-state-tab')
      if (analyzing) analyzing.remove()

      const qa = state.container.querySelector<HTMLElement>('.quick-actions-tab')
      if (qa) qa.style.display = 'none'

      for (const msg of response.messages) {
        if (msg.role === 'system' && msg.content.startsWith('[Context Summary]')) {
          addCompactSummaryBubble(state, msg.content.replace('[Context Summary] ', ''))
        } else if (msg.role === 'user' || msg.role === 'assistant') {
          addBubble(state, msg.role as 'user' | 'assistant', msg.content)
        }
      }
    }
  } catch { /* no history */ }
}

function hasExistingMessages(state: TabChatState): boolean {
  const messagesEl = getMessages(state)
  return messagesEl.querySelectorAll('.message-user, .message-assistant').length > 0
}

function triggerPageAnalysis(state: TabChatState): void {
  const qa = state.container.querySelector<HTMLElement>('.quick-actions-tab')
  if (qa) qa.style.display = 'none'

  getPort(state).postMessage({
    type: MSG.ANALYZE_PAGE,
    tabId: state.tabId,
    sessionId: state.sessionId,
  })
}

// ─── Edit last message ────────────────────────────────────────────────────────

function editLastUserMessage(state: TabChatState): void {
  const messagesEl = getMessages(state)
  const userBubbles = messagesEl.querySelectorAll<HTMLElement>('.message-user')
  const lastBubble = userBubbles[userBubbles.length - 1]
  if (!lastBubble) return

  const lastText = lastBubble.textContent ?? ''
  const inputEl = getInput(state)
  inputEl.value = lastText
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
  inputEl.focus()
  inputEl.setSelectionRange(lastText.length, lastText.length)

  lastBubble.classList.add('message-editing')
  const nextSibling = lastBubble.nextElementSibling
  if (nextSibling?.classList.contains('message-assistant')) nextSibling.remove()
  lastBubble.remove()
}

// ─── Streaming buffer ─────────────────────────────────────────────────────────

const ACTION_OPEN_RE = /\[(?:ACTION|ACTIONRESULT|ACTION_RESULT)/
const MALFORMED_STREAM_RE = /call:[\w]*:?[\w]*\{[^}]*\}/gi
const ABILITY_STREAM_RE = /ability:\s*\[?\s*(?:ACTION_?RESULT|ACTIONRESULT)\s*\]?/gi
const JSON_ACTION_RE = /\{[^{}]*"action"\s*:\s*"(?:click|type|scroll_down|scroll_up|wait)"[^{}]*\}/g

function bufferAndFlush(state: TabChatState, chunk: string): string {
  state.streamBuffer += chunk

  state.streamBuffer = state.streamBuffer
    .replace(MALFORMED_STREAM_RE, '')
    .replace(ABILITY_STREAM_RE, '')
    .replace(JSON_ACTION_RE, '')

  const bracketIdx = state.streamBuffer.lastIndexOf('[')
  if (bracketIdx === -1) {
    const flushed = state.streamBuffer
    state.streamBuffer = ''
    return flushed
  }

  const afterBracket = state.streamBuffer.slice(bracketIdx)

  if (ACTION_OPEN_RE.test(afterBracket)) {
    if (afterBracket.includes(']')) {
      const clean = state.streamBuffer
        .replace(/\[ACTION:\w+[^\]]*\]/g, '')
        .replace(/\[ACTION_RESULT[^\]]*\][^[]*\[\/ACTION_RESULT\]/g, '')
        .replace(/\[ACTIONRESULT[^\]]*\][^[]*\[\/ACTIONRESULT\]/g, '')
      state.streamBuffer = ''
      return clean
    }
    const safe = state.streamBuffer.slice(0, bracketIdx)
    state.streamBuffer = afterBracket
    return safe
  }

  const maxPrefixLen = '[ACTION_RESULT'.length
  if (afterBracket.length < maxPrefixLen && /^\[A?C?T?I?O?N?_?R?E?S?/.test(afterBracket)) {
    const safe = state.streamBuffer.slice(0, bracketIdx)
    state.streamBuffer = afterBracket
    return safe
  }

  const flushed = state.streamBuffer
  state.streamBuffer = ''
  return flushed
}

function flushRemaining(state: TabChatState): string {
  const remaining = state.streamBuffer
    .replace(/\[ACTION:\w+[^\]]*\]/g, '')
    .replace(/\[ACTION_RESULT[^\]]*\][^[]*\[\/ACTION_RESULT\]/g, '')
    .replace(/\[ACTIONRESULT[^\]]*\][^[]*\[\/ACTIONRESULT\]/g, '')
  state.streamBuffer = ''
  return remaining
}

// ─── Message rendering ────────────────────────────────────────────────────────

function renderAssistantHTML(text: string): { html: string; widgets: Widget[] } {
  let cleaned = text
    .replace(/\[ACTION:\w+[^\]]*\]/g, '')
    .replace(/\{[^{}]*"action"\s*:\s*"(?:click|type|scroll_down|scroll_up|wait)"[^{}]*\}/g, '')
  cleaned = sanitizeModelOutput(cleaned)
  let html = sanitizeHtml(renderMarkdown(cleaned))
  html = parseActionResults(html)
  const { html: widgetHtml, widgets } = parseWidgets(html)
  return { html: widgetHtml, widgets }
}

function addBubble(state: TabChatState, role: 'user' | 'assistant', text: string): HTMLElement {
  const messagesEl = getMessages(state)
  const welcome = messagesEl.querySelector('.welcome-msg-tab')
  if (welcome) welcome.remove()
  const analyzing = messagesEl.querySelector('.analyzing-state-tab')
  if (analyzing) analyzing.remove()

  const div = document.createElement('div')
  div.className = `message message-${role}`

  if (role === 'assistant') {
    const { html, widgets } = renderAssistantHTML(text)
    div.innerHTML = html
    renderWidgetsInContainer(div, widgets)
    attachWidgetHandlers(div, (_wid, val) => handleWidgetChoice(state, val))
    addMessageActions(state, div, text)
  } else {
    div.textContent = text
  }

  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
  return div
}

function addCompactSummaryBubble(state: TabChatState, summary: string): void {
  const messagesEl = getMessages(state)
  const div = document.createElement('div')
  div.className = 'message message-compact-summary'
  div.innerHTML = `<span class="compact-icon">📋</span> <em>Previous context:</em> ${sanitizeHtml(summary)}`
  messagesEl.appendChild(div)
}

function showConfirmationCard(
  state: TabChatState,
  id: string,
  description: string,
  risk: string,
  actions: string[]
): void {
  const messagesEl = getMessages(state)
  const cardEl = createActionConfirmElement(id, description, risk, actions)
  messagesEl.appendChild(cardEl)
  messagesEl.scrollTop = messagesEl.scrollHeight

  attachWidgetHandlers(
    cardEl,
    (_wid, val) => handleWidgetChoice(state, val),
    (confirmId, preference) => handleConfirmationResponse(state, confirmId, preference, actions)
  )
}

function handleConfirmationResponse(
  state: TabChatState,
  confirmId: string,
  preference: string,
  actions: string[]
): void {
  getPort(state).postMessage({
    type: MSG.CONFIRM_RESPONSE,
    id: confirmId,
    preference,
    actionTypes: actions,
    tabId: state.tabId,
  })
}

function addMessageActions(state: TabChatState, bubble: HTMLElement, text: string): void {
  const actions = document.createElement('div')
  actions.className = 'message-actions'
  actions.innerHTML = `
    <button class="msg-action" data-action="copy" title="Copy">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
    </button>
    <button class="msg-action" data-action="retry" title="Retry">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
    </button>
  `
  actions.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
    navigator.clipboard.writeText(text).catch(() => {})
    const btn = actions.querySelector('[data-action="copy"]') as HTMLElement
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' }, 1500)
  })
  actions.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
    const messagesEl = getMessages(state)
    const lastUserMsg = [...messagesEl.querySelectorAll('.message-user')].pop()
    if (lastUserMsg?.textContent) {
      getInput(state).value = lastUserMsg.textContent
      sendMessage(state)
    }
  })
  bubble.appendChild(actions)
}

function appendChunk(state: TabChatState, chunk: string): void {
  const messagesEl = getMessages(state)
  if (!state.currentBubble) {
    state.currentBubble = document.createElement('div')
    state.currentBubble.className = 'message message-assistant'
    messagesEl.appendChild(state.currentBubble)
    state.currentBubbleRaw = ''
    state.streamBuffer = ''
    showTypingIndicator(state, false)
    const analyzing = messagesEl.querySelector('.analyzing-state-tab')
    if (analyzing) analyzing.remove()
    const welcome = messagesEl.querySelector('.welcome-msg-tab')
    if (welcome) welcome.remove()
  }

  const safeChunk = bufferAndFlush(state, chunk)
  if (!safeChunk) return

  state.currentBubbleRaw += safeChunk
  const { html, widgets } = renderAssistantHTML(state.currentBubbleRaw)
  state.currentBubble.innerHTML = html
  renderWidgetsInContainer(state.currentBubble, widgets)
  attachWidgetHandlers(state.currentBubble, (_wid, val) => handleWidgetChoice(state, val))
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function finalizeMessage(state: TabChatState, fullText: string): void {
  const remaining = flushRemaining(state)
  if (remaining && state.currentBubble) {
    state.currentBubbleRaw += remaining
  }

  if (state.currentBubble && fullText) {
    const { html, widgets } = renderAssistantHTML(fullText)
    state.currentBubble.innerHTML = html
    renderWidgetsInContainer(state.currentBubble, widgets)
    attachWidgetHandlers(state.currentBubble, (_wid, val) => handleWidgetChoice(state, val))
    addMessageActions(state, state.currentBubble, fullText)
  }
  state.currentBubble = null
  state.currentBubbleRaw = ''
  state.streamBuffer = ''
  state.pendingAbort = null
  setStreaming(state, false)
}

function handleWidgetChoice(state: TabChatState, value: string): void {
  getInput(state).value = `I choose: ${value}`
  sendMessage(state)
}

function showError(state: TabChatState, error: string): void {
  const messagesEl = getMessages(state)
  const div = document.createElement('div')
  div.className = 'message message-error'
  div.textContent = `Error: ${error}`
  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
  setStreaming(state, false)
}

// ─── Sending ──────────────────────────────────────────────────────────────────

async function sendMessage(state: TabChatState): Promise<void> {
  const inputEl = getInput(state)
  const text = inputEl.value.trim()
  if (!text || state.isStreaming) return

  if (state.pendingAbort) {
    state.pendingAbort.abort()
    state.pendingAbort = null
  }

  inputEl.value = ''
  inputEl.style.height = 'auto'
  addBubble(state, 'user', text)
  setStreaming(state, true)
  showTypingIndicator(state, true)

  const qa = state.container.querySelector<HTMLElement>('.quick-actions-tab')
  if (qa) qa.style.display = 'none'

  state.pendingAbort = new AbortController()

  try {
    getPort(state).postMessage({
      type: MSG.AI_CHAT,
      text,
      sessionId: state.sessionId,
      tabId: state.tabId,
    })
  } catch (err) {
    showError(state, `Failed to connect to AI: ${err}`)
  }
}

function stopStream(state: TabChatState): void {
  getPort(state).postMessage({ type: MSG.AI_ABORT, tabId: state.tabId })
  state.pendingAbort?.abort()
  state.pendingAbort = null
  finalizeMessage(state, '')
}

function setStreaming(state: TabChatState, streaming: boolean): void {
  state.isStreaming = streaming
  const inputEl = getInput(state)
  const sendBtn = state.container.querySelector<HTMLButtonElement>('.btn-send-tab')
  const stopBtn = state.container.querySelector<HTMLButtonElement>('.btn-stop-tab')
  inputEl.disabled = streaming
  if (sendBtn) sendBtn.style.display = streaming ? 'none' : ''
  if (stopBtn) stopBtn.style.display = streaming ? '' : 'none'
  if (!streaming) {
    inputEl.focus()
    showTypingIndicator(state, false)
  }
}

function showTypingIndicator(state: TabChatState, show: boolean): void {
  const el = getTypingIndicator(state)
  if (el) el.style.display = show ? 'flex' : 'none'
}

// ─── Session management ───────────────────────────────────────────────────────

export function newSession(): void {
  const state = getActiveState()
  if (!state) return
  state.sessionId = `session_${Date.now()}`
  state.historyLoaded = false
  getMessages(state).innerHTML = ''
}

export function getCurrentSessionId(): string {
  return getActiveState()?.sessionId ?? ''
}

export async function loadSession(sessionId: string): Promise<void> {
  const state = getActiveState()
  if (!state) return

  const response = await chrome.runtime.sendMessage({ type: MSG.CHAT_LOAD_SESSION, sessionId }) as {
    ok: boolean
    messages?: Array<{ role: string; content: string }>
  }
  if (!response.ok || !response.messages) return

  state.sessionId = sessionId
  state.historyLoaded = true
  const messagesEl = getMessages(state)
  messagesEl.innerHTML = ''
  for (const msg of response.messages) {
    if (msg.role === 'system' && msg.content.startsWith('[Context Summary]')) {
      addCompactSummaryBubble(state, msg.content.replace('[Context Summary] ', ''))
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      addBubble(state, msg.role, msg.content)
    }
  }
}

export function cleanupClosedTab(tabId: number): void {
  const state = tabStates.get(tabId)
  if (state?.port) {
    try { state.port.disconnect() } catch { /* already disconnected */ }
  }
  tabStates.delete(tabId)
}
