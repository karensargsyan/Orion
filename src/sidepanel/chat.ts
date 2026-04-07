import { MSG, PORT_AI_STREAM } from '../shared/constants'
import { renderMarkdown, sanitizeHtml } from './markdown'

// ─── State ────────────────────────────────────────────────────────────────────

let port: chrome.runtime.Port | null = null
let currentSessionId = ''
let currentTabId = 0
let isStreaming = false

let messagesEl: HTMLElement
let inputEl: HTMLTextAreaElement
let sendBtn: HTMLButtonElement
let stopBtn: HTMLButtonElement
let statusBar: HTMLElement
let currentBubble: HTMLElement | null = null
let currentBubbleRaw = ''

// ─── Port management ──────────────────────────────────────────────────────────

function getPort(): chrome.runtime.Port {
  if (port?.name) return port
  port = chrome.runtime.connect({ name: PORT_AI_STREAM })
  port.onMessage.addListener(handlePortMessage)
  port.onDisconnect.addListener(() => { port = null })
  return port
}

function handlePortMessage(msg: { type: string; chunk?: string; fullText?: string; error?: string }): void {
  switch (msg.type) {
    case MSG.STREAM_CHUNK:
      appendChunk(msg.chunk ?? '')
      break
    case MSG.STREAM_END:
      finalizeMessage(msg.fullText ?? '')
      break
    case MSG.STREAM_ERROR:
      showError(msg.error ?? 'Unknown error')
      break
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initChat(container: HTMLElement, tabId: number): void {
  const tabChanged = tabId !== currentTabId
  currentTabId = tabId
  currentSessionId = `session_tab_${tabId}`

  container.innerHTML = `
    <div class="chat-status-bar" id="chat-status-bar">
      <span id="page-context-label" class="context-label">Loading...</span>
      <div class="chat-actions">
        <button id="btn-describe-page" class="btn-small" title="Describe page">Describe</button>
        <button id="btn-fill-form" class="btn-small" title="Fill forms">Fill</button>
      </div>
    </div>
    <div id="quick-actions" class="quick-actions">
      <button class="chip" data-action="summarize">Summarize page</button>
      <button class="chip" data-action="fill">Fill forms</button>
      <button class="chip" data-action="draft">Draft reply</button>
      <button class="chip" data-action="rewrite">Rewrite text</button>
    </div>
    <div class="messages" id="chat-messages">
      <div class="welcome-msg" id="welcome-msg">
        <p>Ask me anything about this page, or request an action.</p>
      </div>
    </div>
    <div class="typing-indicator" id="typing-indicator" style="display:none">
      <span></span><span></span><span></span>
    </div>
    <div class="input-row">
      <textarea id="chat-input" placeholder="Ask anything..." rows="1"></textarea>
      <div class="send-buttons">
        <button id="btn-send" class="btn-primary btn-send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
        <button id="btn-stop" class="btn-danger btn-send" style="display:none">Stop</button>
      </div>
    </div>
  `

  messagesEl = container.querySelector('#chat-messages')!
  inputEl = container.querySelector('#chat-input')!
  sendBtn = container.querySelector('#btn-send')!
  stopBtn = container.querySelector('#btn-stop')!
  statusBar = container.querySelector('#chat-status-bar')!

  sendBtn.addEventListener('click', () => sendMessage())
  stopBtn.addEventListener('click', () => stopStream())

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
  })

  container.querySelector('#btn-fill-form')?.addEventListener('click', () => {
    inputEl.value = 'Please fill the form on this page using my vault data.'
    sendMessage()
  })

  container.querySelector('#btn-describe-page')?.addEventListener('click', () => {
    inputEl.value = 'Describe this page and what I can do here.'
    sendMessage()
  })

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const action = (chip as HTMLElement).dataset.action
      const prompts: Record<string, string> = {
        summarize: 'Summarize this page for me.',
        fill: 'Fill the forms on this page.',
        draft: 'Help me draft a reply to this conversation/email.',
        rewrite: 'Rewrite the selected text to be more professional.',
      }
      inputEl.value = prompts[action!] ?? ''
      sendMessage()
    })
  })

  updatePageContext()
  if (tabChanged) loadTabHistory()
}

async function updatePageContext(): Promise<void> {
  const label = document.getElementById('page-context-label')
  if (!label) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.title) {
      label.textContent = tab.title.slice(0, 60)
      label.title = tab.url ?? ''
    }
  } catch { label.textContent = 'No page loaded' }
}

async function loadTabHistory(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MSG.CHAT_LOAD_SESSION,
      sessionId: currentSessionId,
    }) as { ok: boolean; messages?: Array<{ role: string; content: string }> }

    if (response.ok && response.messages && response.messages.length > 0) {
      const welcome = document.getElementById('welcome-msg')
      if (welcome) welcome.remove()

      for (const msg of response.messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          addBubble(msg.role as 'user' | 'assistant', msg.content)
        }
      }
    }
  } catch { /* no history for this tab */ }
}

// ─── Message rendering ────────────────────────────────────────────────────────

function addBubble(role: 'user' | 'assistant', text: string): HTMLElement {
  const welcome = document.getElementById('welcome-msg')
  if (welcome) welcome.remove()

  const div = document.createElement('div')
  div.className = `message message-${role}`

  if (role === 'assistant') {
    div.innerHTML = sanitizeHtml(renderMarkdown(text))
    addMessageActions(div, text)
  } else {
    div.textContent = text
  }

  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
  return div
}

function addMessageActions(bubble: HTMLElement, text: string): void {
  const actions = document.createElement('div')
  actions.className = 'message-actions'
  actions.innerHTML = `
    <button class="msg-action" data-action="copy" title="Copy">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
    </button>
  `
  actions.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
    navigator.clipboard.writeText(text).catch(() => {})
    const btn = actions.querySelector('[data-action="copy"]') as HTMLElement
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' }, 1500)
  })
  bubble.appendChild(actions)
}

function appendChunk(chunk: string): void {
  if (!currentBubble) {
    currentBubble = addBubble('assistant', '')
    currentBubbleRaw = ''
    showTypingIndicator(false)
  }
  currentBubbleRaw += chunk
  currentBubble.innerHTML = sanitizeHtml(renderMarkdown(currentBubbleRaw))
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function finalizeMessage(fullText: string): void {
  if (currentBubble && fullText) {
    currentBubble.innerHTML = sanitizeHtml(renderMarkdown(fullText))
    addMessageActions(currentBubble, fullText)
  }
  currentBubble = null
  currentBubbleRaw = ''
  setStreaming(false)
}

function showError(error: string): void {
  const div = document.createElement('div')
  div.className = 'message message-error'
  div.textContent = `Error: ${error}`
  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
  setStreaming(false)
}

// ─── Sending ──────────────────────────────────────────────────────────────────

async function sendMessage(): Promise<void> {
  const text = inputEl.value.trim()
  if (!text || isStreaming) return

  inputEl.value = ''
  inputEl.style.height = 'auto'
  addBubble('user', text)
  setStreaming(true)
  showTypingIndicator(true)

  const quickActions = document.getElementById('quick-actions')
  if (quickActions) quickActions.style.display = 'none'

  try {
    getPort().postMessage({
      type: MSG.AI_CHAT,
      text,
      sessionId: currentSessionId,
      tabId: currentTabId,
    })
  } catch (err) {
    showError(`Failed to connect to AI: ${err}`)
  }
}

function stopStream(): void {
  getPort().postMessage({ type: MSG.AI_ABORT, tabId: currentTabId })
  finalizeMessage('')
}

function setStreaming(streaming: boolean): void {
  isStreaming = streaming
  inputEl.disabled = streaming
  sendBtn.style.display = streaming ? 'none' : ''
  stopBtn.style.display = streaming ? '' : 'none'
  if (!streaming) {
    inputEl.focus()
    showTypingIndicator(false)
  }
}

function showTypingIndicator(show: boolean): void {
  const el = document.getElementById('typing-indicator')
  if (el) el.style.display = show ? 'flex' : 'none'
}

// ─── Session management ───────────────────────────────────────────────────────

export function newSession(): void {
  currentSessionId = `session_${Date.now()}`
  if (messagesEl) messagesEl.innerHTML = ''
}

export function getCurrentSessionId(): string {
  return currentSessionId
}

export async function loadSession(sessionId: string): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: MSG.CHAT_LOAD_SESSION, sessionId }) as {
    ok: boolean
    messages?: Array<{ role: string; content: string }>
  }
  if (!response.ok || !response.messages) return

  currentSessionId = sessionId
  if (messagesEl) messagesEl.innerHTML = ''
  for (const msg of response.messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      addBubble(msg.role, msg.content)
    }
  }
}
