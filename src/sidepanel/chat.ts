import { MSG, PORT_AI_STREAM } from '../shared/constants'
import { renderMarkdown, sanitizeHtml } from './markdown'
import { parseWidgets, parseActionResults, renderWidgetsInContainer, attachWidgetHandlers, createActionConfirmElement, createModeChoiceElement, createFormAssistElement, attachFormAssistHandlers } from './chat-widgets'
import { sanitizeModelOutput, stripMalformedActions } from '../shared/sanitize-output'
import type { Widget } from './chat-widgets'
import * as speech from './speech-service'

// ─── Per-session chat state (keyed by sessionId, shared across tabs in same group) ──

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
  pendingImageData: string | null
  pendingFileContext: string | null
  pendingFileName: string | null
  /** Callback to stop mic recording, set by initMic */
  _stopMic?: (() => void) | null
  /** Callback to clear file attachment, set by initAttachButton */
  _clearAttachment?: (() => void) | null
}

const sessionStates = new Map<string, TabChatState>()
const tabToSession = new Map<number, string>()
let activeTabId = 0
let activeSessionId = ''

function getTabState(tabId: number): TabChatState | undefined {
  const sid = tabToSession.get(tabId)
  return sid ? sessionStates.get(sid) : undefined
}

function getActiveState(): TabChatState | undefined {
  return sessionStates.get(activeSessionId)
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
    if (!s) return
    s.port = null
    // If streaming was active when port disconnected, clean up UI
    if (s.isStreaming) {
      finalizeMessage(s, s.currentBubbleRaw || '')
    }
  })
  return p
}

function handlePortMessage(state: TabChatState, msg: { type: string; chunk?: string; fullText?: string; error?: string; id?: string; description?: string; risk?: string; actions?: string[]; mode?: string; remember?: boolean; formTitle?: string; fields?: unknown[]; autoFilledCount?: number }): void {
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
    case MSG.MODE_CHOICE:
      showModeChoiceCard(state, msg.id!, msg.description!)
      break
    case MSG.FORM_ASSIST:
      showFormAssistCard(state, msg.id!, msg.formTitle as string ?? 'Form', msg.fields as import('../shared/types').FormAssistField[] ?? [])
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
  const { sessionId, domain } = await resolveSession(tabId)
  activeSessionId = sessionId
  tabToSession.set(tabId, sessionId)

  const existing = sessionStates.get(sessionId)
  if (existing) {
    existing.tabId = tabId // point at current tab in the group
    parentContainer.innerHTML = ''
    parentContainer.appendChild(existing.container)
    updatePageContext(existing)
    updateModelBadge(existing)
    wireEvents(existing)
    return
  }

  const wrapper = document.createElement('div')
  wrapper.className = 'chat-wrapper'
  wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;'
  wrapper.innerHTML = `
    <div class="chat-status-bar" id="chat-status-bar-${tabId}">
      <span id="ai-health-dot-${tabId}" class="ai-health-dot" title="Checking AI connection..."></span>
      <span id="page-context-label-${tabId}" class="context-label">Loading...</span>
      <span id="model-badge-${tabId}" class="model-badge"></span>
      <div class="chat-actions">
        <button class="btn-small btn-describe" title="Describe page">Describe</button>
        <button class="btn-small btn-fill" title="Fill forms">Fill</button>
        <button class="btn-small btn-forget" title="Forget this page's memory">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    </div>
    <div class="group-paused-banner" style="display:none">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
      <span>Group paused</span>
      <button class="btn-small btn-primary btn-resume-chat">Resume</button>
    </div>
    <div class="quick-actions quick-actions-tab"></div>
    <div class="proactive-bar proactive-bar-tab" style="display:none" aria-label="Page insights"></div>
    <div class="messages chat-messages-tab" role="log" aria-live="polite" aria-label="Chat messages">
    </div>
    <div class="typing-indicator typing-indicator-tab" style="display:none">
      <span></span><span></span><span></span>
    </div>
    <div class="attachment-preview-tab" style="display:none">
      <img class="attachment-thumb">
      <span class="attachment-name"></span>
      <button class="attachment-remove" title="Remove">&times;</button>
    </div>
    <div class="input-row">
      <button class="btn-icon btn-mic-tab" title="Hold to speak, double-click to lock">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
      </button>
      <button class="btn-icon btn-attach-tab" title="Attach image">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
      </button>
      <input type="file" class="file-input-tab" accept="image/*,.pdf,.txt,.csv" style="display:none">
      <button class="btn-mode-toggle btn-mode-tab" title="Switch mode">
        <span class="mode-label">Auto</span>
      </button>
      <textarea class="chat-input-tab" placeholder="Ask anything..." rows="1" aria-label="Chat message input"></textarea>
      <div class="send-buttons">
        <button class="btn-primary btn-send btn-send-tab" aria-label="Send message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
        <button class="btn-danger btn-send btn-stop-tab" style="display:none" aria-label="Stop AI response">Stop</button>
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
    pendingImageData: null,
    pendingFileContext: null,
    pendingFileName: null,
  }
  sessionStates.set(sessionId, state)

  parentContainer.innerHTML = ''
  parentContainer.appendChild(wrapper)

  wireEvents(state)
  updatePageContext(state)
  updateModelBadge(state)
  loadTabHistory(state)
  startHealthCheckLoop(state)
  showProactiveInsights(state)
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

  // ── Resume from pause banner ──
  const resumeBtn = c.querySelector<HTMLButtonElement>('.btn-resume-chat')
  if (resumeBtn) {
    const newResume = resumeBtn.cloneNode(true) as HTMLButtonElement
    resumeBtn.parentNode!.replaceChild(newResume, resumeBtn)
    newResume.addEventListener('click', async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: MSG.GET_ACTIVE_GROUPS })
        if (!resp?.ok) return
        const groups = resp.groups as Array<{ groupId: number; tabIds: number[] }> ?? []
        const myGroup = groups.find(g => g.tabIds.includes(state.tabId))
        if (myGroup) {
          await chrome.runtime.sendMessage({ type: MSG.RESUME_GROUP, groupId: myGroup.groupId })
        }
      } catch { /* ignore */ }
    })
  }

  // ── Mode toggle (Auto ↔ Guided) ──
  const modeBtn = c.querySelector<HTMLButtonElement>('.btn-mode-tab')
  if (modeBtn) {
    // Load initial state
    loadModeToggle(modeBtn)
    const newMode = modeBtn.cloneNode(true) as HTMLButtonElement
    modeBtn.parentNode!.replaceChild(newMode, modeBtn)
    loadModeToggle(newMode)
    newMode.addEventListener('click', () => toggleMode(newMode))
  }

  newInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(state)
      return
    }
    if (e.key === 'Escape' && state.isStreaming) {
      e.preventDefault()
      stopStream(state)
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

  // Populate contextual quick actions
  populateQuickActions(state)

  // ── Microphone: press-and-hold OR double-click to toggle ──────────────────
  const micBtn = c.querySelector<HTMLButtonElement>('.btn-mic-tab')
  if (micBtn) {
    const nm = micBtn.cloneNode(true) as HTMLButtonElement
    micBtn.parentNode!.replaceChild(nm, micBtn)

    // Save original mic SVG for restoring later
    const micSvg = nm.innerHTML
    const wavesHtml = '<span class="mic-waves"><span></span><span></span><span></span><span></span></span>'

    let lockedRecording = false   // true = permanent recording mode (double-click)
    let holdActive = false        // true = press-and-hold active
    let holdTimer: ReturnType<typeof setTimeout> | null = null
    const HOLD_DELAY = 200        // ms to wait before starting hold (to allow dblclick)

    speech.onTranscript((text, isFinal) => {
      const input = getInput(state)
      if (isFinal) {
        input.value = (input.value ? input.value + ' ' : '') + text
        input.style.height = 'auto'
        input.style.height = Math.min(input.scrollHeight, 120) + 'px'
      }
    })

    // Surface speech errors as dismissible toast above input
    speech.onError((error) => {
      nm.classList.remove('recording')
      lockedRecording = false
      holdActive = false
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      nm.innerHTML = micSvg
      nm.title = 'Hold to speak, double-click to lock'
      showChatToast(state, error, 'error')
    })

    const startMic = () => {
      nm.classList.add('recording')
      speech.startListening().catch((err) => {
        nm.classList.remove('recording')
        lockedRecording = false
        nm.innerHTML = micSvg
        nm.title = 'Hold to speak, double-click to lock'
        showChatToast(state, err.message || 'Failed to start microphone', 'error')
      })
    }

    const stopMic = () => {
      nm.classList.remove('recording')
      speech.stopListening()
      lockedRecording = false
      nm.innerHTML = micSvg
      nm.title = 'Hold to speak, double-click to lock'
    }

    // Expose stopMic so sendMessage can auto-stop recording
    ;state._stopMic = stopMic

    const enterLockedMode = () => {
      // Cancel any pending hold
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      // If already in hold recording, it's fine — just switch to locked
      lockedRecording = true
      holdActive = false
      nm.innerHTML = wavesHtml
      nm.title = 'Click to stop recording'
      // Start mic if not already recording
      if (!nm.classList.contains('recording')) {
        startMic()
      }
    }

    // Double-click: toggle permanent recording
    nm.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (lockedRecording) {
        stopMic()
      } else {
        enterLockedMode()
      }
    })

    // Single click: if locked, stop recording
    nm.addEventListener('click', () => {
      if (lockedRecording) {
        stopMic()
      }
    })

    // Press-and-hold (mousedown/mouseup) — delayed to allow double-click
    nm.addEventListener('mousedown', () => {
      if (lockedRecording) return
      // Delay start so double-click can cancel it
      holdTimer = setTimeout(() => {
        holdTimer = null
        holdActive = true
        startMic()
      }, HOLD_DELAY)
    })
    nm.addEventListener('mouseup', () => {
      // Cancel pending hold start if released quickly (single click or dblclick first click)
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      if (lockedRecording || !holdActive) return
      holdActive = false
      stopMic()
    })
    nm.addEventListener('mouseleave', () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      if (lockedRecording || !holdActive) return
      holdActive = false
      stopMic()
    })

    // Touch: double-tap for locked, hold for temporary
    let lastTapTime = 0
    nm.addEventListener('touchstart', (e) => {
      e.preventDefault()
      const now = Date.now()
      if (now - lastTapTime < 350) {
        // Double-tap
        lastTapTime = 0
        if (lockedRecording) {
          stopMic()
        } else {
          enterLockedMode()
        }
        return
      }
      lastTapTime = now

      if (lockedRecording) return
      holdTimer = setTimeout(() => {
        holdTimer = null
        holdActive = true
        startMic()
      }, HOLD_DELAY)
    })
    nm.addEventListener('touchend', () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      if (lockedRecording || !holdActive) return
      holdActive = false
      stopMic()
    })
  }

  // ── File/image upload ──────────────────────────────────────────────────────
  const attachBtn = c.querySelector<HTMLButtonElement>('.btn-attach-tab')
  const fileInput = c.querySelector<HTMLInputElement>('.file-input-tab')
  const previewBar = c.querySelector<HTMLElement>('.attachment-preview-tab')
  const previewThumb = c.querySelector<HTMLImageElement>('.attachment-thumb')
  const previewName = c.querySelector<HTMLElement>('.attachment-name')
  const previewRemove = c.querySelector<HTMLButtonElement>('.attachment-remove')
  const inputRow = c.querySelector<HTMLElement>('.input-row')

  function attachFile(file: File): void {
    if (file.size > 10 * 1024 * 1024) { alert('File too large (max 10MB)'); return }
    const isImage = file.type.startsWith('image/')
    const isText = file.type.startsWith('text/') || /\.(txt|csv|md|json|xml|html|log|tsv)$/i.test(file.name)

    if (isText) {
      // Read as text for inline context
      const reader = new FileReader()
      reader.onload = () => {
        state.pendingFileContext = (reader.result as string).slice(0, 50_000)
        state.pendingFileName = file.name
        state.pendingImageData = null
        if (previewThumb) { previewThumb.src = ''; previewThumb.style.display = 'none' }
        if (previewName) previewName.textContent = `\u{1F4C4} ${file.name} (${formatFileSize(file.size)})`
        if (previewBar) previewBar.style.display = 'flex'
      }
      reader.readAsText(file)
    } else {
      // Images and other files → data URL
      const reader = new FileReader()
      reader.onload = () => {
        state.pendingImageData = reader.result as string
        state.pendingFileContext = null
        state.pendingFileName = file.name
        if (previewThumb) {
          previewThumb.src = isImage ? reader.result as string : ''
          previewThumb.style.display = isImage ? '' : 'none'
        }
        if (previewName) previewName.textContent = `${isImage ? '\u{1F5BC}' : '\u{1F4CE}'} ${file.name} (${formatFileSize(file.size)})`
        if (previewBar) previewBar.style.display = 'flex'
      }
      reader.readAsDataURL(file)
    }
  }

  function clearAttachment(): void {
    state.pendingImageData = null
    state.pendingFileContext = null
    state.pendingFileName = null
    if (previewBar) previewBar.style.display = 'none'
    if (previewThumb) previewThumb.src = ''
    if (previewName) previewName.textContent = ''
  }

  if (attachBtn && fileInput) {
    const na = attachBtn.cloneNode(true) as HTMLButtonElement
    attachBtn.parentNode!.replaceChild(na, attachBtn)
    na.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) attachFile(file)
      fileInput.value = ''
    })
  }

  if (previewRemove) {
    const nr = previewRemove.cloneNode(true) as HTMLButtonElement
    previewRemove.parentNode!.replaceChild(nr, previewRemove)
    nr.addEventListener('click', clearAttachment)
  }

  // Paste image from clipboard
  newInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) attachFile(file)
        return
      }
    }
  })

  // Drag & drop
  if (inputRow) {
    inputRow.addEventListener('dragover', (e) => { e.preventDefault(); inputRow.classList.add('drag-over') })
    inputRow.addEventListener('dragleave', () => inputRow.classList.remove('drag-over'))
    inputRow.addEventListener('drop', (e) => {
      e.preventDefault()
      inputRow.classList.remove('drag-over')
      const file = e.dataTransfer?.files[0]
      if (file) attachFile(file)
    })
  }

  // Store clearAttachment on state for sendMessage to call
  ;state._clearAttachment = clearAttachment
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

/** Smart auto-scroll: only scrolls to bottom if user is already near the bottom.
 *  force=true always scrolls (used for user's own messages). */
function scrollToBottom(el: HTMLElement, force = false): void {
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  if (force || distFromBottom < 100) {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
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

/** Fetch current AI provider+model and update the model badge in the status bar. */
async function updateModelBadge(state: TabChatState): Promise<void> {
  const badge = state.container.querySelector(`#model-badge-${state.tabId}`) as HTMLElement | null
  if (!badge) return
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET }) as {
      ok: boolean; settings?: { activeProvider?: string; lmStudioModel?: string; geminiModel?: string; openaiModel?: string; anthropicModel?: string }
    }
    if (!res.ok || !res.settings) return
    const s = res.settings
    const provider = s.activeProvider || 'local'
    let model = ''
    let providerIcon = ''
    switch (provider) {
      case 'local':
        model = s.lmStudioModel || 'Local model'
        providerIcon = '\u2699' // ⚙
        break
      case 'gemini':
        model = s.geminiModel || 'gemini-2.0-flash'
        providerIcon = '\u2728' // ✨
        break
      case 'openai':
        model = s.openaiModel || 'gpt-4o'
        providerIcon = '\u26A1' // ⚡
        break
      case 'anthropic':
        model = s.anthropicModel || 'claude-sonnet'
        providerIcon = '\u2B50' // ⭐
        break
    }
    // Shorten long model names for display
    const shortModel = model.length > 28 ? model.slice(0, 26) + '\u2026' : model
    badge.textContent = `${providerIcon} ${shortModel}`
    badge.title = `Provider: ${provider}\nModel: ${model}`
    badge.style.display = ''
  } catch {
    badge.style.display = 'none'
  }
}

// ─── AI Health Check ────────────────────────────────────────────────────────

let healthCheckInterval: ReturnType<typeof setInterval> | null = null

async function checkAIHealth(state: TabChatState): Promise<void> {
  const dot = state.container.querySelector(`#ai-health-dot-${state.tabId}`) as HTMLElement | null
  if (!dot) return
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.AI_HEALTH_CHECK }) as {
      ok: boolean; connected?: boolean; provider?: string
    }
    if (res.ok && res.connected) {
      dot.className = 'ai-health-dot connected'
      dot.title = `AI connected (${res.provider || 'unknown'})`
    } else {
      dot.className = 'ai-health-dot disconnected'
      dot.title = res.provider === 'local'
        ? 'AI unreachable — check your local server'
        : `AI not configured (${res.provider || 'no provider'})`
    }
  } catch {
    dot.className = 'ai-health-dot disconnected'
    dot.title = 'Cannot reach background service'
  }
}

function startHealthCheckLoop(state: TabChatState): void {
  if (healthCheckInterval) clearInterval(healthCheckInterval)
  checkAIHealth(state)
  healthCheckInterval = setInterval(() => checkAIHealth(state), 60_000)
}

// ─── Contextual Quick Actions ────────────────────────────────────────────────

interface QuickAction { label: string; prompt: string }

const PAGE_TYPE_ACTIONS: Record<string, QuickAction[]> = {
  email: [
    { label: 'Reply', prompt: 'Help me draft a reply to this email.' },
    { label: 'Summarize thread', prompt: 'Summarize this email thread.' },
    { label: 'Extract contacts', prompt: 'Extract all names and email addresses from this page.' },
  ],
  shopping: [
    { label: 'Compare prices', prompt: 'Find and compare prices for this product across other retailers.' },
    { label: 'Summarize reviews', prompt: 'Summarize the reviews for this product.' },
    { label: 'Fill checkout', prompt: 'Fill the form on this page using my vault data.' },
  ],
  travel: [
    { label: 'Compare options', prompt: 'Compare the travel options shown on this page.' },
    { label: 'Summarize itinerary', prompt: 'Summarize the travel itinerary on this page.' },
    { label: 'Fill booking', prompt: 'Fill the form on this page using my vault data.' },
  ],
  coding: [
    { label: 'Explain code', prompt: 'Explain the code shown on this page.' },
    { label: 'Summarize', prompt: 'Summarize this page for me.' },
    { label: 'Find bugs', prompt: 'Review the code on this page and identify potential bugs or improvements.' },
  ],
  finance: [
    { label: 'Summarize', prompt: 'Summarize the financial information on this page.' },
    { label: 'Explain terms', prompt: 'Explain the financial terms and conditions on this page in simple language.' },
  ],
  jobs: [
    { label: 'Match skills', prompt: 'Compare this job listing with my profile/vault data and highlight matching skills.' },
    { label: 'Draft cover letter', prompt: 'Help me draft a cover letter for this job posting.' },
    { label: 'Summarize role', prompt: 'Summarize this job posting with key requirements and salary info.' },
  ],
  news: [
    { label: 'Key takeaways', prompt: 'Give me the key takeaways from this article.' },
    { label: 'Summarize', prompt: 'Summarize this article for me.' },
    { label: 'Fact check', prompt: 'What are the key claims in this article that could be fact-checked?' },
  ],
  social: [
    { label: 'Draft post', prompt: 'Help me draft a post for this platform.' },
    { label: 'Summarize', prompt: 'Summarize the content on this page.' },
    { label: 'Reply', prompt: 'Help me draft a reply to this post.' },
  ],
  docs: [
    { label: 'Summarize', prompt: 'Summarize this document for me.' },
    { label: 'Key points', prompt: 'What are the key points in this document?' },
    { label: 'Draft content', prompt: 'Help me draft new content for this document.' },
  ],
  video: [
    { label: 'Summarize', prompt: 'Summarize what this video page is about.' },
    { label: 'Key moments', prompt: 'What are the key topics or moments mentioned on this page?' },
  ],
  education: [
    { label: 'Explain concept', prompt: 'Explain the main concept taught on this page in simple terms.' },
    { label: 'Quiz me', prompt: 'Create a quick quiz based on the content of this page.' },
    { label: 'Summarize lesson', prompt: 'Summarize this lesson for me.' },
  ],
  health: [
    { label: 'Summarize', prompt: 'Summarize the health information on this page in plain language.' },
    { label: 'Key facts', prompt: 'What are the key medical facts or recommendations on this page?' },
  ],
  realestate: [
    { label: 'Summarize listing', prompt: 'Summarize this property listing with key details.' },
    { label: 'Compare', prompt: 'What are the pros and cons of this property based on the listing?' },
  ],
  general: [
    { label: 'Summarize', prompt: 'Summarize this page for me.' },
    { label: 'Fill form', prompt: 'Fill the forms on this page using my vault data.' },
    { label: 'Draft reply', prompt: 'Help me draft a reply to this conversation/email.' },
    { label: 'Rewrite', prompt: 'Rewrite the selected text to be more professional.' },
  ],
}

function detectPageType(domain: string, url: string): string {
  const d = (domain + ' ' + url).toLowerCase()
  if (/mail\.google|outlook\.(live|office)|yahoo\.com\/mail|protonmail|fastmail/.test(d)) return 'email'
  if (/booking\.com|airbnb|expedia|skyscanner|kayak|google\.com\/travel|flightradar/.test(d)) return 'travel'
  if (/amazon\.|ebay\.|aliexpress|etsy\.com|walmart|target\.com|bestbuy|zalando|temu|shein/.test(d)) return 'shopping'
  if (/github\.com|gitlab|stackoverflow|codepen|npmjs\.com|pypi\.org/.test(d)) return 'coding'
  if (/paypal|stripe|revolut|wise\.com|bank|trading|stock|crypto|coinbase|binance/.test(d)) return 'finance'
  if (/indeed|glassdoor|monster|stepstone|linkedin.*\/jobs/.test(d)) return 'jobs'
  if (/news\.google|cnn|bbc|reuters|nytimes|theguardian/.test(d)) return 'news'
  if (/facebook|twitter|x\.com|instagram|linkedin|reddit|tiktok/.test(d)) return 'social'
  if (/docs\.google|notion\.so|confluence|wiki/.test(d)) return 'docs'
  if (/youtube|vimeo|twitch|netflix/.test(d)) return 'video'
  if (/coursera|udemy|edx\.org|duolingo|khanacademy/.test(d)) return 'education'
  if (/webmd|mayoclinic|healthline/.test(d)) return 'health'
  if (/zillow|realtor|redfin|trulia|immobilien|immoscout/.test(d)) return 'realestate'
  return 'general'
}

async function populateQuickActions(state: TabChatState): Promise<void> {
  const qaContainer = state.container.querySelector('.quick-actions-tab')
  if (!qaContainer) return

  let url = ''
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    url = tab?.url ?? ''
  } catch { /* no tab */ }

  const pageType = detectPageType(state.domain, url)
  const actions = PAGE_TYPE_ACTIONS[pageType] || PAGE_TYPE_ACTIONS.general

  qaContainer.innerHTML = actions.map(a =>
    `<button class="chip" data-prompt="${a.prompt.replace(/"/g, '&quot;')}">${a.label}</button>`
  ).join('')

  qaContainer.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = (chip as HTMLElement).dataset.prompt ?? ''
      getInput(state).value = prompt
      sendMessage(state)
    })
  })
}

// ─── Proactive Page Intelligence ───────────────────────────────���─────────────

async function showProactiveInsights(state: TabChatState): Promise<void> {
  const bar = state.container.querySelector('.proactive-bar-tab') as HTMLElement | null
  if (!bar) return

  const insights: string[] = []
  try {
    // Check for previous visits to this domain
    if (state.domain) {
      const memRes = await chrome.runtime.sendMessage({
        type: MSG.MEMORY_QUERY,
        domain: state.domain,
        limit: 5,
      }) as { ok: boolean; entries?: Array<{ timestamp: number }> }
      if (memRes.ok && memRes.entries && memRes.entries.length > 0) {
        const last = new Date(memRes.entries[0].timestamp)
        const daysAgo = Math.floor((Date.now() - last.getTime()) / 86_400_000)
        if (daysAgo === 0) {
          insights.push('You visited this site earlier today')
        } else if (daysAgo === 1) {
          insights.push('You visited this site yesterday')
        } else if (daysAgo <= 7) {
          insights.push(`You visited this site ${daysAgo} days ago`)
        }
      }
    }

    // Check if page has forms and vault might have matching data
    const snapshotRes = await chrome.runtime.sendMessage({
      type: MSG.GET_TAB_SNAPSHOT,
      tabId: state.tabId,
    }) as { ok: boolean; snapshot?: { formFields?: unknown[] } }
    if (snapshotRes.ok && snapshotRes.snapshot?.formFields) {
      const fieldCount = (snapshotRes.snapshot.formFields as unknown[]).length
      if (fieldCount >= 3) {
        insights.push(`Page has a form with ${fieldCount} fields`)
      }
    }
  } catch { /* non-critical — silently skip */ }

  if (insights.length === 0) {
    bar.style.display = 'none'
    return
  }

  bar.innerHTML = insights.map(i => `<span class="proactive-insight">${i}</span>`).join('')
  bar.style.display = ''
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
  div.dataset.time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (role === 'assistant') {
    const { html, widgets } = renderAssistantHTML(text)
    div.innerHTML = html
    renderWidgetsInContainer(div, widgets)
    attachWidgetHandlers(div, (_wid, val) => handleWidgetChoice(state, val))
    addMessageActions(state, div, text)
    addCodeBlockCopyButtons(div)
    enhanceLinks(div)
  } else {
    div.textContent = text
  }

  messagesEl.appendChild(div)
  scrollToBottom(messagesEl, role === 'user')  // force for user messages, smart for assistant
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
  scrollToBottom(messagesEl, true)  // always scroll for confirmation cards

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

function showModeChoiceCard(state: TabChatState, id: string, description: string): void {
  const messagesEl = getMessages(state)
  const cardEl = createModeChoiceElement(id, description)
  messagesEl.appendChild(cardEl)
  scrollToBottom(messagesEl, true)

  attachWidgetHandlers(
    cardEl,
    () => {},
    undefined,
    (modeId, mode, remember) => {
      getPort(state).postMessage({
        type: MSG.MODE_CHOICE_RESPONSE,
        id: modeId,
        mode,
        remember,
        tabId: state.tabId,
      })
      // Update the toggle to reflect current mode
      const modeBtn = state.container.querySelector<HTMLButtonElement>('.btn-mode-tab')
      if (modeBtn && remember) applyModeVisual(modeBtn, mode)
    }
  )
}

function showFormAssistCard(
  state: TabChatState,
  id: string,
  formTitle: string,
  fields: import('../shared/types').FormAssistField[]
): void {
  const messagesEl = getMessages(state)
  const cardEl = createFormAssistElement(id, fields, formTitle)
  messagesEl.appendChild(cardEl)
  scrollToBottom(messagesEl, true)

  attachFormAssistHandlers(cardEl, {
    onFillField: async (selector, value, inputType) => {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: MSG.FORM_ASSIST_FILL_FIELD,
          selector, value, inputType,
          tabId: state.tabId,
        })
        return resp?.ok ?? false
      } catch {
        return false
      }
    },
    onCopyField: (value) => {
      navigator.clipboard.writeText(value).catch(() => {})
    },
    onCopyAll: (text) => {
      navigator.clipboard.writeText(text).catch(() => {})
    },
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

/** Add copy buttons to code blocks in assistant messages */
function addCodeBlockCopyButtons(el: HTMLElement): void {
  el.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy-btn')) return
    const btn = document.createElement('button')
    btn.className = 'code-copy-btn'
    btn.title = 'Copy code'
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
      navigator.clipboard.writeText(code).catch(() => {})
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      setTimeout(() => {
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
      }, 1500)
    })
    pre.appendChild(btn)
  })
}

/** Enhance auto-linked URLs with copy-on-click tooltip */
function enhanceLinks(el: HTMLElement): void {
  el.querySelectorAll('a.auto-link').forEach(link => {
    if (link.getAttribute('data-enhanced')) return
    link.setAttribute('data-enhanced', '1')
    const href = link.getAttribute('href') ?? ''

    // Shorten displayed URL for readability (keep domain + first path segment)
    try {
      const u = new URL(href)
      const short = u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 30) + (u.pathname.length > 30 ? '...' : '') : '')
      link.textContent = short
      // The ::after pseudo-element adds the arrow icon via CSS
    } catch { /* leave as-is for malformed URLs */ }

    // Copy URL on middle-click or Ctrl+click
    link.addEventListener('auxclick', (e) => {
      if ((e as MouseEvent).button === 1) {
        e.preventDefault()
        navigator.clipboard.writeText(href).catch(() => {})
        showCopyFeedback(link as HTMLElement)
      }
    })
    link.addEventListener('click', (e) => {
      if ((e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey) {
        e.preventDefault()
        navigator.clipboard.writeText(href).catch(() => {})
        showCopyFeedback(link as HTMLElement)
      }
    })
    link.setAttribute('title', `${href}\n\nClick to open  |  Ctrl+click to copy`)
  })
}

function showCopyFeedback(el: HTMLElement): void {
  const original = el.style.background
  el.style.background = 'rgba(138,92,246,0.3)'
  el.setAttribute('title', 'Copied!')
  setTimeout(() => {
    el.style.background = original
    const href = el.getAttribute('href') ?? ''
    el.setAttribute('title', `${href}\n\nClick to open  |  Ctrl+click to copy`)
  }, 1200)
}

function appendChunk(state: TabChatState, chunk: string): void {
  const messagesEl = getMessages(state)
  if (!state.currentBubble) {
    state.currentBubble = document.createElement('div')
    state.currentBubble.className = 'message message-assistant streaming'
    state.currentBubble.dataset.time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

  // Re-add cancel button after innerHTML replacement
  ensureStreamCancelButton(state)

  scrollToBottom(messagesEl)  // smart: only if user is near bottom
}

/** Adds or re-adds an inline cancel/stop button to the streaming bubble */
function ensureStreamCancelButton(state: TabChatState): void {
  if (!state.currentBubble || state.currentBubble.querySelector('.stream-cancel-btn')) return
  const btn = document.createElement('button')
  btn.className = 'stream-cancel-btn'
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Stop`
  btn.addEventListener('click', (e) => { e.stopPropagation(); stopStream(state) })
  state.currentBubble.appendChild(btn)
}

function finalizeMessage(state: TabChatState, fullText: string): void {
  const remaining = flushRemaining(state)
  if (remaining && state.currentBubble) {
    state.currentBubbleRaw += remaining
  }

  // Remove streaming UI (cancel button, streaming class)
  if (state.currentBubble) {
    state.currentBubble.classList.remove('streaming')
    const cancelEl = state.currentBubble.querySelector('.stream-cancel-btn')
    if (cancelEl) cancelEl.remove()
  }

  if (state.currentBubble && fullText) {
    const { html, widgets } = renderAssistantHTML(fullText)
    state.currentBubble.innerHTML = html
    renderWidgetsInContainer(state.currentBubble, widgets)
    attachWidgetHandlers(state.currentBubble, (_wid, val) => handleWidgetChoice(state, val))
    addMessageActions(state, state.currentBubble, fullText)
    addCodeBlockCopyButtons(state.currentBubble)
    enhanceLinks(state.currentBubble)
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
  // Clean up streaming bubble if one exists
  if (state.currentBubble) {
    state.currentBubble.classList.remove('streaming')
    const cancelEl = state.currentBubble.querySelector('.stream-cancel-btn')
    if (cancelEl) cancelEl.remove()
    state.currentBubble = null
    state.currentBubbleRaw = ''
    state.streamBuffer = ''
  }
  const messagesEl = getMessages(state)
  const div = document.createElement('div')
  div.className = 'message message-error'
  div.textContent = `Error: ${error}`
  messagesEl.appendChild(div)
  scrollToBottom(messagesEl, true)  // always scroll for errors
  setStreaming(state, false)
}

// ─── Sending ──────────────────────────────────────────────────────────────────

async function sendMessage(state: TabChatState): Promise<void> {
  const inputEl = getInput(state)
  let text = inputEl.value.trim()
  if (!text || state.isStreaming) return

  // Auto-stop mic recording if active
  if (state._stopMic) state._stopMic()

  if (state.pendingAbort) {
    state.pendingAbort.abort()
    state.pendingAbort = null
  }

  const imageData = state.pendingImageData
  const fileContext = state.pendingFileContext
  const fileName = state.pendingFileName

  // Prepend file content as context if attached
  if (fileContext) {
    text = `[Attached file: ${fileName}]\n\`\`\`\n${fileContext.slice(0, 20_000)}\n\`\`\`\n\n${text}`
  }

  inputEl.value = ''
  inputEl.style.height = 'auto'

  // Show user message with optional image thumbnail
  // Extract the user's original text after the file context block (separated by \n\n)
  const displayText = fileContext
    ? (() => { const sep = text.indexOf('\n\n'); return `[${fileName}] ${sep >= 0 ? text.slice(sep + 2) : text}` })()
    : text
  const bubble = addBubble(state, 'user', displayText)
  if (imageData && imageData.startsWith('data:image/')) {
    const img = document.createElement('img')
    img.src = imageData
    img.style.cssText = 'max-width:100%;max-height:120px;border-radius:8px;margin-top:6px;display:block;'
    bubble.appendChild(img)
  }

  // Clear attachment after capturing
  if (state._clearAttachment) state._clearAttachment()

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
      imageData: imageData || undefined,
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

// ─── Mode Toggle (Ask → Auto → Guide) ────────────────────────────────────────

type AutomationPref = 'ask' | 'auto' | 'guided'

async function loadModeToggle(btn: HTMLButtonElement): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET }) as {
      ok: boolean; settings?: { automationPreference?: AutomationPref }
    }
    const pref = (res.ok && res.settings?.automationPreference) || 'ask'
    applyModeVisual(btn, pref)
  } catch {
    applyModeVisual(btn, 'ask')
  }
}

function applyModeVisual(btn: HTMLButtonElement, mode: AutomationPref): void {
  const label = btn.querySelector('.mode-label')
  btn.classList.remove('guided', 'auto-mode')
  btn.dataset.mode = mode
  if (mode === 'guided') {
    btn.classList.add('guided')
    btn.title = 'Guided mode — click to change'
    if (label) label.textContent = 'Guide'
  } else if (mode === 'auto') {
    btn.classList.add('auto-mode')
    btn.title = 'Auto mode — click to change'
    if (label) label.textContent = 'Auto'
  } else {
    btn.title = 'Ask each time — click to change'
    if (label) label.textContent = 'Ask'
  }
}

async function toggleMode(btn: HTMLButtonElement): Promise<void> {
  const current = (btn.dataset.mode ?? 'ask') as AutomationPref
  // Cycle: Ask → Auto → Guide → Ask
  const next: AutomationPref = current === 'ask' ? 'auto' : current === 'auto' ? 'guided' : 'ask'

  await chrome.runtime.sendMessage({
    type: MSG.SETTINGS_SET,
    partial: { automationPreference: next },
  }).catch(() => {})

  applyModeVisual(btn, next)
}

/** Show a dismissible toast notification above the input row */
function showChatToast(state: TabChatState, message: string, type: 'error' | 'info' = 'error'): void {
  // Remove any existing toast
  state.container.querySelector('.chat-toast')?.remove()

  const toast = document.createElement('div')
  toast.className = `chat-toast chat-toast-${type}`

  const icon = type === 'error'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'

  const textEl = document.createElement('span')
  textEl.className = 'chat-toast-text'
  textEl.textContent = message

  const closeBtn = document.createElement('button')
  closeBtn.className = 'chat-toast-close'
  closeBtn.innerHTML = '&times;'
  closeBtn.addEventListener('click', () => toast.remove())

  toast.innerHTML = icon
  toast.appendChild(textEl)
  toast.appendChild(closeBtn)

  const inputRow = state.container.querySelector('.input-row')
  if (inputRow) {
    inputRow.parentNode!.insertBefore(toast, inputRow)
  }

  // Auto-dismiss after 12 seconds (longer for error messages that may contain instructions)
  setTimeout(() => { if (toast.parentNode) toast.remove() }, 12000)
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

/**
 * Programmatically send a chat message (used by context menus + keyboard shortcuts).
 * Injects text into the active session's input and triggers send.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function sendChatMessage(text: string): void {
  const state = getActiveState()
  if (!state) return
  const inputEl = getInput(state)
  inputEl.value = text
  sendMessage(state)
}

export function cleanupClosedTab(tabId: number): void {
  const sid = tabToSession.get(tabId)
  tabToSession.delete(tabId)
  if (!sid) return
  const state = sessionStates.get(sid)
  if (!state) return
  // Only clean up session state if no other tabs reference this session
  let otherTabReferences = false
  for (const [tid, s] of tabToSession) {
    if (tid !== tabId && s === sid) { otherTabReferences = true; break }
  }
  if (!otherTabReferences) {
    if (state.port) {
      try { state.port.disconnect() } catch { /* already disconnected */ }
    }
    sessionStates.delete(sid)
  }
}
