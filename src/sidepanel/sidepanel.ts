import { initChat, newSession, loadSession } from './chat'
import { initVault } from './vault-ui'
import { initSettings } from './settings-ui'
import { initMemory } from './memory-ui'
import { initOnboarding } from './onboarding-ui'
import { initStats } from './stats-ui'
import { MSG } from '../shared/constants'
import type { Settings } from '../shared/types'

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
  if (tab === 'memory') initMemory(document.getElementById('panel-memory')!)
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
          const date = new Date(Number(sid.replace('session_', '').replace('session_tab_', ''))).toLocaleString()
          return `<div class="session-item" data-session="${escHtml(sid)}">
            <div class="session-date">${escHtml(date)}</div>
            <div class="session-id">${escHtml(sid)}</div>
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
  } catch { /* sidepanel context */ }

  const res = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET }) as { ok: boolean; settings: Settings }
  const s = res.ok ? res.settings : null

  if (!s?.onboardingComplete) {
    showOnboarding()
    return
  }

  showMainUI()
}

function showOnboarding(): void {
  const app = document.getElementById('app')!
  app.innerHTML = '<div id="onboarding-container"></div>'
  initOnboarding(document.getElementById('onboarding-container')!, () => {
    showMainUI()
  })
}

function showMainUI(): void {
  const app = document.getElementById('app')!
  app.innerHTML = `
    <nav class="tab-bar">
      <button class="tab-btn active" data-tab="chat" title="Chat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span>Chat</span>
      </button>
      <button class="tab-btn" data-tab="memory" title="Memory">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"></path><path d="M12 6v6l4 2"></path></svg>
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
      <button class="tab-btn" data-tab="settings" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path></svg>
        <span>Settings</span>
      </button>
    </nav>
    <div id="panel-chat" class="panel active"></div>
    <div id="panel-memory" class="panel"></div>
    <div id="panel-insights" class="panel"></div>
    <div id="panel-vault" class="panel"></div>
    <div id="panel-history" class="panel"></div>
    <div id="panel-settings" class="panel"></div>
  `

  document.querySelectorAll<HTMLElement>('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab as TabId))
  })

  listenForTabChanges()
  switchTab('chat')
}

function listenForTabChanges(): void {
  chrome.tabs.onActivated.addListener(async (info) => {
    currentTabId = info.tabId
    if (activeTab === 'chat') {
      initChat(document.getElementById('panel-chat')!, currentTabId)
    }
  })
}

document.addEventListener('DOMContentLoaded', () => { init().catch(console.error) })

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
