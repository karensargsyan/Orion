import { initChat, newSession, loadSession, cleanupClosedTab, sendChatMessage } from './chat'
import { initVault } from './vault-ui'
import { initSettings } from './settings-ui'
import { initMemory } from './memory-ui'
import { initOnboarding } from './onboarding-ui'
import { initStats } from './stats-ui'
import { MSG, PORT_AI_STREAM } from '../shared/constants'
import type { Settings } from '../shared/types'
import * as speech from './speech-service'

type TabId = 'chat' | 'history' | 'vault' | 'memory' | 'insights' | 'settings'
let activeTab: TabId = 'chat'
let currentTabId = 0

function switchTab(tab: TabId): void {
  activeTab = tab

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tab)
  })

  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.toggle('active', (panel as HTMLElement).id === `panel-${tab}`)
  })

  if (tab === 'chat') initChat(document.getElementById('panel-chat')!, currentTabId)
  if (tab === 'history') initHistory()
  if (tab === 'vault') initVault(document.getElementById('panel-vault')!)
  if (tab === 'memory') initMemory(document.getElementById('panel-memory')!, currentTabId)
  if (tab === 'insights') initStats(document.getElementById('panel-insights')!)
  if (tab === 'settings') initSettings(document.getElementById('panel-settings')!)
}

async function initHistory(): Promise<void> {
  const container = document.getElementById('panel-history')!
  container.innerHTML = '<p class="hint-text" style="padding:12px">Loading history...</p>'

  const res = await chrome.runtime.sendMessage({ type: MSG.CHAT_SESSION_LIST }) as {
    ok: boolean; sessions?: string[]
  }

  const sessions = res.sessions ?? []

  if (sessions.length === 0) {
    container.innerHTML = `
      <div class="history-container">
        <div class="history-header"><h2>History</h2></div>
        <p class="hint-text" style="padding:20px;text-align:center">No conversations yet.</p>
      </div>
    `
    return
  }

  container.innerHTML = `
    <div class="history-container">
      <div class="history-header">
        <h2>History</h2>
        <button id="btn-new-chat" class="btn-small btn-primary">+ New Chat</button>
      </div>
      <div class="session-list">
        ${sessions.slice().reverse().map(sid => {
          const isDomain = sid.startsWith('session_domain_')
          const isOrion = sid.startsWith('session_orion_')
          const label = isOrion ? 'Orion session' : isDomain ? sid.replace('session_domain_', '') : sid
          const tsNum = isOrion ? Number(sid.replace('session_orion_', '')) : (!isDomain ? Number(sid.replace('session_', '').replace('session_tab_', '')) : 0)
          const ts = tsNum ? new Date(tsNum).toLocaleString() : ''
          const icon = isOrion ? '🚀 ' : isDomain ? '🌐 ' : ''
          return `<div class="session-item" data-session="${escHtml(sid)}">
            <div class="session-date">${icon}${escHtml(label)}</div>
            ${ts ? `<div class="session-id">${escHtml(ts)}</div>` : ''}
          </div>`
        }).join('')}
      </div>
    </div>
  `

  container.querySelector('#btn-new-chat')?.addEventListener('click', () => {
    newSession()
    switchTab('chat')
  })

  container.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', async () => {
      const sessionId = (item as HTMLElement).dataset.session!
      await loadSession(sessionId)
      switchTab('chat')
    })
  })
}

async function init(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    currentTabId = tab?.id ?? 0
    // Group the active tab into "Orion" when the sidebar opens
    if (currentTabId > 0) {
      chrome.runtime.sendMessage({ type: 'GROUP_ACTIVE_TAB', tabId: currentTabId }).catch(() => {})
    }
  } catch { /* sidepanel context */ }

  let s: Settings | null = null
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET }) as { ok: boolean; settings: Settings }
    s = res.ok ? res.settings : null
  } catch { /* settings not available yet */ }

  // Skip onboarding — mark as complete if not already
  if (!s?.onboardingComplete) {
    chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, partial: { onboardingComplete: true } }).catch(() => {})
  }

  // Check if a model is configured — if not, open settings first
  // When s is null (first ever launch), or no provider configured → go to settings
  const provider = s?.activeProvider || 'local'
  const hasModel = !!(
    (provider === 'local' && s?.lmStudioUrl) ||
    (provider === 'gemini' && s?.geminiApiKey) ||
    (provider === 'openai' && s?.openaiApiKey) ||
    (provider === 'anthropic' && s?.anthropicApiKey)
  )

  // Apply saved theme
  applyTheme(s?.theme || 'dark')

  showMainUI(hasModel ? 'chat' : 'settings')

  // Connect a persistent port for receiving broadcasts from background (context menus, shortcuts)
  setupBroadcastListener()
}

/** Apply theme to <html> element. 'system' = no data-theme attr (uses media query). */
export function applyTheme(theme: 'system' | 'dark' | 'light'): void {
  const root = document.documentElement
  if (theme === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
}

function setupBroadcastListener(): void {
  const port = chrome.runtime.connect({ name: PORT_AI_STREAM })
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    if (msg.type === 'CONTEXT_MENU_CHAT') {
      // Switch to chat tab and inject the message
      if (activeTab !== 'chat') switchTab('chat')
      const text = msg.text as string
      if (text) {
        setTimeout(() => sendChatMessage(text), 200)
      }
    }
    if (msg.type === 'FOCUS_CHAT_INPUT') {
      if (activeTab !== 'chat') switchTab('chat')
      setTimeout(() => {
        const input = document.querySelector('.chat-input') as HTMLTextAreaElement
        input?.focus()
      }, 100)
    }
    if (msg.type === 'SWITCH_TO_MEMORY') {
      switchTab('memory')
      setTimeout(() => {
        const input = document.querySelector('#memory-search-input') as HTMLInputElement
        input?.focus()
      }, 100)
    }
  })
  port.onDisconnect.addListener(() => {
    // Reconnect after a short delay (e.g. service worker restart)
    setTimeout(setupBroadcastListener, 1000)
  })
}

function showOnboarding(): void {
  const app = document.getElementById('app')!
  app.innerHTML = '<div id="onboarding-container"></div>'
  initOnboarding(document.getElementById('onboarding-container')!, () => {
    showMainUI()
  })
}

function showMainUI(startTab: TabId = 'chat'): void {
  const app = document.getElementById('app')!
  app.innerHTML = `
    <div class="learning-bar" id="learning-bar" style="display:none">
      <span class="learning-indicator"></span>
      <span class="learning-label">Supervised Learning</span>
      <span class="learning-stats" id="learning-stats"></span>
      <button class="learning-stop-btn" id="btn-learning-stop">Stop</button>
    </div>
    <div class="supervised-transcript-bar" id="supervised-transcript" style="display:none">
      <div class="transcript-mic-icon" id="transcript-mic-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
      </div>
      <div class="transcript-log-wrap">
        <div class="transcript-log" id="transcript-log"></div>
        <div class="transcript-live" id="transcript-live"></div>
      </div>
    </div>
    <div class="supervised-review-bar" id="supervised-review" style="display:none">
      <div class="review-summary" id="review-summary"></div>
      <div class="review-actions">
        <button class="btn-small btn-primary" id="btn-review-send">Send for Learning</button>
        <button class="btn-small btn-danger" id="btn-review-discard">Discard</button>
      </div>
    </div>
    <div class="learning-feedback-panel" id="learning-feedback-panel" style="display:none" role="region" aria-label="Learning results">
      <div class="learning-feedback-title">What you taught the assistant</div>
      <pre class="learning-feedback-body" id="learning-feedback-body"></pre>
      <button type="button" class="btn-small btn-primary" id="btn-learning-feedback-dismiss">Got it</button>
    </div>
    <nav class="tab-bar">
      <button class="tab-btn${startTab === 'chat' ? ' active' : ''}" data-tab="chat" title="Chat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span>Chat</span>
      </button>
      <button class="tab-btn" data-tab="memory" title="Memory & Search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <span>Memory</span>
      </button>
      <button class="tab-btn" data-tab="insights" title="Insights">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"></path></svg>
        <span>Insights</span>
      </button>
      <button class="tab-btn" data-tab="vault" title="Vault">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        <span>Vault</span>
      </button>
      <button class="tab-btn" data-tab="history" title="History">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
        <span>History</span>
      </button>
      <button class="tab-btn${startTab === 'settings' ? ' active' : ''}" data-tab="settings" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path></svg>
        <span>Settings</span>
      </button>
      <button class="tab-btn learning-btn" id="btn-learning-toggle" title="Learning Mode">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
        <span>Learn</span>
      </button>
    </nav>
    <div id="panel-chat" class="panel${startTab === 'chat' ? ' active' : ''}"></div>
    <div id="panel-memory" class="panel"></div>
    <div id="panel-insights" class="panel"></div>
    <div id="panel-vault" class="panel"></div>
    <div id="panel-history" class="panel"></div>
    <div id="panel-settings" class="panel${startTab === 'settings' ? ' active' : ''}"></div>
  `

  document.querySelectorAll<HTMLElement>('.tab-btn:not(.learning-btn)').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab as TabId))
  })

  wireLearningButton()
  listenForTabChanges()
  switchTab(startTab)
}

function listenForTabChanges(): void {
  chrome.tabs.onActivated.addListener(async (info) => {
    currentTabId = info.tabId
    if (activeTab === 'chat') {
      initChat(document.getElementById('panel-chat')!, currentTabId)
    }
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupClosedTab(tabId)
  })
}

let learningStatusInterval: ReturnType<typeof setInterval> | null = null
let supervisedActive = false
let transcriptHistory: string[] = []

function wireLearningButton(): void {
  const btn = document.getElementById('btn-learning-toggle')!
  const stopBtn = document.getElementById('btn-learning-stop')!

  checkSupervisedStatus()

  btn.addEventListener('click', async () => {
    if (supervisedActive) {
      pauseSupervisedMode()
    } else {
      await startSupervisedMode()
    }
  })

  stopBtn.addEventListener('click', () => {
    pauseSupervisedMode()
  })
}

function appendToTranscriptLog(text: string, type: 'interim' | 'final' | 'command'): void {
  const logEl = document.getElementById('transcript-log')
  if (!logEl) return

  if (type === 'interim') {
    const liveEl = document.getElementById('transcript-live')
    if (liveEl) liveEl.textContent = text
    return
  }

  const liveEl = document.getElementById('transcript-live')
  if (liveEl) liveEl.textContent = ''

  const entry = document.createElement('div')
  entry.className = type === 'command'
    ? 'transcript-entry transcript-entry-command'
    : 'transcript-entry'
  entry.textContent = type === 'command' ? `[done] ${text}` : text
  logEl.appendChild(entry)
  logEl.scrollTop = logEl.scrollHeight

  if (type === 'final') transcriptHistory.push(text)
}

async function startSupervisedMode(): Promise<void> {
  const btn = document.getElementById('btn-learning-toggle')!
  const bar = document.getElementById('learning-bar')!
  const transcriptBar = document.getElementById('supervised-transcript')!
  const reviewBar = document.getElementById('supervised-review')!
  const logEl = document.getElementById('transcript-log')!
  const statsEl = document.getElementById('learning-stats')!

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    currentTabId = tab?.id ?? 0
  } catch {
    currentTabId = 0
  }

  const settingsRes = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET }) as { ok: boolean; settings: Settings }
  const s = settingsRes.ok ? settingsRes.settings : null
  const sttProvider = s?.sttProvider ?? 'web-speech'

  speech.configure(sttProvider, s?.whisperEndpoint)

  transcriptHistory = []
  logEl.innerHTML = ''
  reviewBar.style.display = 'none'

  statsEl.textContent = 'Starting supervised session…'

  const startResult = await chrome.runtime.sendMessage({
    type: MSG.SUPERVISED_START,
    tabId: currentTabId,
  }) as { ok: boolean; error?: string }

  if (!startResult.ok) {
    statsEl.textContent = startResult.error ?? 'Could not start supervised mode.'
    return
  }


  speech.onTranscript((text, isFinal) => {
    if (isFinal) {
      appendToTranscriptLog(text, 'final')
    } else {
      appendToTranscriptLog(text, 'interim')
    }
  })

  speech.onCommand(async (command) => {
    appendToTranscriptLog(command, 'command')
  })

  speech.onError((error) => {
    const logEl = document.getElementById('transcript-log')
    if (logEl) {
      const entry = document.createElement('div')
      entry.className = 'transcript-entry'
      entry.style.color = 'var(--color-error, #e74c3c)'
      entry.textContent = `STT Error: ${error}`
      logEl.appendChild(entry)
      logEl.scrollTop = logEl.scrollHeight
    }
  })

  statsEl.textContent = sttProvider === 'whisper-local'
    ? 'Requesting microphone, then starting transcription…'
    : 'Preparing speech recognition…'

  try {
    await speech.startListening()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    appendToTranscriptLog(`Mic error: ${errMsg}`, 'final')
    statsEl.textContent = 'Mic / STT failed to start; browser actions are still being recorded'
  }

  btn.classList.add('recording')
  bar.style.display = 'flex'
  transcriptBar.style.display = 'flex'
  supervisedActive = true

  const micIcon = document.getElementById('transcript-mic-icon')
  if (micIcon) {
    micIcon.classList.toggle('active', speech.isListening())
  }

  learningStatusInterval = setInterval(updateLearningStats, 2000)
}

function pauseSupervisedMode(): void {
  speech.stopListening()
  const micIcon = document.getElementById('transcript-mic-icon')
  if (micIcon) micIcon.classList.remove('active')

  if (learningStatusInterval) {
    clearInterval(learningStatusInterval)
    learningStatusInterval = null
  }

  const bar = document.getElementById('learning-bar')!
  const reviewBar = document.getElementById('supervised-review')!
  const summaryEl = document.getElementById('review-summary')!
  const statsEl = document.getElementById('learning-stats')!

  statsEl.textContent = 'Stopped — review transcript below'

  const lineCount = transcriptHistory.length
  summaryEl.textContent = lineCount > 0
    ? `${lineCount} transcript segment${lineCount > 1 ? 's' : ''} recorded. Send for AI analysis?`
    : 'No speech was captured. You can discard this session.'

  reviewBar.style.display = 'flex'

  const sendBtn = document.getElementById('btn-review-send')!
  const discardBtn = document.getElementById('btn-review-discard')!

  const cleanupReview = () => {
    sendBtn.replaceWith(sendBtn.cloneNode(true))
    discardBtn.replaceWith(discardBtn.cloneNode(true))
  }

  sendBtn.addEventListener('click', async () => {
    cleanupReview()
    await finalizeSupervisedMode(true)
  }, { once: true })

  discardBtn.addEventListener('click', async () => {
    cleanupReview()
    await finalizeSupervisedMode(false)
  }, { once: true })
}

async function finalizeSupervisedMode(sendForLearning: boolean): Promise<void> {
  const btn = document.getElementById('btn-learning-toggle')!
  const bar = document.getElementById('learning-bar')!
  const transcriptBar = document.getElementById('supervised-transcript')!
  const reviewBar = document.getElementById('supervised-review')!
  const statsEl = document.getElementById('learning-stats')!
  const feedbackPanel = document.getElementById('learning-feedback-panel')
  const feedbackBody = document.getElementById('learning-feedback-body')

  if (sendForLearning) {
    statsEl.textContent = 'Analyzing session…'
    reviewBar.style.display = 'none'
    transcriptBar.style.display = 'none'

    const result = await chrome.runtime.sendMessage({ type: MSG.SUPERVISED_STOP }) as {
      ok: boolean
      sessionId?: string
      interactionCount?: number
      playbookCount?: number
      analysis?: string
    }

    if (result.ok) {
      const analysisText = (result.analysis ?? '').trim() || 'Session ended with no analysis text.'
      const nPlay = result.playbookCount ?? 0
      const nInt = result.interactionCount ?? 0
      bar.classList.add('learning-bar--complete')
      statsEl.textContent =
        nPlay > 0
          ? `Learned ${nPlay} playbook${nPlay === 1 ? '' : 's'} from ${nInt} interaction${nInt === 1 ? '' : 's'}`
          : `Analyzed ${nInt} interaction${nInt === 1 ? '' : 's'} — see below`

      if (feedbackPanel && feedbackBody) {
        feedbackBody.textContent = analysisText
        feedbackPanel.style.display = 'flex'
        const dismissBtn = document.getElementById('btn-learning-feedback-dismiss')
        const dismiss = (): void => {
          feedbackPanel.style.display = 'none'
          bar.classList.remove('learning-bar--complete')
          hideAllLearningUI()
        }
        dismissBtn?.replaceWith(dismissBtn.cloneNode(true))
        document.getElementById('btn-learning-feedback-dismiss')?.addEventListener('click', dismiss, { once: true })
      } else {
        setTimeout(() => hideAllLearningUI(), 4000)
      }
    } else {
      statsEl.textContent = 'Analysis could not complete.'
      setTimeout(() => hideAllLearningUI(), 4000)
    }
  } else {
    await chrome.runtime.sendMessage({ type: MSG.SUPERVISED_STOP })
    hideAllLearningUI()
  }

  btn.classList.remove('recording')
  supervisedActive = false
  transcriptHistory = []
}

function hideAllLearningUI(): void {
  const bar = document.getElementById('learning-bar')
  const transcriptBar = document.getElementById('supervised-transcript')
  const reviewBar = document.getElementById('supervised-review')
  const feedbackPanel = document.getElementById('learning-feedback-panel')
  if (bar) {
    bar.style.display = 'none'
    bar.classList.remove('learning-bar--complete')
  }
  if (transcriptBar) transcriptBar.style.display = 'none'
  if (reviewBar) reviewBar.style.display = 'none'
  if (feedbackPanel) feedbackPanel.style.display = 'none'
}

async function checkSupervisedStatus(): Promise<void> {
  const status = await chrome.runtime.sendMessage({ type: MSG.SUPERVISED_STATUS }) as {
    ok: boolean; active: boolean; interactionCount?: number; actionCount?: number; startedAt?: number
  }

  if (status.active) {
    const btn = document.getElementById('btn-learning-toggle')
    const bar = document.getElementById('learning-bar')
    const transcriptBar = document.getElementById('supervised-transcript')
    if (btn) btn.classList.add('recording')
    if (bar) bar.style.display = 'flex'
    if (transcriptBar) transcriptBar.style.display = 'flex'
    supervisedActive = true
    learningStatusInterval = setInterval(updateLearningStats, 2000)
    updateLearningStats()
  }
}

async function updateLearningStats(): Promise<void> {
  const statsEl = document.getElementById('learning-stats')
  if (!statsEl) return

  const status = await chrome.runtime.sendMessage({ type: MSG.SUPERVISED_STATUS }) as {
    ok: boolean; active: boolean; interactionCount?: number; actionCount?: number; startedAt?: number; domain?: string
  }

  if (!status.active) {
    if (learningStatusInterval) {
      clearInterval(learningStatusInterval)
      learningStatusInterval = null
    }
    const btn = document.getElementById('btn-learning-toggle')
    if (btn) btn.classList.remove('recording')
    supervisedActive = false
    return
  }

  const elapsed = status.startedAt
    ? Math.round((Date.now() - status.startedAt) / 1000)
    : 0
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  statsEl.textContent = `${status.interactionCount ?? 0} interactions | ${status.actionCount ?? 0} actions | ${mins}:${String(secs).padStart(2, '0')} | ${status.domain ?? ''}`
}

document.addEventListener('DOMContentLoaded', () => { init().catch(console.error) })

// Notify background when the panel is closed so it can ungroup the tab
window.addEventListener('beforeunload', () => {
  if (currentTabId > 0) {
    chrome.runtime.sendMessage({ type: 'PANEL_CLOSED', tabId: currentTabId }).catch(() => {})
  }
})

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
