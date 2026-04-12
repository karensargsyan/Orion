import { MSG, PORT_AI_STREAM } from '../shared/constants'
import { renderMarkdown, sanitizeHtml } from './markdown'
import { parseWidgets, parseActionResults, renderWidgetsInContainer, attachWidgetHandlers, createActionConfirmElement, createModeChoiceElement, createFormAssistElement, attachFormAssistHandlers } from './chat-widgets'
import { sanitizeModelOutput, stripMalformedActions } from '../shared/sanitize-output'
import type { Widget } from './chat-widgets'
import * as speech from './speech-service'
import { createContextStackPanel, refreshContextStack } from './context-stack-ui'
import { createWorkflowPanel, refreshWorkflowList } from './workflow-ui'

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
  /** Full text of a large paste (>400 chars), shown as a chip */
  pendingLargeText: string | null
}

const sessionStates = new Map<string, TabChatState>()
const tabToSession = new Map<number, string>()
let activeTabId = 0
let activeSessionId = ''
/** Tab IDs selected for cross-tab context (max 3) */
const selectedCrossTabIds: number[] = []

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

function handlePortMessage(state: TabChatState, msg: { type: string; chunk?: string; fullText?: string; error?: string; id?: string; description?: string; risk?: string; actions?: string[]; mode?: string; remember?: boolean; formTitle?: string; fields?: unknown[]; autoFilledCount?: number; reasoning?: string; confidence?: number; targetSelector?: string; event?: unknown }): void {
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
      showConfirmationCard(state, msg.id!, msg.description!, msg.risk!, msg.actions ?? [], msg.reasoning as string | undefined, msg.confidence as number | undefined, msg.targetSelector as string | undefined)
      break
    case MSG.MODE_CHOICE:
      showModeChoiceCard(state, msg.id!, msg.description!)
      break
    case MSG.FORM_ASSIST:
      showFormAssistCard(state, msg.id!, msg.formTitle as string ?? 'Form', msg.fields as import('../shared/types').FormAssistField[] ?? [])
      break
    case MSG.WATCH_EVENT:
      showWatchEventCard(state, msg.event as import('../shared/types').WatchEvent)
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
  wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;position:relative;'
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
    <div class="smart-status smart-status-tab" id="smart-status-${tabId}">
      <span class="smart-status-dot none" id="status-dot-${tabId}"></span>
      <span class="smart-status-text" id="status-text-${tabId}">Ready</span>
      <span class="watch-indicator" id="watch-indicator-${tabId}" style="display:none">&#x1F441; Watching</span>
      <button class="smart-status-expand smart-status-expand-tab" title="Show details" aria-label="Expand context details">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
    </div>
    <div class="smart-status-drawer smart-status-drawer-tab" id="smart-drawer-${tabId}" style="display:none">
      <div class="drawer-row">
        <button class="drawer-btn drawer-btn-rescan" title="Re-read the current page content">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          Refresh page data
        </button>
        <button class="drawer-btn drawer-btn-add-tab" title="Include another tab for comparison">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
          Compare with tab
        </button>
        <button class="drawer-btn drawer-btn-context" title="See all context sources feeding the AI">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
          View AI context
        </button>
      </div>
      <div class="drawer-row drawer-row-mode">
        <label class="drawer-label">Before actions:</label>
        <select class="drawer-select exec-mode-select">
          <option value="approve" selected>Ask me first</option>
          <option value="auto_low_risk">Run safe ones automatically</option>
          <option value="suggest">Just suggest, don't do</option>
          <option value="ask_only">Only answer questions</option>
        </select>
      </div>
    </div>
    <div class="pinned-facts-bar pinned-facts-bar-tab" id="pinned-facts-bar-${tabId}" style="display:none"></div>
    <div class="selection-chips selection-chips-tab" style="display:none">
      <span class="selection-chips-label">Selection:</span>
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
    <div class="input-toolbar">
      <button class="btn-icon btn-mic-tab" title="Hold to speak, double-click to lock">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
      </button>
      <button class="btn-icon btn-attach-tab" title="Attach image">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
      </button>
      <input type="file" class="file-input-tab" accept="image/*,.pdf,.txt,.csv" style="display:none">
      <button class="btn-mode-toggle btn-mode-tab" title="Switch mode">
        <span class="mode-label">Auto</span>
      </button>
      <div class="depth-toggle depth-toggle-tab">
        <button class="depth-btn active" data-depth="standard" title="Standard depth">Std</button>
        <button class="depth-btn" data-depth="quick" title="Quick: 1-2 sentences">Quick</button>
        <button class="depth-btn" data-depth="deep" title="Deep: thorough with examples">Deep</button>
      </div>
    </div>
    <div class="input-row">
      <div style="position:relative;flex:1;display:flex;flex-direction:column;">
        <textarea class="chat-input-tab" placeholder="Ask anything... (/ for commands)" rows="1" aria-label="Chat message input"></textarea>
      </div>
      <button class="btn-primary btn-send btn-send-tab" aria-label="Send message">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
      </button>
      <button class="btn-danger btn-send btn-stop-tab" style="display:none" aria-label="Stop AI response">Stop</button>
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
    pendingLargeText: null,
  }
  sessionStates.set(sessionId, state)

  parentContainer.innerHTML = ''
  parentContainer.appendChild(wrapper)

  // Insert context stack panel as overlay (appended to wrapper for z-index stacking)
  const ctxPanel = createContextStackPanel(tabId)
  wrapper.appendChild(ctxPanel)

  // Insert workflow panel (hidden by default)
  const wfPanel = createWorkflowPanel()
  wfPanel.style.display = 'none'
  wrapper.insertBefore(wfPanel, wrapper.querySelector('.messages'))

  wireEvents(state)
  updatePageContext(state)
  updateModelBadge(state)
  loadTabHistory(state)
  startHealthCheckLoop(state)
  showProactiveInsights(state)
  triggerContextualHints(state)
  refreshPinnedFactsBar(state)
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
    // Slash dropdown navigation handled separately below
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

  // ── Smart Status: expand/collapse drawer ──
  const expandBtn = c.querySelector<HTMLButtonElement>('.smart-status-expand-tab')
  const drawerEl = c.querySelector<HTMLElement>('.smart-status-drawer-tab')
  if (expandBtn && drawerEl) {
    expandBtn.addEventListener('click', () => {
      const isOpen = drawerEl.style.display !== 'none'
      drawerEl.style.display = isOpen ? 'none' : ''
      expandBtn.classList.toggle('open', !isOpen)
    })
  }

  // ── Drawer: Refresh page data (replaces Rescan) ──
  const rescanBtn = c.querySelector<HTMLButtonElement>('.drawer-btn-rescan')
  if (rescanBtn) {
    rescanBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: MSG.REQUEST_SNAPSHOT, tabId: state.tabId }).catch(() => {})
      lastScanTimestamp = Date.now()
      currentScanMode = 'full'
      updateSmartStatus(state)
      rescanBtn.classList.add('drawer-btn-done')
      const origHTML = rescanBtn.innerHTML
      rescanBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Refreshed'
      setTimeout(() => { rescanBtn.innerHTML = origHTML; rescanBtn.classList.remove('drawer-btn-done') }, 1500)
    })
  }

  // ── Drawer: Compare with tab (replaces Tab+) ──
  const addTabBtn = c.querySelector<HTMLButtonElement>('.drawer-btn-add-tab')
  if (addTabBtn) {
    addTabBtn.addEventListener('click', async () => {
      const resp = await chrome.runtime.sendMessage({ type: MSG.GET_TAB_LIST }) as { ok?: boolean; tabs?: Array<{ id: number; title: string; url: string; active: boolean }> }
      if (!resp?.ok || !resp.tabs) return
      const otherTabs = resp.tabs.filter(t => t.id !== state.tabId && !selectedCrossTabIds.includes(t.id))
      if (otherTabs.length === 0) return

      // Remove existing dropdown
      c.querySelector('.cross-tab-dropdown')?.remove()

      const dropdown = document.createElement('div')
      dropdown.className = 'cross-tab-dropdown'
      otherTabs.slice(0, 10).forEach(t => {
        const item = document.createElement('div')
        item.className = 'cross-tab-item'
        item.textContent = `${t.title.slice(0, 40)} — ${new URL(t.url || 'about:blank').hostname}`
        item.addEventListener('click', () => {
          if (selectedCrossTabIds.length >= 3) return
          selectedCrossTabIds.push(t.id)
          renderCrossTabChips(state)
          dropdown.remove()
          updateSmartStatus(state)
        })
        dropdown.appendChild(item)
      })
      addTabBtn.parentElement!.appendChild(dropdown)
      const close = (e: MouseEvent) => {
        if (!dropdown.contains(e.target as Node)) { dropdown.remove(); document.removeEventListener('click', close) }
      }
      setTimeout(() => document.addEventListener('click', close), 0)
    })
  }

  // ── Drawer: View AI context (replaces Ctx) ──
  const ctxBtn = c.querySelector<HTMLButtonElement>('.drawer-btn-context')
  if (ctxBtn) {
    ctxBtn.addEventListener('click', async () => {
      const panel = c.querySelector<HTMLElement>('.context-stack-panel')
      if (!panel) return
      const isVisible = panel.style.display !== 'none'
      panel.style.display = isVisible ? 'none' : ''
      if (!isVisible) {
        await refreshContextStack(state.tabId, panel)
      }
    })
  }

  // ── Drawer: Execution mode selector ──
  const execSelect = c.querySelector<HTMLSelectElement>('.exec-mode-select')
  if (execSelect) {
    chrome.storage.local.get('executionMode').then(r => {
      if (r.executionMode) execSelect.value = r.executionMode
    }).catch(() => {})
    execSelect.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: MSG.SET_EXECUTION_MODE, mode: execSelect.value }).catch(() => {})
    })
  }

  // ── Depth toggle (PRD 9.1.6) ──
  const depthContainer = c.querySelector<HTMLElement>('.depth-toggle-tab')
  if (depthContainer) {
    depthContainer.querySelectorAll<HTMLButtonElement>('.depth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        depthContainer.querySelector('.depth-btn.active')?.classList.remove('active')
        btn.classList.add('active')
        currentExplanationDepth = (btn.dataset.depth as 'quick' | 'standard' | 'deep') || 'standard'
      })
    })
  }

  // ── Slash command dropdown (PRD 6.1D) ──
  let slashDropdown: HTMLElement | null = null
  let slashActiveIndex = 0

  function showSlashDropdown(filter: string): void {
    removeSlashDropdown()
    const matches = SLASH_COMMANDS.filter(c =>
      c.cmd.startsWith(filter) || c.label.toLowerCase().includes(filter.slice(1).toLowerCase())
    )
    if (matches.length === 0) return
    slashActiveIndex = 0
    slashDropdown = document.createElement('div')
    slashDropdown.className = 'slash-dropdown'
    matches.forEach((cmd, i) => {
      const item = document.createElement('div')
      item.className = 'slash-item' + (i === 0 ? ' active' : '')
      item.innerHTML = `<span class="slash-item-cmd">${cmd.cmd}</span> <span class="slash-item-desc">${cmd.label}</span>`
      item.addEventListener('click', () => {
        newInput.value = ''
        removeSlashDropdown()
        if (cmd.prompt === '__WORKFLOW_PANEL__') {
          const wfPanel = state.container.querySelector('.workflow-panel') as HTMLElement | null
          if (wfPanel) {
            wfPanel.style.display = wfPanel.style.display === 'none' ? '' : 'none'
            if (wfPanel.style.display !== 'none') refreshWorkflowList(wfPanel)
          }
          return
        }
        getInput(state).value = cmd.prompt
        sendMessage(state)
      })
      slashDropdown!.appendChild(item)
    })
    const inputWrapper = newInput.closest('div[style*="position:relative"]')
    if (inputWrapper) inputWrapper.appendChild(slashDropdown)
  }

  function removeSlashDropdown(): void {
    if (slashDropdown) { slashDropdown.remove(); slashDropdown = null }
  }

  newInput.addEventListener('input', () => {
    newInput.style.height = 'auto'
    newInput.style.height = Math.min(newInput.scrollHeight, 120) + 'px'
    // Slash command detection
    const val = newInput.value
    if (val.startsWith('/') && !val.includes(' ')) {
      showSlashDropdown(val)
    } else {
      removeSlashDropdown()
    }
  })

  // Override keydown to handle slash dropdown navigation
  newInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (slashDropdown) {
      const items = slashDropdown.querySelectorAll('.slash-item')
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        items[slashActiveIndex]?.classList.remove('active')
        slashActiveIndex = Math.min(slashActiveIndex + 1, items.length - 1)
        items[slashActiveIndex]?.classList.add('active')
        items[slashActiveIndex]?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        items[slashActiveIndex]?.classList.remove('active')
        slashActiveIndex = Math.max(slashActiveIndex - 1, 0)
        items[slashActiveIndex]?.classList.add('active')
        items[slashActiveIndex]?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const active = slashDropdown.querySelector('.slash-item.active') as HTMLElement | null
        if (active) active.click()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        removeSlashDropdown()
        return
      }
    }
  })

  // ── Listen for page scan updates to refresh smart status ──
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.PAGE_SNAPSHOT && msg.tabId === state.tabId) {
      lastScanTimestamp = Date.now()
      currentScanMode = msg.selectedText ? 'selection' : 'full'
      currentContextType = msg.selectedText ? 'selection' : 'page'
      updateSmartStatus(state)
    }
    if (msg.type === MSG.TEXT_SELECTED && msg.tabId === state.tabId) {
      currentContextType = 'selection'
      showSelectionChips(state, msg.text)
      updateSmartStatus(state)
    }
  })

  // Initial smart status update
  updateSmartStatus(state)

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

  // Paste image from clipboard; collapse large text pastes into a chip
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
    // After paste settles, check for large text
    setTimeout(() => {
      const val = newInput.value
      if (val.length > 400 && !state.pendingLargeText) {
        state.pendingLargeText = val
        newInput.value = val.slice(0, 100) + '…'
        newInput.style.height = 'auto'
        showLargeTextChip(state, val.length)
      }
    }, 0)
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

// ─── Large paste chip ─────────────────────────────────────────────────────────

function showLargeTextChip(state: TabChatState, charCount: number): void {
  const inputRow = state.container.querySelector<HTMLElement>('.chat-input-row')
  if (!inputRow) return
  // Remove any existing chip
  inputRow.querySelector('.large-text-chip')?.remove()

  const chip = document.createElement('div')
  chip.className = 'large-text-chip'
  chip.innerHTML =
    `<span class="chip-icon">📋</span>` +
    `<span class="chip-label">${charCount.toLocaleString()} characters pasted</span>` +
    `<button class="chip-expand" title="Expand to edit">↕ Expand</button>` +
    `<button class="chip-clear" title="Remove pasted text">✕</button>`

  chip.querySelector('.chip-expand')?.addEventListener('click', () => {
    const input = state.container.querySelector<HTMLTextAreaElement>('.chat-input-tab')!
    if (state.pendingLargeText) input.value = state.pendingLargeText
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 300) + 'px'
    chip.remove()
    state.pendingLargeText = null
    input.focus()
  })

  chip.querySelector('.chip-clear')?.addEventListener('click', () => {
    clearLargeText(state)
  })

  inputRow.insertBefore(chip, inputRow.firstChild)
}

function clearLargeText(state: TabChatState): void {
  state.container.querySelector('.large-text-chip')?.remove()
  state.pendingLargeText = null
  const input = state.container.querySelector<HTMLTextAreaElement>('.chat-input-tab')!
  input.value = ''
  input.style.height = 'auto'
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
      const domainLabel = state.domain ? ` · ${state.domain}` : ''
      label.textContent = tab.title.slice(0, 45) + domainLabel
      label.title = `${tab.title}\n${tab.url ?? ''}`
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
    { label: 'Extract key info', prompt: 'Extract the key structured information from this page.' },
    { label: 'What matters?', prompt: 'What is important on this page? What should I pay attention to?' },
    { label: 'Find actions', prompt: 'What are the key action items or things I need to do on this page?' },
    { label: 'Help navigate', prompt: 'Help me find the key sections and navigation options on this page.' },
    { label: 'Fill form', prompt: 'Fill the forms on this page using my vault data.' },
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
  const baseActions = PAGE_TYPE_ACTIONS[pageType] || PAGE_TYPE_ACTIONS.general
  const actions: QuickAction[] = [...baseActions]

  // Dynamic enhancements based on context signals
  try {
    // Check if user visited this domain before — offer contextual action
    if (state.domain) {
      const memRes = await chrome.runtime.sendMessage({ type: MSG.MEMORY_QUERY, domain: state.domain, limit: 1 }) as { ok?: boolean; results?: unknown[] }
      if (memRes?.ok && memRes.results && memRes.results.length > 0) {
        actions.push({ label: 'What changed?', prompt: `I was on ${state.domain} before. What's new or changed since my last visit?` })
      }
    }
  } catch { /* non-critical enhancement */ }

  // Limit to 5 actions max for clean UI
  const finalActions = actions.slice(0, 5)

  qaContainer.innerHTML = finalActions.map(a =>
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

// ─── Ambiguity Detection ────────────────────────────────────────────────────

/** Patterns that indicate clear user intent — skip ambiguity card if matched */
const AMBIGUITY_INTENT_PATTERNS = [
  /\b(summarize|explain|compare|extract|fill|watch|translate|navigate|go to|open|click|press|find|search|help|what|how|why|who|when|where|show|list|describe|debug|plan|run|submit|send|copy|save|pin|draft|reply|write|tell|ask|check|read|analyze|review|fix|correct|improve|make|create)\b/i,
  /\b(klicke?|drücke?|finde?|suche?|hilf|was|wie|warum|wer|wann|wo|zeig|beschreib|füll|übersetze?|öffne?|gehe?)\b/i,
  /^\/\w/,  // slash commands
  /^(hi|hello|hey|hallo|grüße|salut|ciao|howdy|thanks?|ok(ay)?|yes|no|sure|great|good|nice)[^a-z]*/i,  // greetings + short acks
]

function showAmbiguityCard(state: TabChatState, text: string, pageType: string): void {
  const messagesEl = getMessages(state)

  // Generate context-aware suggestions
  const suggestions: { label: string; prompt: string }[] = [
    { label: 'Summarize this page', prompt: 'Summarize this page for me.' },
    { label: `What is "${text}"?`, prompt: `What is "${text}"? Explain it in the context of this page.` },
    { label: 'Search for this', prompt: `Search for "${text}" on this page and highlight relevant sections.` },
  ]

  if (pageType === 'shopping') {
    suggestions.push({ label: 'Find best price', prompt: `Find the best price for "${text}".` })
  }

  const card = document.createElement('div')
  card.className = 'ambiguity-card'
  card.innerHTML = `
    <div class="ambiguity-header">Did you mean:</div>
    <div class="ambiguity-options">
      ${suggestions.map(s => `<button class="ambiguity-option" data-prompt="${s.prompt.replace(/"/g, '&quot;')}">${s.label}</button>`).join('')}
    </div>
    <button class="ambiguity-send-anyway">Send "${text.length > 30 ? text.slice(0, 27) + '...' : text}" as-is</button>
  `

  // Wire option buttons
  card.querySelectorAll('.ambiguity-option').forEach(btn => {
    btn.addEventListener('click', () => {
      card.remove()
      getInput(state).value = (btn as HTMLElement).dataset.prompt ?? ''
      sendMessage(state)
    })
  })

  // Wire "send as-is" button
  card.querySelector('.ambiguity-send-anyway')?.addEventListener('click', () => {
    card.remove()
    getInput(state).value = text
    // Bypass ambiguity check by prefixing with space that gets trimmed in the port
    ambiguityBypass = true
    sendMessage(state)
  })

  messagesEl.appendChild(card)
  scrollToBottom(messagesEl, true)

  // Auto-dismiss after 10 seconds
  setTimeout(() => { if (card.parentElement) card.remove() }, 10000)
}

let ambiguityBypass = false

// ─── Onboarding Hints (Progressive Disclosure) ─────────────────────────────

interface HintsSeen { [hintId: string]: number }

async function showOnboardingHint(state: TabChatState, hintId: string, text: string): Promise<void> {
  try {
    const stored = await chrome.storage.local.get('orion_hints_seen') as { orion_hints_seen?: HintsSeen }
    const seen = stored.orion_hints_seen ?? {}

    // Don't show if seen 2+ times or total interactions > 15
    if ((seen[hintId] ?? 0) >= 2) return
    const totalSeen = Object.values(seen).reduce((a, b) => a + b, 0)
    if (totalSeen >= 15) return

    // Show hint
    const messagesEl = getMessages(state)
    const hint = document.createElement('div')
    hint.className = 'onboarding-hint'
    hint.innerHTML = `
      <span class="onboarding-hint-icon">💡</span>
      <span class="onboarding-hint-text">${text}</span>
      <button class="onboarding-hint-dismiss" title="Dismiss">&times;</button>
    `
    hint.querySelector('.onboarding-hint-dismiss')?.addEventListener('click', () => hint.remove())
    messagesEl.prepend(hint)

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      if (hint.parentElement) {
        hint.style.opacity = '0'
        setTimeout(() => hint.remove(), 300)
      }
    }, 8000)

    // Track
    seen[hintId] = (seen[hintId] ?? 0) + 1
    await chrome.storage.local.set({ orion_hints_seen: seen })
  } catch { /* non-critical */ }
}

async function triggerContextualHints(state: TabChatState): Promise<void> {
  const pageType = detectPageType(state.domain, '')

  if (pageType === 'shopping' || pageType === 'travel') {
    showOnboardingHint(state, 'compare', 'I can compare products or options across tabs. Just ask "compare" or click Compare with tab.')
  } else if (pageType === 'email') {
    showOnboardingHint(state, 'email', 'I can help draft replies, summarize threads, and extract contacts from emails.')
  } else {
    showOnboardingHint(state, 'general', 'I can read this page and help you with it. Just ask me anything!')
  }
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

/**
 * Detect and extract "thinking" text from AI responses.
 * Thinking patterns:
 * 1. Explicit markers: <thinking>...</thinking> or [THINKING]...[/THINKING]
 * 2. Reasoning blocks that start with analysis phrases before the actual answer
 */
function extractThinking(text: string): { thinking: string; answer: string } {
  // Pattern 1: Explicit thinking tags
  const tagMatch = text.match(/^[\s\n]*(?:<thinking>|{thinking}|\[THINKING\])([\s\S]*?)(?:<\/thinking>|{\/thinking}|\[\/THINKING\])\s*([\s\S]*)$/i)
  if (tagMatch) {
    return { thinking: tagMatch[1].trim(), answer: tagMatch[2].trim() }
  }

  // Pattern 2: Heuristic — reasoning block followed by a clear answer.
  // Detect blocks that start with reasoning phrases and end before the actual reply.
  const reasoningStart = /^(The user is asking|I need to|Let me|Analyze|Looking at|Scanning|I will|I should|Given the|Since the|Based on|First,|Step \d|Checking|Reviewing|Processing|Self-Correction)/im
  if (!reasoningStart.test(text.trim())) {
    return { thinking: '', answer: text }
  }

  // Look for a clear transition to the answer:
  // - A double newline followed by a non-reasoning sentence
  // - A markdown heading
  // - Sentence starting with direct answer patterns
  const answerPatterns = [
    /\n\n(?=[A-Z][^.]{5,}\.\s)/,           // Double newline + direct sentence
    /\n\n(?=#{1,3}\s)/,                      // Double newline + markdown heading
    /\n\n(?=\*\*[^*]+\*\*)/,                // Double newline + bold text
    /\n\n(?=(?:Yes|No|Here|This|The|I found|I don't|Unfortunately|Based on|Looking at this|There is|There are)[,.\s])/i,
    /\n\n(?=(?:Ja|Nein|Hier|Das|Leider|Basierend)[,.\s])/i,
  ]

  for (const pattern of answerPatterns) {
    const match = text.match(pattern)
    if (match && match.index !== undefined) {
      const thinkPart = text.slice(0, match.index).trim()
      const answerPart = text.slice(match.index).trim()
      // Only split if thinking is substantial and answer exists
      if (thinkPart.length > 100 && answerPart.length > 20) {
        return { thinking: thinkPart, answer: answerPart }
      }
    }
  }

  return { thinking: '', answer: text }
}

// ─── Source Grounding Labels (PRD 8.1.6) ──────────────────────────────────────

const SOURCE_TAG_RE = /\[SOURCE:(page|selection|visible|memory|general|stale)\]/gi

function parseSourceLabels(html: string): { html: string; sources: string[] } {
  const sources: string[] = []
  const cleaned = html.replace(SOURCE_TAG_RE, (_match, type: string) => {
    const lower = type.toLowerCase()
    if (!sources.includes(lower)) sources.push(lower)
    return ''
  })
  return { html: cleaned, sources }
}

function renderSourceBadges(sources: string[]): string {
  if (sources.length === 0) return ''
  const labels: Record<string, string> = {
    page: 'Based on page',
    selection: 'Selected text',
    visible: 'Visible area',
    memory: 'Prior context',
    general: 'General knowledge',
    stale: 'Stale context',
  }
  const badges = sources.map(s =>
    `<span class="source-badge source-badge-${s}">${labels[s] || s}</span>`
  ).join('')
  return `<div class="source-badges">${badges}</div>`
}

// ─── Page Reference Parser (PRD 8.1.7) ────────────────────────────────────────

function parsePageReferences(html: string): string {
  // Match [REF:selector]text[/REF] — works on both raw and HTML-escaped
  return html
    .replace(/\[REF:([^\]]+)\]([^[]*)\[\/REF\]/g, (_m, selector: string, label: string) =>
      `<span class="page-ref" data-selector="${selector.replace(/"/g, '&quot;')}" title="Click to highlight on page">${label}</span>`
    )
    .replace(/\[REF:([^\]]*?)\]([^[]*?)\[\/REF\]/g, (_m, selector: string, label: string) =>
      `<span class="page-ref" data-selector="${selector.replace(/"/g, '&quot;')}" title="Click to highlight on page">${label}</span>`
    )
}

// ─── Extraction Card Parser (PRD 8.1.8) ───────────────────────────────────────

function parseExtractionBlocks(html: string): string {
  // Match [EXTRACT title="..."]key: value\nkey: value[/EXTRACT]
  const re = /\[EXTRACT(?:\s+title=&quot;([^&]*)&quot;)?\]([\s\S]*?)\[\/EXTRACT\]/g
  const rawRe = /\[EXTRACT(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/EXTRACT\]/g

  function buildCard(title: string, body: string): string {
    const rows = body.split('\n').filter(l => l.trim()).map(line => {
      const sep = line.indexOf(':')
      if (sep === -1) return `<div class="extraction-row"><span class="extraction-value" contenteditable="false">${line.trim()}</span><button class="extraction-copy-btn" title="Copy">&#x2398;</button><button class="extraction-row-delete" title="Delete row">&times;</button></div>`
      const key = line.slice(0, sep).trim()
      const val = line.slice(sep + 1).trim()
      return `<div class="extraction-row"><span class="extraction-key" contenteditable="false">${key}</span><span class="extraction-value" contenteditable="false">${val}</span><button class="extraction-copy-btn" title="Copy">&#x2398;</button><button class="extraction-row-delete" title="Delete row">&times;</button></div>`
    }).join('')

    return `<div class="extraction-card">
      <div class="extraction-card-header"><span>${title || 'Extracted Data'}</span><button class="btn-extract-edit" title="Toggle edit mode">Edit</button></div>
      <div class="extraction-card-body">${rows}</div>
      <div class="extraction-card-add-row" style="display:none"><button class="btn-extract-add-row">+ Add row</button></div>
      <div class="extraction-card-footer">
        <button class="btn-extract-action" data-action="copy-all">Copy All</button>
        <button class="btn-extract-action" data-action="export-csv">CSV</button>
        <button class="btn-extract-action" data-action="export-json">JSON</button>
        <button class="btn-extract-action" data-action="export-md">Markdown</button>
      </div>
    </div>`
  }

  let result = html.replace(re, (_m, title: string, body: string) => buildCard(title || '', body))
  result = result.replace(rawRe, (_m, title: string, body: string) => buildCard(title || '', body))
  return result
}

// ─── Workflow Tag Parser (V3: FR-V3-1) ──────────────────────────────────────

function parseWorkflowBlocks(html: string): string {
  const re = /\[WORKFLOW\]([\s\S]*?)\[\/WORKFLOW\]/g
  return html.replace(re, (_m, body: string) => {
    const decoded = body.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    const nameMatch = decoded.match(/name:\s*(.+)/i)
    const descMatch = decoded.match(/description:\s*(.+)/i)
    const name = nameMatch?.[1]?.trim() ?? 'Unnamed Workflow'
    const desc = descMatch?.[1]?.trim() ?? ''
    const stepLines = decoded.match(/^-\s+type:\s*\w+.*$/gim) || []
    return `<div class="workflow-save-card">
      <div class="workflow-save-header">Workflow: ${escapeForAttr(name)}</div>
      ${desc ? `<div class="workflow-save-desc">${escapeForAttr(desc)}</div>` : ''}
      <div class="workflow-save-steps">${stepLines.length} step${stepLines.length !== 1 ? 's' : ''}</div>
      <button class="btn-small btn-primary btn-save-workflow" data-wf-raw="${escapeForAttr(decoded)}">Save Workflow</button>
    </div>`
  })
}

function escapeForAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function attachWorkflowSaveHandlers(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('.btn-save-workflow').forEach(btn => {
    btn.addEventListener('click', async () => {
      const raw = btn.dataset.wfRaw ?? ''
      const { parseWorkflowTag } = await import('../background/workflow-engine')
      const parsed = parseWorkflowTag(raw)
      if (!parsed || !parsed.name) return
      const wf = {
        id: crypto.randomUUID(),
        name: parsed.name,
        description: parsed.description,
        steps: parsed.steps ?? [],
        executionMode: 'approve' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await chrome.runtime.sendMessage({ type: MSG.SAVE_WORKFLOW, workflow: wf })
      btn.textContent = 'Saved!'
      btn.disabled = true
    })
  })
}

// ─── Comparison Card Parser (Spec 10.6) ──────────────────────────────────────

function parseComparisonBlocks(html: string): string {
  // Match [COMPARE title="..."]header1|header2\ncriterion|val1|val2\n...[/COMPARE]
  const re = /\[COMPARE(?:\s+title=&quot;([^&]*)&quot;)?\]([\s\S]*?)\[\/COMPARE\]/g
  const rawRe = /\[COMPARE(?:\s+title="([^"]*)")?\]([\s\S]*?)\[\/COMPARE\]/g

  function buildCompareCard(title: string, body: string): string {
    const lines = body.split('\n').filter(l => l.trim())
    if (lines.length < 2) return body

    const headers = lines[0].split('|').map(h => h.trim())
    const rows = lines.slice(1)

    // Check for recommendation line (starts with ">" or "Recommendation:")
    let recommendation = ''
    const dataRows: string[] = []
    for (const row of rows) {
      if (row.startsWith('>') || row.toLowerCase().startsWith('recommendation:')) {
        recommendation = row.replace(/^>\s*/, '').replace(/^recommendation:\s*/i, '')
      } else {
        dataRows.push(row)
      }
    }

    const headerHtml = headers.map((h, i) => `<th class="compare-sortable" data-col="${i}">${h} <span class="sort-arrow"></span></th>`).join('')
    const bodyHtml = dataRows.map(row => {
      const cells = row.split('|').map(c => c.trim())
      return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`
    }).join('')

    const recHtml = recommendation
      ? `<div class="compare-recommendation"><strong>Recommendation:</strong> ${recommendation}</div>`
      : ''

    // V3: Advanced compare workspace (FR-V3-6)
    const hasMultipleOptions = headers.length > 2 // criteria + at least 2 options
    const scoreHtml = hasMultipleOptions
      ? `<div class="compare-scores" style="display:none"></div>`
      : ''

    return `<div class="compare-card" data-headers="${headers.map(h => h.replace(/"/g, '&quot;')).join('|')}">
      <div class="compare-card-header">
        <span>${title || 'Comparison'}</span>
        ${hasMultipleOptions ? '<button class="btn-compare-score btn-small" title="Compute weighted scores">Score</button>' : ''}
      </div>
      <div class="compare-filter-bar"><input type="text" class="compare-filter-input" placeholder="Filter rows..." /></div>
      <div class="compare-matrix"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>
      ${scoreHtml}
      ${recHtml}
      <div class="compare-card-footer">
        <button class="btn-extract-action" data-action="copy-all">Copy</button>
        <button class="btn-extract-action" data-action="export-csv">CSV</button>
        <button class="btn-extract-action" data-action="export-json">JSON</button>
        <button class="btn-extract-action" data-action="export-md">Markdown</button>
      </div>
    </div>`
  }

  let result = html.replace(re, (_m, title: string, body: string) => buildCompareCard(title || '', body))
  result = result.replace(rawRe, (_m, title: string, body: string) => buildCompareCard(title || '', body))
  return result
}

// ─── Pinned Fact Tag Parser (V2 FR-V2-6) ────────────────────────────────────

function parsePinBlocks(html: string): { html: string; pins: Array<{ label: string; value: string }> } {
  const pins: Array<{ label: string; value: string }> = []
  const re = /\[PIN\](.*?)\[\/PIN\]/gi
  const cleaned = html.replace(re, (_m, body: string) => {
    const sep = body.indexOf(':')
    if (sep === -1) return body
    const label = body.slice(0, sep).trim()
    const value = body.slice(sep + 1).trim()
    if (label && value) {
      pins.push({ label, value })
      return `<span class="pin-inline" data-pin-label="${label.replace(/"/g, '&quot;')}" data-pin-value="${value.replace(/"/g, '&quot;')}">${label}: ${value} <button class="btn-pin-save" title="Pin this value">&#x1F4CC;</button></span>`
    }
    return body
  })
  return { html: cleaned, pins }
}

// ─── Follow-up Chips Parser (Spec 10.2.5) ────────────────────────────────────

function parseFollowUpChips(html: string): { html: string; chips: string[] } {
  const chips: string[] = []
  // Match [FOLLOWUP]chip1|chip2|chip3[/FOLLOWUP]
  const re = /\[FOLLOWUP\](.*?)\[\/FOLLOWUP\]/gi
  const cleaned = html.replace(re, (_m, body: string) => {
    body.split('|').map(c => c.trim()).filter(Boolean).forEach(c => {
      if (!chips.includes(c)) chips.push(c)
    })
    return ''
  })
  return { html: cleaned, chips }
}

function renderFollowUpChips(chips: string[]): string {
  if (chips.length === 0) return ''
  const items = chips.map(c =>
    `<button class="followup-chip">${c.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</button>`
  ).join('')
  return `<div class="followup-chips">${items}</div>`
}

// ─── Message Type Parser (PRD 7) ──────────────────────────────────────────────

const MSG_TYPE_RE = /\[MSG_TYPE:(warning|clarification|system)\]/gi

function parseMessageType(html: string): { html: string; msgType: string | null } {
  let msgType: string | null = null
  const cleaned = html.replace(MSG_TYPE_RE, (_match, type: string) => {
    msgType = type.toLowerCase()
    return ''
  })
  return { html: cleaned, msgType }
}

// ─── Slash Commands (PRD 6.1D) ────────────────────────────────────────────────

interface SlashCommand {
  cmd: string
  label: string
  prompt: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/summarize', label: 'Summarize page', prompt: 'Summarize this page concisely.' },
  { cmd: '/extract', label: 'Extract key data', prompt: 'Extract the key structured data from this page (prices, dates, contacts, links, etc.) using [EXTRACT] cards.' },
  { cmd: '/explain', label: 'Explain this', prompt: 'Explain the main content of this page in simple terms.' },
  { cmd: '/fill', label: 'Fill form', prompt: 'Please fill the form on this page using my vault data.' },
  { cmd: '/compare', label: 'Compare options', prompt: 'Compare the main options/plans/products on this page using a [COMPARE] card with a structured matrix.' },
  { cmd: '/watch', label: 'Watch for changes', prompt: 'Watch this page for any meaningful changes and notify me.' },
  { cmd: '/scan', label: 'Rescan page', prompt: 'Rescan this page and tell me what you see now.' },
  { cmd: '/debug', label: 'Debug issues', prompt: 'Inspect this page for issues: disabled buttons, missing fields, validation errors, or broken elements. Explain why things are broken.' },
  { cmd: '/navigate', label: 'Help navigate', prompt: 'Help me find the key navigation options and important sections on this page.' },
  { cmd: '/actions', label: 'Find action items', prompt: 'What are the key action items or things I need to do on this page?' },
  { cmd: '/highlight', label: 'Highlight elements', prompt: 'Highlight the most important interactive elements on this page using [REF] tags so I can see them.' },
  { cmd: '/simplify', label: 'Simplify jargon', prompt: 'Identify and explain any jargon, legal language, or technical terms on this page in plain language.' },
  { cmd: '/history', label: 'Session history', prompt: 'Show me a summary of what we have discussed and done in this session so far.' },
  { cmd: '/plan', label: 'Plan task', prompt: 'Help me plan how to complete the main task on this page. Break it into clear steps.' },
  { cmd: '/why', label: 'Why is this broken?', prompt: 'Why can\'t I proceed? Analyze the form/page for disabled buttons, missing required fields, validation errors, or hidden blockers.' },
  { cmd: '/translate', label: 'Translate selection', prompt: 'Translate the selected text or main content to English, preserving meaning and context.' },
  { cmd: '/tabs', label: 'List open tabs', prompt: 'List my open tabs and give a brief summary of what each one contains.' },
  { cmd: '/pin', label: 'Pin key fact', prompt: 'Identify the single most important fact, value, or data point from the current page context and highlight it clearly for me to remember.' },
  { cmd: '/run', label: 'Execute next step', prompt: 'Execute the next logical step or the last proposed action for the current task.' },
  { cmd: '/workflow', label: 'Manage workflows', prompt: '__WORKFLOW_PANEL__' },
]

// ─── Context Bar State ────────────────────────────────────────────────────────

let lastScanTimestamp = 0
let currentScanMode = 'none'
let currentContextType = 'page'
let currentExplanationDepth: 'quick' | 'standard' | 'deep' = 'standard'

let drawerAutoCollapseTimer: ReturnType<typeof setTimeout> | null = null

/** Auto-expand the smart status drawer when something notable happens, collapse after 5s */
function autoExpandDrawer(state: TabChatState, reason?: string): void {
  const drawer = state.container.querySelector<HTMLElement>('.smart-status-drawer-tab')
  const expandBtn = state.container.querySelector<HTMLElement>('.smart-status-expand-tab')
  if (!drawer) return
  drawer.style.display = ''
  if (expandBtn) expandBtn.classList.add('open')

  // Auto-collapse after 5 seconds
  if (drawerAutoCollapseTimer) clearTimeout(drawerAutoCollapseTimer)
  drawerAutoCollapseTimer = setTimeout(() => {
    drawer.style.display = 'none'
    if (expandBtn) expandBtn.classList.remove('open')
    drawerAutoCollapseTimer = null
  }, 5000)
}

function updateSmartStatus(state: TabChatState): void {
  const dot = state.container.querySelector(`#status-dot-${state.tabId}`) as HTMLElement | null
  const text = state.container.querySelector(`#status-text-${state.tabId}`) as HTMLElement | null
  const watchEl = state.container.querySelector(`#watch-indicator-${state.tabId}`) as HTMLElement | null

  if (!dot || !text) return

  const isWatching = watchEl?.style.display !== 'none' && watchEl?.style.display !== undefined && watchEl?.style.display !== ''
  // Actually check if watch indicator was made visible (no style.display means hidden since we set style="display:none" initially)
  const watchVisible = watchEl ? (watchEl.style.display === '') : false
  const hasCrossTabs = selectedCrossTabIds.length > 0
  const elapsed = lastScanTimestamp ? Math.round((Date.now() - lastScanTimestamp) / 1000) : -1

  // Priority-based status: watch > selection > cross-tabs > scan freshness > ready
  if (watchVisible) {
    dot.className = 'smart-status-dot watching'
    text.textContent = 'Watching for changes'
  } else if (currentContextType === 'selection') {
    dot.className = 'smart-status-dot fresh'
    text.textContent = 'Selection captured'
  } else if (hasCrossTabs) {
    dot.className = 'smart-status-dot fresh'
    text.textContent = `Comparing ${selectedCrossTabIds.length + 1} tabs`
  } else if (elapsed < 0) {
    dot.className = 'smart-status-dot none'
    text.textContent = 'Ready'
  } else if (elapsed < 30) {
    dot.className = 'smart-status-dot fresh'
    text.textContent = 'Page scanned'
  } else if (elapsed < 120) {
    dot.className = 'smart-status-dot stale'
    text.textContent = 'Page data may be outdated'
  } else {
    dot.className = 'smart-status-dot stale'
    text.textContent = 'Page data is stale'
  }
}

/** Show selection-aware action chips when user selects text on page (PRD 8.1.5) */
function showSelectionChips(state: TabChatState, selectedText: string): void {
  const bar = state.container.querySelector<HTMLElement>('.selection-chips-tab')
  if (!bar) return

  if (!selectedText || selectedText.trim().length === 0) {
    bar.style.display = 'none'
    return
  }

  const truncated = selectedText.length > 60 ? selectedText.slice(0, 57) + '...' : selectedText
  bar.style.display = 'flex'
  bar.innerHTML = `<span class="selection-chips-label" title="${selectedText.replace(/"/g, '&quot;').slice(0, 200)}">"\u200B${truncated}\u200B"</span>`

  const actions = [
    { label: 'Explain', prompt: `Explain this selected text simply:\n"${selectedText}"` },
    { label: 'Simplify', prompt: `Simplify this selected text to be easy to understand:\n"${selectedText}"` },
    { label: 'Translate', prompt: `Translate this selected text to English:\n"${selectedText}"` },
    { label: 'Fact-check', prompt: `Fact-check this selected text. Is it accurate?\n"${selectedText}"` },
    { label: 'Rewrite', prompt: `Rewrite this selected text to be clearer and more concise:\n"${selectedText}"` },
    { label: 'Use as context', prompt: `Use this selected text as the primary context for our conversation:\n"${selectedText}"` },
  ]

  for (const a of actions) {
    const chip = document.createElement('button')
    chip.className = 'selection-chip'
    chip.textContent = a.label
    chip.addEventListener('click', () => {
      getInput(state).value = a.prompt
      sendMessage(state)
      bar.style.display = 'none'
    })
    bar.appendChild(chip)
  }
}

/** Render for streaming chunks — no thinking extraction (avoids flicker). */
function renderStreamingHTML(text: string): { html: string; widgets: Widget[] } {
  let cleaned = text
    .replace(/\[ACTION:\w+[^\]]*\]/g, '')
    .replace(/\{[^{}]*"action"\s*:\s*"(?:click|type|scroll_down|scroll_up|wait)"[^{}]*\}/g, '')
  cleaned = sanitizeModelOutput(cleaned)
  let html = sanitizeHtml(renderMarkdown(cleaned))
  html = parseActionResults(html)
  const { html: widgetHtml, widgets } = parseWidgets(html)
  return { html: widgetHtml, widgets }
}

/** Render for finalized messages — includes thinking extraction. */
function renderAssistantHTML(text: string): { html: string; widgets: Widget[]; sources: string[]; msgType: string | null; followUpChips: string[] } {
  if (!text) return { html: '', widgets: [], sources: [], msgType: null, followUpChips: [] }
  let cleaned = text
    .replace(/\[ACTION:\w+[^\]]*\]/g, '')
    .replace(/\{[^{}]*"action"\s*:\s*"(?:click|type|scroll_down|scroll_up|wait)"[^{}]*\}/g, '')
  cleaned = sanitizeModelOutput(cleaned)

  // Extract thinking and render separately
  const { thinking, answer } = extractThinking(cleaned)

  let html = ''
  if (thinking) {
    const thinkingHtml = sanitizeHtml(renderMarkdown(thinking))
    html += `<details class="thinking-block"><summary class="thinking-summary"><span class="thinking-dot"></span> Thinking</summary><div class="thinking-content">${thinkingHtml}</div></details>`
  }
  html += sanitizeHtml(renderMarkdown(answer))

  // Parse new PRD features: source labels, message types, page refs, extraction/comparison cards, follow-ups
  const { html: sourceHtml, sources } = parseSourceLabels(html)
  const { html: typeHtml, msgType } = parseMessageType(sourceHtml)
  const { html: chipHtml, chips: followUpChips } = parseFollowUpChips(typeHtml)
  let finalHtml = parsePageReferences(chipHtml)
  finalHtml = parseExtractionBlocks(finalHtml)
  finalHtml = parseWorkflowBlocks(finalHtml)
  finalHtml = parseComparisonBlocks(finalHtml)
  const { html: pinParsedHtml, pins: parsedPins } = parsePinBlocks(finalHtml)
  finalHtml = parseActionResults(pinParsedHtml)
  void parsedPins // pins are handled via click handler on .btn-pin-save

  // Add source grounding badges
  if (sources.length > 0) {
    finalHtml += renderSourceBadges(sources)
  }

  // Add follow-up suggestion chips
  if (followUpChips.length > 0) {
    finalHtml += renderFollowUpChips(followUpChips)
  }

  const { html: widgetHtml, widgets } = parseWidgets(finalHtml)
  return { html: widgetHtml, widgets, sources, msgType, followUpChips }
}

function addBubble(state: TabChatState, role: 'user' | 'assistant', text: string): HTMLElement {
  const safeText = text ?? ''
  const messagesEl = getMessages(state)
  const welcome = messagesEl.querySelector('.welcome-msg-tab')
  if (welcome) welcome.remove()
  const analyzing = messagesEl.querySelector('.analyzing-state-tab')
  if (analyzing) analyzing.remove()

  const div = document.createElement('div')
  div.className = `message message-${role}`
  div.dataset.time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (role === 'assistant') {
    const { html, widgets, msgType } = renderAssistantHTML(safeText)
    // Apply message type styling (PRD 7)
    if (msgType === 'warning') {
      div.className = 'message message-assistant message-warning'
    } else if (msgType === 'clarification') {
      div.className = 'message message-assistant message-clarification'
    } else if (msgType === 'system') {
      div.className = 'message message-system-status'
    }
    div.innerHTML = html
    renderWidgetsInContainer(div, widgets)
    attachWidgetHandlers(div, (_wid, val) => handleWidgetChoice(state, val))
    addMessageActions(state, div, safeText)
    addCodeBlockCopyButtons(div)
    enhanceLinks(div)
    attachPageRefHandlers(state, div)
    attachExtractionCardHandlers(div)
    attachFollowUpChipHandlers(state, div)
    attachPinSaveHandlers(state, div)
    attachWorkflowSaveHandlers(div)
    applyLongAnswerCollapse(div)
  } else {
    div.textContent = safeText
    addUserMessageActions(state, div, safeText)
  }

  messagesEl.appendChild(div)
  scrollToBottom(messagesEl, role === 'user')  // force for user messages, smart for assistant
  return div
}

/** Add copy/repeat action buttons to user messages */
function addUserMessageActions(state: TabChatState, bubble: HTMLElement, text: string): void {
  const bar = document.createElement('div')
  bar.className = 'user-msg-actions'
  bar.innerHTML = `
    <button class="user-msg-btn btn-user-copy" title="Copy">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
    </button>
    <button class="user-msg-btn btn-user-repeat" title="Repeat">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
    </button>
  `
  bar.querySelector('.btn-user-copy')!.addEventListener('click', () => {
    navigator.clipboard.writeText(text).catch(() => {})
    const btn = bar.querySelector('.btn-user-copy')!
    btn.textContent = 'Copied'
    setTimeout(() => { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' }, 1500)
  })
  bar.querySelector('.btn-user-repeat')!.addEventListener('click', () => {
    getInput(state).value = text
    sendMessage(state)
  })
  bubble.appendChild(bar)
}

/** Attach click handlers to [REF:selector] elements — scrolls + highlights on page (PRD 8.1.7) */
function attachPageRefHandlers(state: TabChatState, container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.page-ref').forEach(ref => {
    ref.addEventListener('click', () => {
      const selector = ref.dataset.selector
      if (!selector) return
      chrome.tabs.sendMessage(state.tabId, {
        type: MSG.HIGHLIGHT_FIELD,
        selector,
      }).catch(() => {})
    })
  })
}

/** Attach handlers to extraction card buttons — copy/export (PRD 8.1.8) */
function attachExtractionCardHandlers(container: HTMLElement): void {
  // Per-row copy buttons
  container.querySelectorAll<HTMLButtonElement>('.extraction-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.extraction-row')
      if (!row) return
      const val = row.querySelector('.extraction-value')?.textContent || ''
      const key = row.querySelector('.extraction-key')?.textContent || ''
      navigator.clipboard.writeText(key ? `${key}: ${val}` : val).then(() => {
        btn.textContent = '\u2713'
        setTimeout(() => { btn.innerHTML = '&#x2398;' }, 1200)
      })
    })
  })

  // ── Editable extraction (V3: FR-V3-3) ──
  container.querySelectorAll<HTMLButtonElement>('.btn-extract-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.extraction-card')
      if (!card) return
      const isEditing = card.classList.toggle('editing')
      btn.textContent = isEditing ? 'Done' : 'Edit'
      card.querySelectorAll<HTMLElement>('.extraction-key, .extraction-value').forEach(el => {
        el.contentEditable = isEditing ? 'true' : 'false'
      })
      const addRow = card.querySelector<HTMLElement>('.extraction-card-add-row')
      if (addRow) addRow.style.display = isEditing ? '' : 'none'
      card.querySelectorAll<HTMLElement>('.extraction-row-delete').forEach(el => {
        el.style.display = isEditing ? '' : 'none'
      })
    })
  })

  container.querySelectorAll<HTMLButtonElement>('.extraction-row-delete').forEach(btn => {
    btn.style.display = 'none' // hidden until edit mode
    btn.addEventListener('click', () => {
      btn.closest('.extraction-row')?.remove()
    })
  })

  container.querySelectorAll<HTMLButtonElement>('.btn-extract-add-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.extraction-card')
      if (!card) return
      const body = card.querySelector('.extraction-card-body')
      if (!body) return
      const row = document.createElement('div')
      row.className = 'extraction-row'
      row.innerHTML = `<span class="extraction-key" contenteditable="true">Key</span><span class="extraction-value" contenteditable="true">Value</span><button class="extraction-copy-btn" title="Copy">&#x2398;</button><button class="extraction-row-delete" title="Delete row">&times;</button>`
      row.querySelector('.extraction-row-delete')!.addEventListener('click', () => row.remove())
      row.querySelector('.extraction-copy-btn')!.addEventListener('click', () => {
        const k = row.querySelector('.extraction-key')?.textContent || ''
        const v = row.querySelector('.extraction-value')?.textContent || ''
        navigator.clipboard.writeText(k ? `${k}: ${v}` : v)
      })
      body.appendChild(row)
    })
  })

  // Card-level actions: Copy All, CSV, JSON, Markdown (with file download for CSV/JSON)
  container.querySelectorAll<HTMLButtonElement>('.btn-extract-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.extraction-card')
      if (!card) return
      const rows = Array.from(card.querySelectorAll('.extraction-row'))
      const data = rows.map(r => ({
        key: r.querySelector('.extraction-key')?.textContent?.trim() || '',
        value: r.querySelector('.extraction-value')?.textContent?.trim() || '',
      }))

      const action = btn.dataset.action
      let output = ''
      let filename = ''
      let mime = 'text/plain'

      if (action === 'copy-all') {
        output = data.map(d => d.key ? `${d.key}: ${d.value}` : d.value).join('\n')
      } else if (action === 'export-csv') {
        output = 'Key,Value\n' + data.map(d => `"${d.key.replace(/"/g, '""')}","${d.value.replace(/"/g, '""')}"`).join('\n')
        filename = 'extraction.csv'
        mime = 'text/csv'
      } else if (action === 'export-json') {
        const obj: Record<string, string> = {}
        data.forEach(d => { if (d.key) obj[d.key] = d.value; else obj[d.value] = '' })
        output = JSON.stringify(obj, null, 2)
        filename = 'extraction.json'
        mime = 'application/json'
      } else if (action === 'export-md') {
        // Check if this is a comparison card (has a table) or extraction card
        const table = card.querySelector('table')
        if (table) {
          const ths = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent?.trim() || '')
          const trs = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
            Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || '')
          )
          output = `| ${ths.join(' | ')} |\n| ${ths.map(() => '---').join(' | ')} |\n`
          output += trs.map(cells => `| ${cells.join(' | ')} |`).join('\n')
        } else {
          output = `| Key | Value |\n| --- | --- |\n`
          output += data.map(d => `| ${d.key} | ${d.value} |`).join('\n')
        }
        filename = 'extraction.md'
      }

      if (filename && action !== 'copy-all') {
        // Download as file
        const blob = new Blob([output], { type: mime })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        const orig = btn.textContent
        btn.textContent = 'Saved!'
        setTimeout(() => { btn.textContent = orig }, 1500)
      } else {
        navigator.clipboard.writeText(output).then(() => {
          const orig = btn.textContent
          btn.textContent = 'Copied!'
          setTimeout(() => { btn.textContent = orig }, 1500)
        })
      }
    })
  })

  // Comparison card actions (same class, different parent)
  container.querySelectorAll<HTMLButtonElement>('.compare-card .btn-extract-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.compare-card')
      if (!card) return
      const table = card.querySelector('table')
      if (!table) return

      const ths = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent?.trim() || '')
      const trs = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || '')
      )

      const action = btn.dataset.action
      let output = ''
      if (action === 'copy-all') {
        output = ths.join('\t') + '\n' + trs.map(cells => cells.join('\t')).join('\n')
      } else if (action === 'export-csv') {
        output = ths.map(h => `"${h}"`).join(',') + '\n' + trs.map(cells => cells.map(c => `"${c}"`).join(',')).join('\n')
      } else if (action === 'export-md') {
        output = `| ${ths.join(' | ')} |\n| ${ths.map(() => '---').join(' | ')} |\n`
        output += trs.map(cells => `| ${cells.join(' | ')} |`).join('\n')
      }
      if (output) {
        const isFile = action === 'export-csv' || action === 'export-json'
        if (isFile) {
          const mime = action === 'export-csv' ? 'text/csv' : 'application/json'
          const ext = action === 'export-csv' ? 'csv' : 'json'
          const blob = new Blob([output], { type: mime })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = `comparison.${ext}`; a.click()
          URL.revokeObjectURL(url)
          const orig = btn.textContent; btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = orig }, 1500)
        } else {
          navigator.clipboard.writeText(output).then(() => {
            const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig }, 1500)
          })
        }
      }
    })
  })

  // V3: Advanced compare workspace — sortable columns, filter, scoring (FR-V3-6)
  container.querySelectorAll<HTMLElement>('.compare-card').forEach(card => {
    // Sortable columns
    card.querySelectorAll<HTMLElement>('.compare-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const colIdx = parseInt(th.dataset.col!, 10)
        const tbody = card.querySelector('tbody')
        if (!tbody) return
        const rows = Array.from(tbody.querySelectorAll('tr'))
        const asc = th.dataset.sortDir !== 'asc'
        th.dataset.sortDir = asc ? 'asc' : 'desc'
        // Reset other arrows
        card.querySelectorAll('.sort-arrow').forEach(a => { a.textContent = '' })
        const arrow = th.querySelector('.sort-arrow')
        if (arrow) arrow.textContent = asc ? ' \u25B2' : ' \u25BC'
        rows.sort((a, b) => {
          const aText = a.querySelectorAll('td')[colIdx]?.textContent?.trim() ?? ''
          const bText = b.querySelectorAll('td')[colIdx]?.textContent?.trim() ?? ''
          const aNum = parseFloat(aText.replace(/[^0-9.\-]/g, ''))
          const bNum = parseFloat(bText.replace(/[^0-9.\-]/g, ''))
          if (!isNaN(aNum) && !isNaN(bNum)) return asc ? aNum - bNum : bNum - aNum
          return asc ? aText.localeCompare(bText) : bText.localeCompare(aText)
        })
        rows.forEach(r => tbody.appendChild(r))
      })
    })

    // Filter bar
    const filterInput = card.querySelector<HTMLInputElement>('.compare-filter-input')
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        const q = filterInput.value.toLowerCase()
        card.querySelectorAll('tbody tr').forEach(tr => {
          const text = tr.textContent?.toLowerCase() ?? ''
          ;(tr as HTMLElement).style.display = q && !text.includes(q) ? 'none' : ''
        })
      })
    }

    // Score button
    const scoreBtn = card.querySelector<HTMLButtonElement>('.btn-compare-score')
    if (scoreBtn) {
      scoreBtn.addEventListener('click', () => {
        const scoresEl = card.querySelector<HTMLElement>('.compare-scores')
        if (!scoresEl) return
        const isVisible = scoresEl.style.display !== 'none'
        if (isVisible) { scoresEl.style.display = 'none'; return }
        scoresEl.style.display = ''
        const table = card.querySelector('table')
        if (!table) return
        const ths = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent?.replace(/[^\w\s]/g, '').trim() ?? '')
        const trs = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
          Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '')
        )
        if (ths.length < 3 || trs.length === 0) return
        // Compute scores: each row is a criterion, columns 1+ are options
        const optionNames = ths.slice(1)
        const scores = new Array(optionNames.length).fill(0)
        for (const row of trs) {
          const vals = row.slice(1).map(v => parseFloat(v.replace(/[^0-9.\-]/g, '')))
          const allNumeric = vals.every(v => !isNaN(v))
          if (allNumeric && vals.length > 0) {
            const min = Math.min(...vals), max = Math.max(...vals)
            const range = max - min || 1
            vals.forEach((v, i) => { scores[i] += (v - min) / range })
          }
        }
        // Find best
        const maxScore = Math.max(...scores)
        scoresEl.innerHTML = `<div class="compare-scores-header">Weighted Scores</div>` +
          optionNames.map((name, i) =>
            `<div class="compare-score-row${scores[i] === maxScore ? ' compare-best' : ''}">`+
            `<span class="compare-score-name">${name}</span>`+
            `<span class="compare-score-val">${scores[i].toFixed(2)}</span>`+
            `${scores[i] === maxScore ? '<span class="compare-score-badge">Best</span>' : ''}`+
            `</div>`
          ).join('')
        // Highlight best column in table
        table.querySelectorAll('td, th').forEach(el => el.classList.remove('compare-highlight'))
        const bestCol = scores.indexOf(maxScore) + 1
        table.querySelectorAll('thead th').forEach((th, i) => { if (i === bestCol) th.classList.add('compare-highlight') })
        table.querySelectorAll('tbody tr').forEach(tr => {
          tr.querySelectorAll('td').forEach((td, i) => { if (i === bestCol) td.classList.add('compare-highlight') })
        })
      })
    }
  })
}

/** Attach click handlers to follow-up suggestion chips — sends chip text as new message */
function attachFollowUpChipHandlers(state: TabChatState, container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('.followup-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const text = chip.textContent?.trim()
      if (!text) return
      const inputEl = getInput(state)
      inputEl.value = text
      sendMessage(state)
    })
  })
}

/**
 * Auto-generate follow-up chips when the AI response doesn't include [FOLLOWUP] tags.
 * Detects patterns in the response text and suggests relevant next actions.
 */
function autoGenerateFollowUps(state: TabChatState, bubble: HTMLElement, responseText: string, existingChips: string[]): void {
  // Skip if AI already provided follow-ups
  if (existingChips.length > 0) return
  // Skip short/medium responses — only suggest for substantial page-aware answers
  if (responseText.length < 400) return

  const chips: string[] = []

  // Pattern: response has a clear comparison structure (tables, vs, multiple items with prices)
  if (/\b(\$\d|\d+\s*€|price|cost)\b/i.test(responseText) && /\b(vs\.?|compared|cheaper|expensive|plan|tier)\b/i.test(responseText) && chips.length < 3) {
    chips.push('Compare options')
  }
  // Pattern: response gave multi-step instructions → offer to automate
  if (/\b(step \d|1\.\s|first,.*then,|navigate to|click on|go to)\b/i.test(responseText) && chips.length < 3) {
    chips.push('Do it for me')
  }
  // Pattern: very long informational response → summarize
  if (responseText.length > 1200 && chips.length < 3) {
    chips.push('Summarize shorter')
  }

  if (chips.length === 0) return

  // Render chips
  const chipsDiv = document.createElement('div')
  chipsDiv.className = 'followup-chips followup-chips-auto'
  chips.forEach(label => {
    const btn = document.createElement('button')
    btn.className = 'followup-chip'
    btn.textContent = label
    btn.addEventListener('click', () => {
      const inputEl = getInput(state)
      inputEl.value = label
      sendMessage(state)
    })
    chipsDiv.appendChild(btn)
  })
  bubble.appendChild(chipsDiv)
}

/** Render cross-tab comparison chips below the context bar */
function renderCrossTabChips(state: TabChatState): void {
  let bar = state.container.querySelector<HTMLElement>('.cross-tab-chips')
  if (!bar) {
    bar = document.createElement('div')
    bar.className = 'cross-tab-chips'
    const statusDrawer = state.container.querySelector('.smart-status-drawer-tab') ?? state.container.querySelector('.smart-status-tab')
    if (statusDrawer) statusDrawer.after(bar)
    else return
  }
  if (selectedCrossTabIds.length === 0) {
    bar.remove()
    return
  }
  bar.innerHTML = ''
  for (const tabId of selectedCrossTabIds) {
    chrome.tabs.get(tabId).then(tab => {
      const chip = document.createElement('span')
      chip.className = 'cross-tab-chip'
      chip.innerHTML = `Tab: ${(tab.title || '').slice(0, 25)} <button class="cross-tab-chip-remove" data-tab-id="${tabId}">&times;</button>`
      chip.querySelector('.cross-tab-chip-remove')?.addEventListener('click', () => {
        const idx = selectedCrossTabIds.indexOf(tabId)
        if (idx !== -1) selectedCrossTabIds.splice(idx, 1)
        renderCrossTabChips(state)
      })
      bar!.appendChild(chip)
    }).catch(() => {})
  }
}

/** Attach click handlers to pin save buttons — saves fact to IDB and refreshes bar */
function attachPinSaveHandlers(state: TabChatState, container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('.btn-pin-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const span = btn.closest('.pin-inline') as HTMLElement | null
      if (!span) return
      const label = span.dataset.pinLabel || ''
      const value = span.dataset.pinValue || ''
      if (!label || !value) return
      const fact = {
        id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: state.sessionId,
        label,
        value,
        sourceUrl: state.domain || '',
        pinnedAt: Date.now(),
      }
      chrome.runtime.sendMessage({ type: 'PIN_FACT', fact }).then(() => {
        btn.textContent = '\u2713'
        btn.disabled = true
        refreshPinnedFactsBar(state)
      }).catch(() => {})
    })
  })
}

/** Refresh the pinned facts bar for a tab */
function refreshPinnedFactsBar(state: TabChatState): void {
  const bar = document.getElementById(`pinned-facts-bar-${state.tabId}`)
  if (!bar) return
  chrome.runtime.sendMessage({ type: 'GET_PINS' }).then((resp: { ok?: boolean; facts?: Array<{ id: string; label: string; value: string }> }) => {
    if (!resp?.ok || !resp.facts || resp.facts.length === 0) {
      bar.style.display = 'none'
      bar.innerHTML = ''
      return
    }
    bar.style.display = 'flex'
    const MAX_VISIBLE = 3
    const facts = resp.facts
    const visible = facts.slice(0, MAX_VISIBLE)
    const overflow = facts.length - MAX_VISIBLE

    bar.innerHTML = visible.map(f =>
      `<span class="pinned-chip" data-pin-id="${f.id}" title="${f.label}: ${f.value}">` +
      `<span class="pinned-chip-label">${f.label}:</span> ${f.value}` +
      `<button class="pinned-chip-remove" title="Unpin">&times;</button></span>`
    ).join('') + (overflow > 0 ? `<span class="pinned-chip pinned-chip-more">+${overflow} more</span>` : '')

    // Attach remove handlers
    bar.querySelectorAll<HTMLButtonElement>('.pinned-chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const chip = btn.closest('.pinned-chip') as HTMLElement | null
        const pinId = chip?.dataset.pinId
        if (!pinId) return
        chrome.runtime.sendMessage({ type: 'UNPIN_FACT', id: pinId }).then(() => {
          refreshPinnedFactsBar(state)
        }).catch(() => {})
      })
    })

    // Click chip to copy value
    bar.querySelectorAll<HTMLElement>('.pinned-chip:not(.pinned-chip-more)').forEach(chip => {
      chip.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('pinned-chip-remove')) return
        const id = chip.dataset.pinId
        const fact = facts.find(f => f.id === id)
        if (fact) {
          navigator.clipboard.writeText(fact.value).then(() => {
            chip.classList.add('pinned-chip-copied')
            setTimeout(() => chip.classList.remove('pinned-chip-copied'), 1000)
          }).catch(() => {})
        }
      })
    })

    // Click "+N more" to expand
    const moreChip = bar.querySelector('.pinned-chip-more')
    if (moreChip) {
      moreChip.addEventListener('click', () => {
        // Re-render with all facts visible
        bar.innerHTML = facts.map(f =>
          `<span class="pinned-chip" data-pin-id="${f.id}" title="${f.label}: ${f.value}">` +
          `<span class="pinned-chip-label">${f.label}:</span> ${f.value}` +
          `<button class="pinned-chip-remove" title="Unpin">&times;</button></span>`
        ).join('')
        // Re-attach handlers
        bar.querySelectorAll<HTMLButtonElement>('.pinned-chip-remove').forEach(btn => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation()
            const chip = btn.closest('.pinned-chip') as HTMLElement | null
            const pinId = chip?.dataset.pinId
            if (pinId) chrome.runtime.sendMessage({ type: 'UNPIN_FACT', id: pinId }).then(() => refreshPinnedFactsBar(state)).catch(() => {})
          })
        })
      })
    }
  }).catch(() => {})
}

/** Collapse long assistant messages with expand/collapse toggle (Spec 11.3.2) */
function applyLongAnswerCollapse(container: HTMLElement): void {
  // Only collapse if content exceeds ~350px worth of text (roughly 15 lines)
  requestAnimationFrame(() => {
    if (container.scrollHeight <= 400) return
    // Don't collapse messages that are primarily cards/widgets
    const cards = container.querySelectorAll('.extraction-card, .compare-card, .confirm-action-card, .form-assist-card')
    if (cards.length > 0 && container.querySelectorAll('p, li, h1, h2, h3').length < 5) return

    container.classList.add('message-collapsible', 'collapsed')
    const btn = document.createElement('button')
    btn.className = 'message-expand-btn'
    btn.textContent = 'Show full response'
    btn.addEventListener('click', () => {
      const isCollapsed = container.classList.contains('collapsed')
      container.classList.toggle('collapsed', !isCollapsed)
      btn.textContent = isCollapsed ? 'Collapse' : 'Show full response'
    })
    container.parentElement?.insertBefore(btn, container.nextSibling)
  })
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
  actions: string[],
  reasoning?: string,
  confidence?: number,
  targetSelector?: string
): void {
  const messagesEl = getMessages(state)
  const cardEl = createActionConfirmElement(id, description, risk, actions, reasoning, confidence, targetSelector)
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

function showWatchEventCard(state: TabChatState, event: import('../shared/types').WatchEvent): void {
  if (!event) return
  const messagesEl = getMessages(state)
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const selectorLabel = event.selector ? `<code>${event.selector}</code>` : 'full page'
  const oldSnippet = (event.oldValue || '').slice(0, 120)
  const newSnippet = (event.newValue || '').slice(0, 120)

  // Category-specific styling (V3: FR-V3-7)
  const categoryClass = event.category ? ` watch-cat-${event.category}` : ''
  const summaryHtml = event.summary
    ? `<div class="watch-event-summary">${event.summary}</div>`
    : ''
  const deltaHtml = event.numericDelta !== undefined
    ? `<span class="watch-delta ${event.numericDelta < 0 ? 'delta-down' : 'delta-up'}">${event.numericDelta > 0 ? '+' : ''}${event.numericDelta}</span>`
    : ''

  const div = document.createElement('div')
  div.className = `message message-assistant watch-event-card${categoryClass}`
  div.innerHTML = `
    <div class="watch-event-header">${event.category === 'price_change' ? 'Price change' : 'Change detected'} at ${time} ${deltaHtml}</div>
    ${summaryHtml}
    <div class="watch-event-target">Watching: ${selectorLabel}</div>
    <div class="watch-event-diff">
      <div class="watch-old"><span class="watch-diff-label">Before:</span> ${oldSnippet}</div>
      <div class="watch-new"><span class="watch-diff-label">After:</span> ${newSnippet}</div>
    </div>
    <div class="watch-event-actions">
      <button class="btn-small btn-primary btn-watch-highlight" data-selector="${(event.selector || '').replace(/"/g, '&quot;')}">Show on page</button>
      <button class="btn-small btn-watch-dismiss">Dismiss</button>
      <button class="btn-small btn-danger btn-watch-stop" data-tab-id="${event.tabId}">Stop watching</button>
    </div>`

  // Attach handlers
  div.querySelector('.btn-watch-highlight')?.addEventListener('click', () => {
    const sel = event.selector
    if (sel) {
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: MSG.HIGHLIGHT_FIELD, selector: sel }).catch(() => {})
      })
    }
  })
  div.querySelector('.btn-watch-dismiss')?.addEventListener('click', () => {
    div.remove()
  })
  div.querySelector('.btn-watch-stop')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.WATCH_STOP, tabId: event.tabId }).then(() => {
      div.remove()
      const watchEl = document.getElementById(`watch-indicator-${state.tabId}`)
      if (watchEl) watchEl.style.display = 'none'
    }).catch(() => {})
  })

  messagesEl.appendChild(div)
  scrollToBottom(messagesEl, true)
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
  const { html, widgets } = renderStreamingHTML(state.currentBubbleRaw)
  state.currentBubble.innerHTML = html
  renderWidgetsInContainer(state.currentBubble, widgets)
  attachWidgetHandlers(state.currentBubble, (_wid, val) => handleWidgetChoice(state, val))

  // Re-attach all handlers lost after innerHTML replacement
  attachExtractionCardHandlers(state.currentBubble)
  attachFollowUpChipHandlers(state, state.currentBubble)
  attachPinSaveHandlers(state, state.currentBubble)
  attachWorkflowSaveHandlers(state.currentBubble)

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
    const { html, widgets, msgType, followUpChips } = renderAssistantHTML(fullText)
    // Apply message type styling (PRD 7)
    if (msgType === 'warning') {
      state.currentBubble.className = 'message message-assistant message-warning'
    } else if (msgType === 'clarification') {
      state.currentBubble.className = 'message message-assistant message-clarification'
    } else if (msgType === 'system') {
      state.currentBubble.className = 'message message-system-status'
    }
    state.currentBubble.innerHTML = html
    renderWidgetsInContainer(state.currentBubble, widgets)
    attachWidgetHandlers(state.currentBubble, (_wid, val) => handleWidgetChoice(state, val))
    addMessageActions(state, state.currentBubble, fullText)
    addCodeBlockCopyButtons(state.currentBubble)
    enhanceLinks(state.currentBubble)
    attachPageRefHandlers(state, state.currentBubble)
    attachExtractionCardHandlers(state.currentBubble)
    attachFollowUpChipHandlers(state, state.currentBubble)
    attachPinSaveHandlers(state, state.currentBubble)
    attachWorkflowSaveHandlers(state.currentBubble)
    applyLongAnswerCollapse(state.currentBubble)

    // Auto-generate follow-up chips if AI didn't provide any
    autoGenerateFollowUps(state, state.currentBubble, fullText, followUpChips)
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
  // Use full pasted text if a large-text chip is active; otherwise use the visible input
  let text = (state.pendingLargeText ?? inputEl.value).trim()
  // Clear the chip before sending
  if (state.pendingLargeText) {
    state.container.querySelector('.large-text-chip')?.remove()
    state.pendingLargeText = null
  }
  if (!text || state.isStreaming) return

  // Auto-stop mic recording if active
  if (state._stopMic) state._stopMic()

  if (state.pendingAbort) {
    state.pendingAbort.abort()
    state.pendingAbort = null
  }

  // ── Ambiguity detection for very short inputs ──
  if (ambiguityBypass) {
    ambiguityBypass = false
  } else {
    const words = text.split(/\s+/).filter(w => w.length > 0)
    if (words.length <= 1 && !text.startsWith('/')) {
      const hasIntent = AMBIGUITY_INTENT_PATTERNS.some(p => p.test(text))
      if (!hasIntent) {
        const pageType = detectPageType(state.domain, '')
        showAmbiguityCard(state, text, pageType)
        return
      }
    }
  }

  const imageData = state.pendingImageData
  const fileContext = state.pendingFileContext
  const fileName = state.pendingFileName

  // Prepend file content as context if attached
  if (fileContext) {
    text = `[Attached file: ${fileName}]\n\`\`\`\n${fileContext.slice(0, 20_000)}\n\`\`\`\n\n${text}`
  }

  // Start watch session when /watch command is used
  if (text.toLowerCase().startsWith('/watch') || text.toLowerCase().startsWith('watch this page')) {
    const watchEl = document.getElementById(`watch-indicator-${state.tabId}`)
    if (watchEl) watchEl.style.display = ''
    // Extract optional CSS selector from /watch command (e.g. "/watch .price")
    const watchArg = text.replace(/^\/watch\s*/i, '').trim()
    const watchSelector = watchArg && !watchArg.toLowerCase().startsWith('this') ? watchArg : undefined
    chrome.runtime.sendMessage({ type: MSG.WATCH_START, tabId: state.tabId, selector: watchSelector }).catch(() => {})
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
      explanationDepth: currentExplanationDepth,
      additionalTabIds: selectedCrossTabIds.length > 0 ? [...selectedCrossTabIds] : undefined,
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
