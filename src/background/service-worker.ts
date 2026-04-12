import { MSG, DEFAULTS, PORT_AI_STREAM, PORT_STT_RELAY, STORE } from '../shared/constants'
import { persistMicGrantTimestamp } from '../shared/mic-permission-storage'
import type { Settings, VaultData, VaultCategory, PageSnapshot, ChatMessage, InputFieldType } from '../shared/types'
import { tabState } from './tab-state'
import {
  rateLimiter, streamChat, fetchModels, buildSystemPrompt, buildCompactSystemPrompt,
  abortStream, callAI, wrapStreamPort, abortAllStreams,
  estimateTokens, truncateMessagesToFit, getAdaptiveMaxTokens,
  type StreamPort,
} from './ai-client'
import {
  setupPin, unlockWithPin, isSessionUnlocked, encryptData, decryptData, changePin,
} from './crypto-manager'
import {
  appendChatMessage, getSessionMessages, getAllSessions, getAllSettings, setSettings,
  vaultList, vaultGet, vaultSet, vaultDelete,
  addSessionMemory, getRecentSessionMemory, getSessionMemoryByDomain, getTabMemory,
  clearSessionMemory, clearGlobalMemory, getAllGlobalMemory, exportMemory, clearChatHistory,
  getDomainStats, getGlobalMemoryByDomain, clearSessionChat, searchAllHistory,
  pruneOldSessionMemory,
} from './memory-manager'
import { recordAction, flushAllBuffers, flushBuffer, clearTabBuffer } from './action-recorder'
import { matchVaultToForm, matchCredentialsToForm, describeForm, classifyField } from './form-intelligence'
import { probeEndpoint, quickHealthCheck } from './api-detector'
import { startScreenshotLoop, stopScreenshotLoop, captureScreenshot } from './screenshot-loop'
import { executeActionsFromText, parseActionsFromText, executeWithFollowUp, ensureContentScript, requestFreshSnapshot, cancelAutomation } from './action-executor'
import { createGroupForTab, ungroupTab, hasOrionGroup, isOrionTab, cleanupTabGroup, setActiveOriginTab, resolveGroupSession, updateGroupTitle, pauseGroup, resumeGroup, isTabInPausedGroup, getActiveGroups, stopGroup, getTabsInGroup } from './web-researcher'
import { analyzeAndGenerateFormValues } from './form-assist'
import { analyzeHabits, getHabitPatterns } from './habit-tracker'
import { getAllCalendarEvents } from './calendar-detector'
import { detectPersonalData, storeDetectedPII } from './pii-detector'
import { classifyActionRisk, isSubmitGuardAction, needsConfirmation, requestConfirmation, handleConfirmResponse, requestModeChoice, handleModeChoiceResponse, shouldDisableExecution, shouldSuppressActions, shouldAutoApprove } from './confirmation-manager'
import type { ConfirmResponseType } from '../shared/types'
import { getSkillsForDomain, formatSkillsForPrompt } from './skill-manager'
import { getBehaviorsForDomain, formatBehaviorsForPrompt } from './behavior-learner'
import { tryExtractInstructionToSave, saveUserInstruction, getAllUserInstructions, formatUserInstructionsForPrompt } from './instruction-manager'
// threat-heuristics removed — safety border feature removed
import { runAIActionLearningCycle } from './ai-action-learner'
import {
  buildMempalaceQuery,
  mempalaceEnabled,
  probeMempalaceBridge,
  searchMempalace,
} from './mempalace-client'
import {
  recallRelevantMemories,
  recordLesson,
  pushSessionMemoryToPalace,
  buildLessonDistillationPrompt,
} from './mempalace-learner'
import { startLearning, stopLearning, isLearningActive, getActiveSession } from './learning-recorder'
import { analyzeLearningSession } from './learning-analyzer'
import { listGeminiModels } from './gemini-client'
import {
  startSupervisedSession, stopSupervisedSession, isSupervisedActive,
  getActiveSupervisedSession, beginInteraction, addVoiceSegment,
  completeInteraction, feedUserEvent, getCurrentInteraction, getSupervisedActionCount,
} from './supervised-recorder'
import { analyzeFullSupervisedSession } from './supervised-analyzer'
import { findMatchingPlaybook } from './playbook-matcher'
import { getAllPlaybooks, deletePlaybook, exportFullBackup, importFullBackup } from './memory-manager'
import { logError, logTabEvent, getRecentActions } from './error-logger'
import { routeMessage, hasHandler } from './handlers/msg-router'
import { registerClipboardHandlers } from './handlers/clipboard-handlers'
import { registerWorkflowHandlers } from './handlers/workflow-handlers'
import { cleanupWorkflowTab } from './workflow-engine'
import { registerDebugHandlers } from './handlers/debug-handlers'
import { getCDPAccessibilityTree, type CDPTreeResult } from './cdp-accessibility'
import { captureMiniMap, type MiniMapResult } from './minimap-screenshot'
import { recordPageVisit, getSitemapForPrompt, persistDirtySitemaps } from './visual-sitemap'
import { getPersonaForPrompt, classifyPage } from './page-persona'
import { buildPromptPipeline, type PromptPipelineOutput } from './prompt-engine'
import { promptEngineerInstruction } from './instruction-manager'
import { unregisterExtensionTab, pruneStaleExtensionTabs, isExtensionTab, registerExtensionTab } from './web-researcher'
import {
  localMemoryEnabled, recallLocalMemories, recordLocalLesson,
  searchLocalMemory, clearLocalMemory, getLocalMemoryStats,
} from './local-memory'
import {
  autoCollectEnabled, bufferUserInput, triggerFlush, clearBuffer,
  getAutoCollectedCount, approveAutoCollected, approveAllAutoCollected,
} from './auto-collector'
import {
  telegramEnabled, pollTelegramUpdates, testTelegramBot, resetTelegramOffset,
  registerChatHandler, cleanupTelegramTab, notifyTabUrlChange, isTelegramTab,
} from './telegram-client'
import { journalInput, searchInputJournal } from './input-journal'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Background AI call failure tracking ─────────────────────────────────────

/** Consecutive background AI call failures. Used for exponential backoff. */
let bgCallFailures = 0
/** Timestamp (ms) of the last background AI failure. */
let bgCallLastFailureMs = 0
/** Max consecutive failures before disabling background AI calls entirely. */
const BG_MAX_FAILURES = 5
/** Base backoff delay in ms (doubles each failure: 60s, 120s, 240s, 480s…). */
const BG_BACKOFF_BASE_MS = 60_000

/** Returns true if background AI calls should be skipped due to recent failures. */
function shouldSkipBackgroundAI(): boolean {
  if (bgCallFailures === 0) return false
  if (bgCallFailures >= BG_MAX_FAILURES) {
    console.warn(`[LocalAI] Background AI disabled after ${bgCallFailures} consecutive failures. Change settings or model to re-enable.`)
    return true
  }
  const backoffMs = BG_BACKOFF_BASE_MS * Math.pow(2, bgCallFailures - 1)
  const elapsed = Date.now() - bgCallLastFailureMs
  if (elapsed < backoffMs) {
    console.warn(`[LocalAI] Background AI skipped — backoff ${Math.round(backoffMs / 1000)}s, ${Math.round((backoffMs - elapsed) / 1000)}s remaining`)
    return true
  }
  return false
}

function recordBgCallFailure(): void {
  bgCallFailures++
  bgCallLastFailureMs = Date.now()
  console.warn(`[LocalAI] Background AI call failed (${bgCallFailures}/${BG_MAX_FAILURES})`)
}

function recordBgCallSuccess(): void {
  if (bgCallFailures > 0) {
    console.warn(`[LocalAI] Background AI call succeeded — resetting failure counter (was ${bgCallFailures})`)
  }
  bgCallFailures = 0
  bgCallLastFailureMs = 0
}

function resetBgCallFailures(): void {
  bgCallFailures = 0
  bgCallLastFailureMs = 0
}

// ─── Initialization ───────────────────────────────────────────────────────────

let settings: Settings | null = null
const sessionId = `session_${Date.now()}`
/** Current execution mode (V3: FR-V3-8). Stored in memory, persisted to chrome.storage.local. */
let currentExecutionMode: import('../shared/types').ExecutionMode = 'approve'
// Restore execution mode from storage on startup
chrome.storage.local.get('executionMode').then(r => {
  if (r.executionMode) currentExecutionMode = r.executionMode
}).catch(() => {})
// Prune session memory older than 30 days on each SW startup
pruneOldSessionMemory(30).catch(() => {})
// Side panel is always enabled globally via setPanelBehavior + setOptions

async function getSettings(): Promise<Settings> {
  if (!settings) {
    try {
      settings = await getAllSettings()
    } catch {
      settings = {
        activeProvider: 'local',
        lmStudioUrl: '', lmStudioModel: '', authToken: '',
        rateLimitRpm: 10, monitoringEnabled: true, visionEnabled: false,
        maxContextMessages: 20, hasPinSetup: false,
        screenshotIntervalSec: 10, textRewriteEnabled: true,
        safetyBorderEnabled: false, composeAssistantEnabled: true,
        aiActionLearningEnabled: true,
        mempalaceBridgeEnabled: DEFAULTS.MEMPALACE_BRIDGE_ENABLED,
        mempalaceBridgeUrl: DEFAULTS.MEMPALACE_BRIDGE_URL,
        localMemoryEnabled: DEFAULTS.LOCAL_MEMORY_ENABLED,
        localMemoryMaxEntries: DEFAULTS.LOCAL_MEMORY_MAX_ENTRIES,
        autoCollectEnabled: DEFAULTS.AUTO_COLLECT_ENABLED,
        autoCollectMinFields: DEFAULTS.AUTO_COLLECT_MIN_FIELDS,
        autoCollectExcludeDomains: [],
        telegramBotEnabled: DEFAULTS.TELEGRAM_BOT_ENABLED,
        telegramPollIntervalSec: DEFAULTS.TELEGRAM_POLL_INTERVAL_SEC,
        telegramAllowedChatIds: [],
        calendarDetectionEnabled: true, onboardingComplete: false,
        learningModeActive: false, learningSnapshotIntervalSec: 3,
        sttProvider: 'web-speech', whisperEndpoint: '',
        confirmationPreferences: [], globalAutoAccept: false,
        contextWindowTokens: 0, liteMode: false,
      } as Settings
    }
  }
  return settings!
}

async function initSW(): Promise<void> {
  try {
  settings = await getAllSettings()
  } catch {
    console.warn('[LocalAI] IDB init failed, using defaults')
    settings = {
      activeProvider: 'local',
      lmStudioUrl: '', lmStudioModel: '', authToken: '',
      rateLimitRpm: 10, monitoringEnabled: true, visionEnabled: false,
      maxContextMessages: 20, hasPinSetup: false,
      screenshotIntervalSec: 10, textRewriteEnabled: true,
      safetyBorderEnabled: false, composeAssistantEnabled: true, aiActionLearningEnabled: true,
      mempalaceBridgeEnabled: DEFAULTS.MEMPALACE_BRIDGE_ENABLED,
      mempalaceBridgeUrl: DEFAULTS.MEMPALACE_BRIDGE_URL,
      localMemoryEnabled: DEFAULTS.LOCAL_MEMORY_ENABLED,
      localMemoryMaxEntries: DEFAULTS.LOCAL_MEMORY_MAX_ENTRIES,
      autoCollectEnabled: DEFAULTS.AUTO_COLLECT_ENABLED,
      autoCollectMinFields: DEFAULTS.AUTO_COLLECT_MIN_FIELDS,
      autoCollectExcludeDomains: [],
      calendarDetectionEnabled: true, onboardingComplete: false,
      learningModeActive: false, learningSnapshotIntervalSec: 3,
      sttProvider: 'web-speech', whisperEndpoint: '',
      confirmationPreferences: [], globalAutoAccept: false,
      contextWindowTokens: 0, liteMode: false,
    } as Settings
  }
  await rateLimiter.load(settings!.rateLimitRpm)
  await chrome.alarms.create('bg-summarize', {
    periodInMinutes: DEFAULTS.BG_SUMMARIZE_INTERVAL_MINUTES,
  })
  await chrome.alarms.create('ai-action-learn', { periodInMinutes: 15 })
  await chrome.alarms.create('mempalace-learn', { periodInMinutes: 10 })

  // Start Telegram polling if enabled
  if (telegramEnabled(settings!)) {
    const intervalMin = Math.max(0.083, (settings!.telegramPollIntervalSec ?? 5) / 60) // min 5s
    await chrome.alarms.create('telegram-poll', { periodInMinutes: intervalMin })
  }

  // Inject handleAIChat into telegram-client (avoids circular import)
  registerChatHandler(handleAIChat)

  if (settings!.onboardingComplete) {
    startScreenshotLoop(settings!.screenshotIntervalSec)
  }

  // Set up context menus
  setupContextMenus()

  // Set up vault auto-lock alarm
  const lockTimeout = settings!.vaultLockTimeoutMin ?? 15
  if (lockTimeout > 0) {
    await chrome.alarms.create('vault-auto-lock', { periodInMinutes: 1 })
  }

  // Register modular message handlers
  registerClipboardHandlers()
  registerWorkflowHandlers()
  registerDebugHandlers()

  // Initial badge
  updateBadge('idle')
}

// ─── Context Menus ──────────────────────────────────────────────────────────

function setupContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    // Text operations (when text is selected)
    chrome.contextMenus.create({ id: 'orion-fix-grammar', title: 'Fix grammar & spelling', contexts: ['selection', 'editable'] })
    chrome.contextMenus.create({ id: 'orion-improve', title: 'Improve writing', contexts: ['selection', 'editable'] })
    chrome.contextMenus.create({ id: 'orion-separator-1', type: 'separator', contexts: ['selection'] })

    // Existing options
    chrome.contextMenus.create({ id: 'orion-ask', title: 'Ask Orion about this', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-explain', title: 'Explain this', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-research', title: 'Research this topic', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-separator-2', type: 'separator', contexts: ['all'] })

    // Page-level actions
    chrome.contextMenus.create({ id: 'orion-summarize', title: 'Summarize this page', contexts: ['page'] })
    chrome.contextMenus.create({ id: 'orion-fill', title: 'Fill this form with Orion', contexts: ['page', 'editable'] })
  })
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || tab.id < 0) return
  const tabId = tab.id

  // Ensure sidepanel is open for this tab
  try {
    await chrome.sidePanel.open({ tabId })
  } catch { /* panel may already be open */ }

  // Small delay to let sidepanel connect
  await sleep(300)

  const selectedText = info.selectionText?.trim() ?? ''
  const pageUrl = tab.url ?? ''

  switch (info.menuItemId) {
    case 'orion-fix-grammar':
      if (selectedText) {
        broadcastToPanel({
          type: 'CONTEXT_MENU_CHAT',
          text: `Fix grammar and spelling in this text:\n\n"${selectedText}"\n\nProvide corrected version.`,
          tabId
        })
      }
      break
    case 'orion-improve':
      if (selectedText) {
        broadcastToPanel({
          type: 'CONTEXT_MENU_CHAT',
          text: `Improve the clarity, tone, and professionalism of this text:\n\n"${selectedText}"\n\nProvide rewritten version.`,
          tabId
        })
      }
      break
    case 'orion-ask':
      if (selectedText) {
        broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text: `What is this: "${selectedText}"`, tabId })
      }
      break
    case 'orion-summarize':
      broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text: 'Summarize this page', tabId })
      break
    case 'orion-explain':
      if (selectedText) {
        broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text: `Explain this in simple terms: "${selectedText}"`, tabId })
      }
      break
    case 'orion-research':
      if (selectedText) {
        broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text: `Research this topic thoroughly: ${selectedText}`, tabId })
      }
      break
    case 'orion-fill':
      broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text: 'Analyze and help me fill the form on this page', tabId, triggerFormAssist: true })
      break
  }
})

/** Send a message to all connected sidepanel ports. */
function broadcastToPanel(msg: object): void {
  for (const port of activePanelPorts) {
    try { port.postMessage(msg) } catch { activePanelPorts.delete(port) }
  }
}

const activePanelPorts = new Set<chrome.runtime.Port>()

// ─── Keyboard Shortcuts ─────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return

  switch (command) {
    case 'quick-chat':
      try { await chrome.sidePanel.open({ tabId: tab.id }) } catch {}
      await sleep(300)
      broadcastToPanel({ type: 'FOCUS_CHAT_INPUT' })
      break
    case 'memory-search':
      try { await chrome.sidePanel.open({ tabId: tab.id }) } catch {}
      await sleep(300)
      broadcastToPanel({ type: 'SWITCH_TO_MEMORY' })
      break
    case 'command-palette':
      if (tab.id) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/command-palette.js'],
          })
          await chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_COMMAND_PALETTE })
        } catch { /* content script may already be injected */ }
      }
      break
  }
})

// ─── Omnibox Integration ────────────────────────────────────────────────────

chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({ description: 'Ask Orion: type your question or command' })
})

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const suggestions: chrome.omnibox.SuggestResult[] = []
  const q = text.toLowerCase().trim()
  if (q.startsWith('fill')) {
    suggestions.push({ content: 'Fill the form on this page using my vault data', description: 'Fill form with vault data' })
  }
  if (q.startsWith('sum')) {
    suggestions.push({ content: 'Summarize this page', description: 'Summarize current page' })
  }
  if (q.startsWith('res')) {
    suggestions.push({ content: `Research this topic thoroughly: ${text.slice(4).trim() || '...'}`, description: 'Deep web research' })
  }
  if (q.startsWith('mem') || q.startsWith('recall')) {
    suggestions.push({ content: `Search my memory for: ${text.replace(/^(mem|recall)\s*/i, '').trim() || '...'}`, description: 'Search memory' })
  }
  suggest(suggestions)
})

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  void disposition // always open sidepanel
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  try { await chrome.sidePanel.open({ tabId: tab.id }) } catch {}
  await sleep(400)
  broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text, tabId: tab.id })
})

// ─── Badge Status ───────────────────────────────────────────────────────────

type BadgeState = 'idle' | 'active' | 'error' | 'pending'

function updateBadge(state: BadgeState, count?: number): void {
  switch (state) {
    case 'idle':
      chrome.action.setBadgeText({ text: '' })
      break
    case 'active':
      chrome.action.setBadgeText({ text: '...' })
      chrome.action.setBadgeBackgroundColor({ color: '#6c5ce7' })
      break
    case 'error':
      chrome.action.setBadgeText({ text: '!' })
      chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' })
      break
    case 'pending':
      chrome.action.setBadgeText({ text: String(count ?? '') })
      chrome.action.setBadgeBackgroundColor({ color: '#f39c12' })
      break
  }
}

// ─── Desktop Notifications ──────────────────────────────────────────────────

function orionNotify(title: string, message: string): void {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: `Orion: ${title}`,
      message,
      silent: true,
    })
  } catch { /* notification API may be unavailable */ }
}

// ─── Vault Auto-Lock ────────────────────────────────────────────────────────

let lastUserInteractionMs = Date.now()

function touchUserActivity(): void {
  lastUserInteractionMs = Date.now()
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => { initSW().catch(console.error) })
chrome.runtime.onStartup.addListener(() => { initSW().catch(console.error) })
chrome.runtime.onSuspend?.addListener(() => {
  flushAllBuffers().catch(() => {})
  persistDirtySitemaps().catch(() => {})
})

// ─── Offscreen STT Management ────────────────────────────────────────────────

let sttRelayPort: chrome.runtime.Port | null = null
let offscreenCreating: Promise<void> | null = null
let pendingSTTLang: string | null = null

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument().catch(() => false)
  if (existing) return

  if (offscreenCreating) {
    await offscreenCreating
    return
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Speech recognition requires microphone access via Web Speech API',
  })

  await offscreenCreating
  offscreenCreating = null
}

async function closeOffscreenDocument(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument().catch(() => false)
  if (existing) {
    await chrome.offscreen.closeDocument().catch(() => {})
  }
  offscreenCreating = null
  pendingSTTLang = null
}

function sendSTTStartToOffscreen(lang: string): void {
  chrome.runtime.sendMessage({ type: MSG.STT_OFFSCREEN_START, lang }).catch(() => {})
}

async function startOffscreenSTT(lang = 'en-US'): Promise<void> {
  const alreadyExists = await chrome.offscreen.hasDocument().catch(() => false)

  if (alreadyExists) {
    sendSTTStartToOffscreen(lang)
    return
  }

  pendingSTTLang = lang
  await ensureOffscreenDocument()
  setTimeout(() => {
    if (pendingSTTLang) {
      sendSTTStartToOffscreen(pendingSTTLang)
      pendingSTTLang = null
    }
  }, 300)
}

async function stopOffscreenSTT(): Promise<void> {
  pendingSTTLang = null
  chrome.runtime.sendMessage({ type: MSG.STT_OFFSCREEN_STOP }).catch(() => {})
  setTimeout(() => closeOffscreenDocument().catch(() => {}), 500)
}

function relayToSttPort(msg: Record<string, unknown>): void {
  if (!sttRelayPort) return
  try { sttRelayPort.postMessage(msg) } catch { sttRelayPort = null }
}

// ─── Side panel ──────────────────────────────────────────────────────────────
//
// We take FULL control of panel open/close via action.onClicked + sidePanel.open().
// openPanelOnActionClick is FALSE — we handle it ourselves.
// Per-tab enabled/disabled controls visibility: only panel tabs have enabled=true.

// GLOBAL default: panel DISABLED everywhere. No tab sees the panel unless
// we explicitly enable it per-tab when the user clicks the icon.
chrome.sidePanel.setOptions({ path: 'sidepanel/sidepanel.html', enabled: false }).catch(e => console.warn('[Orion] sidePanel.setOptions init failed:', e))
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(e => console.warn('[Orion] sidePanel.setPanelBehavior init failed:', e))

// Track tabs where the panel is open
const panelOpenTabs = new Set<number>()

/** Rate-limit passive page recording: same URL max once per 60 s */
const recentlyRecordedUrls = new Map<string, number>()

// Icon click: open panel on this tab (or close if already open)
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  const tabId = tab.id

  if (panelOpenTabs.has(tabId)) {
    // Already open — close it
    panelOpenTabs.delete(tabId)
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {})
    await ungroupTab(tabId)
    broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
  } else {
    // Open ONLY on this specific tab
    panelOpenTabs.add(tabId)
    await chrome.sidePanel.setOptions({
      tabId, path: 'sidepanel/sidepanel.html', enabled: true,
    }).catch(e => console.warn('[Orion] sidePanel.setOptions enable failed:', e))
    await chrome.sidePanel.open({ tabId }).catch(e => console.warn('[Orion] sidePanel.open failed:', e))
    await createGroupForTab(tabId)
    broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
  }
})

// Tab switch: only interact with tabs that belong to Orion's group.
// Non-Orion tabs are completely off-limits (no screenshots, no monitoring).
chrome.tabs.onActivated.addListener(async (info) => {
  const tabId = info.tabId

  // Only interact with tabs the user explicitly added to Orion
  if (!panelOpenTabs.has(tabId) && !isOrionTab(tabId)) return

  if (panelOpenTabs.has(tabId)) {
    setActiveOriginTab(tabId)
  }

  // Capture screenshot only for Orion-managed tabs
  const s = await getSettings()
  if (s.onboardingComplete) {
    await captureScreenshot(tabId).catch(() => {})
  }
})

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bg-summarize') {
    await flushAllBuffers()
    if (!shouldSkipBackgroundAI()) {
      await runBackgroundSummarization()
    }
    // Periodic stale tab pruning — catches tabs closed while SW was suspended
    pruneStaleExtensionTabs().catch(() => {})
  }
  if (alarm.name === 'ai-action-learn') {
    await flushAllBuffers()
    if (!shouldSkipBackgroundAI()) {
      const s = await getSettings()
      // Health check before AI learning call
      const base = s.apiCapabilities?.baseUrl || s.lmStudioUrl
      if (s.activeProvider === 'local' && base) {
        const healthy = await quickHealthCheck(base, s.authToken)
        if (!healthy) {
          console.warn('[LocalAI] AI action learning skipped — endpoint unreachable')
          recordBgCallFailure()
          return
        }
      }
      try {
        await runAIActionLearningCycle(s)
        recordBgCallSuccess()
      } catch {
        recordBgCallFailure()
      }
    }
  }
  if (alarm.name === 'mempalace-learn') {
    if (!shouldSkipBackgroundAI()) {
      const s = await getSettings()
      await runMempalaceLearningCycle(s)
    }
  }
  if (alarm.name === 'telegram-poll') {
    const s = await getSettings()
    if (telegramEnabled(s)) {
      pollTelegramUpdates(s).catch(err => console.warn('[Telegram] Poll error:', err))
    }
  }
  if (alarm.name === 'vault-auto-lock') {
    const s = await getSettings()
    const timeoutMin = s.vaultLockTimeoutMin ?? 15
    if (timeoutMin > 0) {
      const idleMs = Date.now() - lastUserInteractionMs
      if (idleMs > timeoutMin * 60_000) {
        const unlocked = await isSessionUnlocked()
        if (unlocked) {
          await chrome.storage.session.remove('sessionKey')
          console.warn('[Orion] Vault auto-locked after idle timeout')
        }
      }
    }
  }
  // Watch mode alarm
  if (alarm.name.startsWith('watch-')) {
    const { parseWatchAlarmName, handleWatchAlarm } = await import('./watch-manager')
    const watchTabId = parseWatchAlarmName(alarm.name)
    if (watchTabId !== undefined) {
      const event = await handleWatchAlarm(watchTabId)
      if (event) {
        broadcastToPanel({ type: MSG.WATCH_EVENT, event })
      }
    }
  }
})

async function runBackgroundSummarization(): Promise<void> {
  const s = await getSettings()
  if (!s.monitoringEnabled || !s.onboardingComplete) return

  // Health check: verify the AI endpoint is reachable before attempting a call
  const baseUrl = s.apiCapabilities?.baseUrl || s.lmStudioUrl
  if (s.activeProvider === 'local' && baseUrl) {
    const healthy = await quickHealthCheck(baseUrl, s.authToken)
    if (!healthy) {
      console.warn('[LocalAI] Background summarize skipped — endpoint unreachable')
      recordBgCallFailure()
      return
    }
  }

  const recentMemory = await getRecentSessionMemory(30)
  if (recentMemory.length === 0) return

  const memoryText = recentMemory.map(m =>
    `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.type}: ${m.content}`
  ).join('\n')

  const summary = await callAI([
    {
      role: 'system',
      content: 'You are a browser activity summarizer. Summarize the user\'s recent browser activity in 2-3 sentences. Note key tasks, domains, and patterns. Be concise.',
    },
    {
      role: 'user',
      content: `Recent browser activity:\n${memoryText}\n\nProvide a 2-3 sentence summary.`,
    },
  ], s, 256)

  if (summary.length > 20) {
    recordBgCallSuccess()
    const domains = [...new Set(recentMemory.map(m => m.domain).filter(Boolean))]
    for (const domain of domains.slice(0, 3)) {
      await addSessionMemory({
        type: 'ai_summary',
        url: '',
        domain,
        content: summary,
        tags: ['ai-summary', ...domains.map(d => `domain:${d}`)],
        timestamp: Date.now(),
        sessionId,
      })
    }
  } else {
    // Empty or too-short response means the AI call failed silently
    recordBgCallFailure()
  }
}

async function runMempalaceLearningCycle(s: Settings): Promise<void> {
  if (!mempalaceEnabled(s)) return
  const base = s.apiCapabilities?.baseUrl || s.lmStudioUrl
  if (!base?.trim()) return

  // Health check before AI call
  if (s.activeProvider === 'local') {
    const healthy = await quickHealthCheck(base, s.authToken)
    if (!healthy) {
      console.warn('[LocalAI] Mempalace learning skipped — endpoint unreachable')
      recordBgCallFailure()
      return
    }
  }

  const recent = await getRecentSessionMemory(60)
  if (recent.length < 3) return

  const actionEntries = recent.filter(m => m.type === 'action')
  if (actionEntries.length > 0) {
    await pushSessionMemoryToPalace(
      s,
      actionEntries.map(m => ({ type: m.type, domain: m.domain, content: m.content, url: m.url }))
    ).catch(() => {})
  }

  const errBlob = await searchMempalace(s, 'recent error failure', {
    wing: 'wing_action_learning',
    room: 'hall_errors',
    limit: 8,
  }).catch(() => '')

  const successBlob = await searchMempalace(s, 'recent success completed', {
    wing: 'wing_action_learning',
    room: 'hall_successes',
    limit: 6,
  }).catch(() => '')

  if (!errBlob && !successBlob) return

  const messages = buildLessonDistillationPrompt(errBlob, successBlob)
  const lesson = await callAI(messages as Parameters<typeof callAI>[0], s, 600).catch(() => '')
  if (lesson && lesson.length > 30) {
    recordBgCallSuccess()
    await recordLesson(s, lesson, { source: 'auto-distill' }).catch(() => {})
  } else {
    recordBgCallFailure()
  }
}

// ─── Tab events ────────────────────────────────────────────────────────────────

// Catch tabs opened by link clicks (target="_blank") or window.open during automation.
// If a click causes a new tab, track it so it can be cleaned up.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id || !tab.openerTabId) return
  // Only track if the opener tab is one we're automating (has panel open)
  if (panelOpenTabs.has(tab.openerTabId) || isExtensionTab(tab.openerTabId)) {
    registerExtensionTab(tab.id)
    logTabEvent('created', tab.id, tab.pendingUrl ?? tab.url ?? '', 'click_popup')
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId)
  panelOpenTabs.delete(tabId)
  cleanupTabGroup(tabId)
  cleanupTelegramTab(tabId)
  cleanupWorkflowTab(tabId)
  unregisterExtensionTab(tabId)
  flushBuffer(tabId).then(() => clearTabBuffer(tabId)).catch(() => {})
  // Auto-collector: flush pending inputs then clean up buffer
  triggerFlush(tabId).catch(() => {}).finally(() => clearBuffer(tabId))
  broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
})

// Tab activation screenshot handled in the side panel onActivated listener above

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return
  const tid = details.tabId

  // Auto-rename Telegram tabs on navigation
  if (isTelegramTab(tid)) {
    notifyTabUrlChange(tid, details.url).catch(() => {})
  }

  // Auto-rename Orion groups on navigation (e.g., "Orion: New" → "Orion: gmail.com")
  if (hasOrionGroup(tid) && details.url) {
    const navDomain = extractDomain(details.url)
    if (navDomain && !details.url.startsWith('chrome://') && !details.url.startsWith('about:') && !details.url.startsWith('chrome-extension://')) {
      updateGroupTitle(tid, `Orion: ${navDomain}`).catch(() => {})
    }
  }

  await flushBuffer(tid)
  tabState.delete(tid)
})

// ─── Port-based streaming (sidepanel -> SW) ───────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_STT_RELAY) {
    sttRelayPort = port
    port.onDisconnect.addListener(() => { sttRelayPort = null })
    return
  }

  if (port.name !== PORT_AI_STREAM) return

  // Track panel ports for broadcasting (context menus, keyboard shortcuts)
  // Guard against memory leak: max 10 active ports
  if (activePanelPorts.size >= 10) {
    const oldest = activePanelPorts.values().next().value
    if (oldest) activePanelPorts.delete(oldest)
  }
  activePanelPorts.add(port)
  touchUserActivity()

  const streamPort = wrapStreamPort(port)
  port.onDisconnect.addListener(() => {
    activePanelPorts.delete(port)
    // Only abort streaming AI responses — do NOT cancel ongoing automation (action loops
    // must continue even if the side panel navigates away during a NAVIGATE action).
    // abortAllStreams() was too aggressive — it killed follow-up AI calls mid-automation.
  })

  port.onMessage.addListener((msg: Record<string, unknown>) => {
    void (async () => {
      const s = await getSettings()

      if (msg.type === MSG.AI_CHAT) {
        await handleAIChat(msg, s, streamPort)
      }

      if (msg.type === MSG.AI_RECALL) {
        await handleAIRecall(msg, s, streamPort)
      }

      if (msg.type === MSG.AI_REWRITE) {
        await handleAIRewrite(msg, s, streamPort)
      }

      if (msg.type === MSG.AI_MEMORY_SEARCH) {
        await handleAIMemorySearch(msg, s, streamPort)
      }

      if (msg.type === MSG.AI_ABORT) {
        const abortTabId = msg.tabId as number ?? 0
        abortStream(abortTabId)
        abortStream(`recall_${abortTabId}`)
        abortStream(`memsearch_${abortTabId}`)
        cancelAutomation(abortTabId)
      }

      if (msg.type === MSG.CONFIRM_RESPONSE) {
        const domain = extractDomain(tabState.get(msg.tabId as number ?? 0)?.url ?? '')
        await handleConfirmResponse(
          msg.id as string,
          msg.preference as ConfirmResponseType,
          (msg.actionTypes as string[]) ?? [],
          domain
        )
      }

      if (msg.type === MSG.MODE_CHOICE_RESPONSE) {
        await handleModeChoiceResponse(
          msg.id as string,
          msg.mode as 'auto' | 'guided',
          msg.remember as boolean ?? false
        )
      }

      if (msg.type === MSG.ANALYZE_PAGE) {
        await handlePageAnalysis(msg, await getSettings(), streamPort)
      }
    })().catch((err) => {
      console.warn('[ai-stream] handler failed:', err)
    })
  })
})

async function handleAIChat(
  msg: Record<string, unknown>,
  s: Settings,
  port: StreamPort
): Promise<void> {
  const userText = msg.text as string ?? ''
  const chatSessionId = msg.sessionId as string ?? sessionId
  const tabId = msg.tabId as number ?? 0
  const userImageData = msg.imageData as string | undefined

  // Pause guard — block AI calls for paused groups
  if (tabId > 0 && isTabInPausedGroup(tabId)) {
    port.postMessage({ type: MSG.STREAM_ERROR, error: 'Group is paused. Resume from the Groups panel.' })
    return
  }

      await appendChatMessage({
        sessionId: chatSessionId,
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        tabId,
      })

  const extractedInstruction = tryExtractInstructionToSave(userText)
  if (extractedInstruction) {
    // Prompt-engineer the instruction before saving
    const currentSnap = tabState.get(tabId)
    const pageType = classifyPage(currentSnap?.url ?? '', currentSnap?.title ?? '', currentSnap?.headings ?? [], '').type
    const formatted = await promptEngineerInstruction(
      extractedInstruction,
      pageType,
      (msgs, maxTok) => callAI(msgs as Parameters<typeof callAI>[0], s, maxTok),
    ).catch(() => extractedInstruction)
    await saveUserInstruction(formatted)
    port.postMessage({ type: MSG.STREAM_CHUNK, chunk: `> Saved to permanent memory: "${formatted}"\n\n` })
  }

  const piiMatches = detectPersonalData(userText)
  if (piiMatches.length > 0) {
    await storeDetectedPII(piiMatches, 'chat')
  }

  const chatDomain = extractDomain(tabState.get(tabId)?.url ?? '')
  try {
    const playbookMatch = await findMatchingPlaybook(userText, chatDomain, s)
    if (playbookMatch && playbookMatch.score >= 0.5) {
      const pb = playbookMatch.playbook
      port.postMessage({
        type: MSG.STREAM_CHUNK,
        chunk: `> Matched learned playbook "${pb.triggers[0]}" (confidence: ${Math.round(playbookMatch.score * 100)}%)\n> Steps: ${pb.steps.join(' \u2192 ')}\n\n`,
      })
    }
  } catch { /* playbook match is best-effort */ }

  if (tabId > 0) {
    await ensureContentScript(tabId)
    await requestFreshSnapshot(tabId)
  }

  const msgCount = (await getSessionMessages(chatSessionId, 500)).length
  if (msgCount > s.maxContextMessages) {
    chrome.runtime.sendMessage({ type: MSG.COMPACT_CONTEXT, sessionId: chatSessionId }).catch(() => {})
  }

  signalActivityBorder(tabId, true)

  let screenshotData: string | undefined
  let accessibilityTree: string | undefined
  let viewportMeta: { width: number; height: number; devicePixelRatio: number } | undefined

  // Detect if the tab is blank or restricted (no DOM interaction possible)
  let isBlankTab = false
  if (tabId > 0) {
    try {
      const tab = await chrome.tabs.get(tabId)
      const tabUrl = tab.url ?? ''
      isBlankTab = !tabUrl || tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('about:') || tabUrl.startsWith('edge://') || tabUrl.startsWith('brave://') || tabUrl.startsWith('devtools://')
    } catch { isBlankTab = true }
  }

  if (tabId > 0 && !isBlankTab) {
    let cdpResult: CDPTreeResult | null = null
    try {
      cdpResult = await getCDPAccessibilityTree(tabId)
    } catch { /* CDP unavailable */ }

    if (cdpResult) {
      accessibilityTree = cdpResult.treeText
      viewportMeta = { ...cdpResult.viewport, devicePixelRatio: cdpResult.viewport.devicePixelRatio ?? 1 }
    } else {
      try {
        const markerResult = await chrome.tabs.sendMessage(tabId, { type: MSG.INJECT_MARKERS }) as { ok: boolean; accessibilityTree?: string }
        if (markerResult?.ok && markerResult.accessibilityTree) {
          accessibilityTree = markerResult.accessibilityTree
        }
      } catch { /* markers not supported */ }
    }

    const miniMap: MiniMapResult | null = await captureMiniMap(tabId).catch(() => null)
    if (miniMap) {
      tabState.setScreenshot(tabId, miniMap.dataUrl)
      viewportMeta = miniMap.viewport
      // Always capture screenshot — the AI needs to see the page for navigation
      screenshotData = miniMap.dataUrl
    }

    if (!cdpResult) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: MSG.REMOVE_MARKERS })
      } catch { /* ignore */ }
    }
  }

      // PII redaction preview (PRD 13.3): detect and notify about redacted data
      const piiSnap = tabState.get(tabId)
      if (piiSnap && !isBlankTab) {
        const pageTextForPII = (piiSnap.visibleText ?? piiSnap.pageText ?? '').slice(0, 5000)
        const pagePIIMatches = detectPersonalData(pageTextForPII)
        if (pagePIIMatches.length > 0) {
          const typeCounts = new Map<string, number>()
          for (const m of pagePIIMatches) { typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1) }
          const summary = Array.from(typeCounts.entries()).map(([t, c]) => `${c} ${t}`).join(', ')
          port.postMessage({ type: MSG.STREAM_CHUNK, chunk: `> Detected sensitive data on page (${summary}) — masked before analysis\n\n` })
        }
      }

      let pageContext = tabState.summarize(tabId)
      if (isBlankTab) {
        pageContext = `This is a BLANK TAB — no website is loaded. You CANNOT type, click, or interact with any page elements.\nTo fulfill the user's request, use these background actions:\n- [ACTION:SEARCH query="..."] — Google search (works without a loaded page)\n- [ACTION:NAVIGATE url="..."] — open a website\n- [ACTION:OPEN_TAB url="..."] — open a URL in a research tab\nDo NOT use CLICK, TYPE, or other DOM actions until you have navigated to a real website.`
      }
      const history = await getSessionMessages(chatSessionId, s.maxContextMessages)
  // Tab-isolated memory: only this tab's memory, no cross-tab leaking
  const tabMem = await getTabMemory(tabId, 8)
  let memText = tabMem
    .map(m => {
      const date = new Date(m.timestamp)
      const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      return `[${dateStr}] ${m.content}`
    })
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('\n')
    .slice(0, 1400)

  const actionInsights = await getGlobalMemoryByDomain('ai_action_insights', 2)
  if (actionInsights.length > 0) {
    const insightBlock = actionInsights.map(e => {
      const date = new Date(e.timestamp)
      const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      return `[${dateStr}] ${e.summary}`
    }).join('\n').slice(0, 700)
    memText = `${memText}\n\nAI-learned activity hints:\n${insightBlock}`.slice(0, 2000)
  }

  let knownUserData: string | undefined
  const snap = tabState.get(tabId)
  if (snap && snap.forms.length > 0) {
    const personalEntries = await getGlobalMemoryByDomain('personal_data', 20)
    if (personalEntries.length > 0) {
      knownUserData = personalEntries.map(e => e.summary).join('\n')
    }
  }

  const currentDomain = extractDomain(tabState.get(tabId)?.url ?? '')
  const domainSkills = await getSkillsForDomain(currentDomain)
  const skillsText = formatSkillsForPrompt(domainSkills)

  const userBehaviors = await getBehaviorsForDomain(currentDomain)
  const behaviorText = formatBehaviorsForPrompt(userBehaviors)

  const userInstructionEntries = await getAllUserInstructions()
  // Pass current page type so domain-tagged instructions are prioritized
  const pageTypeForInstructions = classifyPage(tabState.get(tabId)?.url ?? '', tabState.get(tabId)?.title ?? '', tabState.get(tabId)?.headings ?? [], '').type
  const userInstructionsText = formatUserInstructionsForPrompt(userInstructionEntries, pageTypeForInstructions)

  let mempalaceBlock: string | undefined
  if (mempalaceEnabled(s) && userText.trim().length > 0) {
    const recalled = await recallRelevantMemories(s, userText, currentDomain).catch(() => '')
    if (recalled) mempalaceBlock = recalled
  }
  // Local memory recall (always-available, no external server)
  if (localMemoryEnabled(s) && userText.trim().length > 0) {
    const localRecalled = await recallLocalMemories(userText, currentDomain).catch(() => '')
    if (localRecalled) {
      mempalaceBlock = mempalaceBlock
        ? mempalaceBlock + '\n\n' + localRecalled
        : localRecalled
    }
  }

  const isExternalProvider = s.activeProvider === 'gemini' || s.activeProvider === 'openai' || s.activeProvider === 'anthropic'
  const effectiveCapabilities = isExternalProvider
    ? { ...s.apiCapabilities, supportsVision: true }
    : s.apiCapabilities

  // Build sitemap context for the current domain
  const sitemapText = await getSitemapForPrompt(currentDomain)
  const currentSnap = tabState.get(tabId)

  // ── Prompt Pipeline: intent → structured context → optimized prompt ──
  const isLocal = (s.activeProvider ?? 'local') === 'local'
  const ctxWindow = s.contextWindowTokens || (s.liteMode ? 8192 : (isLocal ? 32768 : 131072))

  // Load pinned facts for prompt context
  let pinnedFactsText = ''
  try {
    const { getPinnedFacts, formatPinnedFactsForPrompt } = await import('./pinned-facts-manager')
    const pinnedFacts = await getPinnedFacts()
    pinnedFactsText = formatPinnedFactsForPrompt(pinnedFacts)
  } catch { /* ignore — store may not exist yet */ }

  // Load additional tab contexts for cross-tab compare
  let additionalTabs: Array<{ title: string; url: string; text: string }> | undefined
  const additionalTabIds = msg.additionalTabIds as number[] | undefined
  if (additionalTabIds && additionalTabIds.length > 0) {
    additionalTabs = []
    for (const atId of additionalTabIds.slice(0, 3)) {
      try {
        const tab = await chrome.tabs.get(atId)
        const textResp = await chrome.tabs.sendMessage(atId, { type: MSG.REQUEST_PAGE_TEXT }) as { ok?: boolean; text?: string }
        additionalTabs.push({
          title: tab.title ?? '',
          url: tab.url ?? '',
          text: (textResp?.text ?? '').slice(0, 7000),
        })
      } catch { /* tab may not have content script */ }
    }
  }

  const pipelineResult = buildPromptPipeline({
    userText,
    pageSnapshot: currentSnap,
    accessibilityTree,
    viewportMeta,
    memories: memText,
    skills: skillsText,
    behaviors: behaviorText,
    instructions: userInstructionsText,
    mempalace: mempalaceBlock ?? '',
    sitemap: sitemapText,
    capabilities: effectiveCapabilities,
    isLocal,
    contextWindow: ctxWindow,
    liteMode: s.liteMode ?? false,
    knownUserData,
    explanationDepth: (msg.explanationDepth as 'quick' | 'standard' | 'deep') || undefined,
    pinnedFacts: pinnedFactsText,
    additionalTabs,
  })

  const systemPrompt = pipelineResult.systemPrompt
  console.warn(`[LocalAI] Prompt pipeline: intent=${pipelineResult.intent.category} (${Math.round(pipelineResult.intent.confidence * 100)}%), complexity=${pipelineResult.intent.complexity}, page=${pipelineResult.pageClassification.type}, taskPlan=${pipelineResult.taskPlan ? pipelineResult.taskPlan.steps.length + ' steps' : 'none'}`)

  // ── Form Assist: intercept fill_form intent when page has forms ──
  if (pipelineResult.intent.category === 'fill_form' && currentSnap && currentSnap.forms.length > 0) {
    try {
      await analyzeAndGenerateFormValues(tabId, s, port)
      return // Form assist card sent — skip normal AI flow
    } catch (err) {
      console.warn('[FormAssist] Falling back to normal AI flow:', err)
      // Fall through to normal AI chat flow
    }
  }

  let messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] = [
    { role: 'system', content: systemPrompt },
    ...history.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.content,
      imageData: undefined as string | undefined,
    })),
  ]

  // Replace last user message with enhanced version (if expanded)
  if (pipelineResult.enhancedUserMessage !== userText) {
    const lastUserIdx = messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1)
    if (lastUserIdx >= 0) messages[lastUserIdx].content = pipelineResult.enhancedUserMessage
  }

  // Token-aware history truncation
  const systemTokens = estimateTokens(systemPrompt)
  const outputReserve = getAdaptiveMaxTokens(s, true)
  messages = [
    messages[0], // Keep system message
    ...truncateMessagesToFit(
      messages.slice(1), // History without system
      systemTokens,
      ctxWindow,
      outputReserve
    ),
  ]

  // Attach image: user-uploaded image takes priority over auto-screenshot
  const isExternalMultimodal = isExternalProvider
  const visionCapable = s.visionEnabled || isExternalMultimodal || (effectiveCapabilities?.supportsVision ?? false)
  const imageToAttach = userImageData || screenshotData
  if (imageToAttach && visionCapable) {
    const lastIdx = messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1)
    if (lastIdx >= 0) messages[lastIdx].imageData = imageToAttach
  }

  const fullText = await streamChat(messages, s, port, tabId)
  signalActivityBorder(tabId, false)
  if (fullText) {
    await appendChatMessage({
      sessionId: chatSessionId,
      role: 'assistant',
      content: fullText,
      timestamp: Date.now(),
      tabId,
    })

    const actions = parseActionsFromText(fullText)
    if (tabId > 0) {
      // If AI produced no actions, trust that decision — skip the entire execution pipeline.
      // This prevents auto-kickstart from forcing unnecessary action loops for questions,
      // text corrections, explanations, and other text-only responses.
      if (actions.length === 0) {
        return
      }

      let guided = false

      if (actions.length > 0) {
        // V3: Execution mode check — suppress or disable actions if needed
        if (shouldSuppressActions(currentExecutionMode)) {
          // ask_only mode: strip all actions, just show text
          actions.length = 0
        } else if (shouldDisableExecution(currentExecutionMode)) {
          // suggest mode: show action descriptions in chat but don't execute
          const desc = actions.map(a => `- **${a.action}** ${a.params.selector ?? a.params.value ?? ''}`).join('\n')
          port.postMessage({ type: MSG.STREAM_CHUNK, chunk: `\n\n**Suggested actions** (execution disabled in current mode):\n${desc}\n` })
          actions.length = 0
        }
      }

      if (actions.length > 0) {
        const risk = classifyActionRisk(actions)
        const domain = extractDomain(tabState.get(tabId)?.url ?? '')
        const currentSnapshot = tabState.get(tabId)

        // Submit Guard: detect final/irreversible actions even if keyword risk is just 'write'
        const needsSubmitGuard = risk !== 'destructive' &&
          isSubmitGuardAction(actions, currentSnapshot)
        const effectiveRisk = needsSubmitGuard ? 'destructive' as const : risk

        // V3: Auto-approve based on execution mode
        const modeAutoApproved = shouldAutoApprove(currentExecutionMode, effectiveRisk)

        // Destructive or submit-guarded actions need confirmation (dual-channel: chat + Telegram)
        if (effectiveRisk === 'destructive' && !modeAutoApproved) {
          const confirmed = await requestConfirmation(port, actions, effectiveRisk, tabId, chatSessionId, currentSnapshot)
          if (!confirmed) {
            port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n*Action declined by user.*\n' })
            port.postMessage({ type: MSG.STREAM_END, fullText: fullText + '\n\n*Action declined by user.*' })
            return
          }
        }

        // Determine execution mode
        const pref = s.automationPreference ?? 'ask'
        if (pref === 'guided') {
          guided = true
        } else if (pref === 'ask' && risk !== 'read') {
          // Ask user to choose mode (skip for read-only actions)
          const mode = await requestModeChoice(port, actions)
          guided = mode === 'guided'
        }
        // pref === 'auto' → guided stays false
      }

      updateBadge('active')

      try {
        await executeWithFollowUp(
          fullText, tabId, s, port,
          messages.map(m => ({ role: m.role, content: m.content })),
          25, guided
        )
        updateBadge('idle')
        orionNotify('Task Complete', `Finished automation on ${extractDomain(tabState.get(tabId)?.url ?? '')}`)
      } catch {
        updateBadge('error')
      }
    }
  }
}

async function handlePageAnalysis(
  msg: Record<string, unknown>,
  s: Settings,
  port: StreamPort
): Promise<void> {
  const tabId = msg.tabId as number ?? 0
  const chatSessionId = msg.sessionId as string ?? sessionId

  if (tabId > 0) {
    await ensureContentScript(tabId)
    await requestFreshSnapshot(tabId)
  }

  let screenshotData: string | undefined
  let a11yTree: string | undefined

  if (tabId > 0) {
    try {
      const markerResult = await chrome.tabs.sendMessage(tabId, { type: MSG.INJECT_MARKERS }) as { ok: boolean; accessibilityTree?: string }
      if (markerResult?.ok && markerResult.accessibilityTree) {
        a11yTree = markerResult.accessibilityTree
      }
    } catch { /* markers not supported */ }

    if (s.visionEnabled) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 50 })
        tabState.setScreenshot(tabId, dataUrl)
        screenshotData = dataUrl
      } catch { /* not capturable */ }
    }

    try {
      await chrome.tabs.sendMessage(tabId, { type: MSG.REMOVE_MARKERS })
    } catch { /* ignore */ }
  }

  const pageContext = tabState.summarize(tabId)

  const analysisPrompt = `You are a page capability analyzer. Analyze the current page and provide a comprehensive summary of what the user can do here.

Current page state:
${pageContext}
${a11yTree ? `\nAccessibility Tree:\n${a11yTree}` : ''}

Respond with a SHORT but informative analysis in Markdown:
1. **What is this page?** (one line)
2. **Available actions:** List the key things the user can do (buttons, forms, navigation). Be specific — mention actual button names and form fields.
3. **Quick tips:** 1-2 suggestions for how you can help on this page.

Keep it concise. Use bullet points. Format beautifully. Do NOT output any actions or raw HTML.`

  const messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] = [
    { role: 'system', content: analysisPrompt },
    { role: 'user', content: 'Analyze this page for me.', imageData: screenshotData },
  ]

      const fullText = await streamChat(messages, s, port, tabId)

      if (fullText) {
        await appendChatMessage({
          sessionId: chatSessionId,
          role: 'assistant',
          content: fullText,
          timestamp: Date.now(),
          tabId,
        })
      }
    }

async function handleAIRecall(
  msg: Record<string, unknown>,
  s: Settings,
  port: StreamPort
): Promise<void> {
  const query = msg.query as string ?? ''
  const chatSessionId = msg.sessionId as string ?? sessionId
  const tabId = msg.tabId as number ?? 0

      const sessionMem = await getRecentSessionMemory(50)
      const globalMem = await getAllGlobalMemory(20)
      const memContext = [
        ...sessionMem.map(m => `[${new Date(m.timestamp).toLocaleDateString()} ${m.type}] ${m.content}`),
        ...globalMem.map(m => `[Summary] ${m.summary}`),
      ].join('\n').slice(0, 3000)

  const messages: Pick<ChatMessage, 'role' | 'content'>[] = [
        {
          role: 'system',
          content: 'You are a memory recall assistant. Answer the user\'s question based strictly on the provided browser activity logs. If the information isn\'t in the logs, say so.',
        },
        {
          role: 'user',
          content: `Browser activity log:\n${memContext}\n\nQuestion: ${query}`,
        },
      ]

      await streamChat(messages, s, port, `recall_${tabId}`)
    }

// ── AI Memory Search ─────────────────────────────────────────────────────────

const MEMORY_SEARCH_SYSTEM_PROMPT = `You are a memory search assistant for the Orion browser assistant.
The user is searching their browsing history, saved memories, and Input Journal. Your job is to find and present the most relevant results.

You have access to an Input Journal (Total Recall) that records form inputs the user has entered across all websites — emails, usernames, passwords, addresses, names, phone numbers, etc. When the user asks about data they entered, check the Input Journal section first.

RULES:
- Format every URL as a clickable markdown link: [Page Title or description](url)
- Include when the page was visited (date/time) if available
- NEVER fabricate or guess URLs — only use URLs that appear in the provided context
- When the query is vague, use all context clues (domain names, page content, timestamps) to identify the best match
- Present the BEST match first, then alternatives if any exist
- If nothing matches, say so honestly — do not make up results
- Be concise — the user wants the link/data, not a long explanation
- If multiple results match, present them as a numbered list with dates and domains
- For Input Journal entries, show the field label, value, domain, and date clearly
- If a journal entry shows [encrypted], tell the user the data exists but requires PIN unlock to view`

async function handleAIMemorySearch(
  msg: Record<string, unknown>,
  s: Settings,
  port: StreamPort
): Promise<void> {
  const query = msg.query as string ?? ''
  const tabId = msg.tabId as number ?? 0

  if (!query.trim()) {
    port.postMessage({ type: MSG.STREAM_ERROR, error: 'Please enter a search query.' })
    return
  }

  // Parallel search: IDB text search + MemPalace semantic search + Local Memory + URL-rich session memory + Input Journal
  const [idbResults, mempalaceResults, localMemResults, sessionEntries, journalResults] = await Promise.all([
    searchAllHistory(query).catch(() => ''),
    mempalaceEnabled(s)
      ? searchMempalace(s, query, { limit: 8 }).catch(() => '')
      : Promise.resolve(''),
    localMemoryEnabled(s)
      ? searchLocalMemory(query, { limit: 8 }).catch(() => '')
      : Promise.resolve(''),
    getRecentSessionMemory(80).catch(() => [] as Awaited<ReturnType<typeof getRecentSessionMemory>>),
    searchInputJournal(query, 20).catch(() => ''),
  ])

  // Build URL context from session entries
  const urlEntries = sessionEntries
    .filter(e => e.url && e.url.startsWith('http'))
    .map(e => ({
      date: new Date(e.timestamp).toLocaleDateString(),
      type: e.type,
      domain: extractDomain(e.url),
      url: e.url,
      content: e.content.slice(0, 200),
    }))

  const urlContext = urlEntries
    .map(e => `[${e.date} | ${e.type} | ${e.domain}] ${e.url} -- ${e.content}`)
    .join('\n')
    .slice(0, 4000)

  // Send raw results to UI for collapsible display
  port.postMessage({
    type: MSG.MEMORY_SEARCH_CONTEXT,
    idbResults: idbResults.slice(0, 3000),
    mempalaceResults: mempalaceResults.slice(0, 3000),
    urlEntries: urlEntries.slice(0, 30),
    journalResults: journalResults.slice(0, 3000),
  })

  // Build combined context for AI
  const sections: string[] = []
  if (urlContext) sections.push(`## Browsing History (URLs and pages visited)\n${urlContext}`)
  if (idbResults) sections.push(`## Text Search Results\n${idbResults.slice(0, 2500)}`)
  if (mempalaceResults) sections.push(`## Semantic Memory (MemPalace)\n${mempalaceResults.slice(0, 2500)}`)
  if (localMemResults) sections.push(`## Local Memory\n${localMemResults.slice(0, 2500)}`)
  if (journalResults) sections.push(`## Input Journal (Total Recall)\n${journalResults.slice(0, 2500)}`)

  const combinedContext = sections.join('\n\n').slice(0, 8000)

  if (!combinedContext.trim()) {
    port.postMessage({ type: MSG.STREAM_END, fullText: 'No results found in your browsing history or memory for this query.' })
    return
  }

  const messages: Pick<ChatMessage, 'role' | 'content'>[] = [
    { role: 'system', content: MEMORY_SEARCH_SYSTEM_PROMPT },
    { role: 'user', content: `Memory context:\n${combinedContext}\n\nSearch query: ${query}` },
  ]

  await streamChat(messages, s, port, `memsearch_${tabId}`)
}

async function handleAIRewrite(
  msg: Record<string, unknown>,
  s: Settings,
  port: StreamPort
): Promise<void> {
  const text = msg.text as string ?? ''
  const tone = msg.tone as string ?? 'professional'
  const tabId = msg.tabId as number ?? 0

  const messages: Pick<ChatMessage, 'role' | 'content'>[] = [
    {
      role: 'system',
      content: `You are a text improvement assistant. Rewrite the user's text to be more ${tone}. Fix grammar and spelling. Keep the original meaning. Return ONLY the improved text, nothing else.`,
    },
    { role: 'user', content: text },
  ]

  await streamChat(messages, s, port, `rewrite_${tabId}`)
}

// ─── Regular messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  touchUserActivity()
  handleMessage(msg, sender).then(sendResponse).catch((err: Error) => {
    sendResponse({ ok: false, error: err.message })
  })
  return true
})

async function handleMessage(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  const tabId = sender.tab?.id ?? 0
  const s = await getSettings()

  switch (msg.type) {
    case MSG.PAGE_SNAPSHOT: {
      const snap = msg.payload as PageSnapshot
      tabState.set(tabId, snap)
      // Record page visit in visual sitemap (without screenshot — the screenshot loop handles that)
      const snapDomain = extractDomain(snap.url)
      if (snapDomain) {
        recordPageVisit(snapDomain, snap.url, snap).catch(() => {})
      }
      if (s.monitoringEnabled && snap.forms.length > 0) {
        await addSessionMemory({
          type: 'form_detected',
          url: snap.url,
          domain: snapDomain,
          content: `Form detected on ${snap.title}: ${snap.forms.map(f => describeForm(f)).join('; ')}`,
          tags: ['form', `domain:${snapDomain}`],
          timestamp: Date.now(),
          sessionId,
          tabId,
        })
      }
      return { ok: true }
    }

    case MSG.STOP_AUTOMATION: {
      // Stop button clicked on the page — cancel automation loop and abort any streaming
      cancelAutomation(tabId)
      abortStream(tabId)
      return { ok: true }
    }

    case MSG.PAGE_TEXT: {
      const snap = tabState.get(tabId)
      if (snap) {
        snap.pageText = msg.pageText as string
        snap.visibleText = msg.visibleText as string
        if (typeof msg.completePageText === 'string') {
          snap.completePageText = msg.completePageText
        }
        tabState.set(tabId, snap)

        if (snap.forms.length > 0) {
          const pagePII = detectPersonalData(snap.visibleText ?? '')
          if (pagePII.length > 0) {
            storeDetectedPII(pagePII, `page:${extractDomain(snap.url)}`).catch(() => {})
          }
        }

        // Record page visit with real text content (now available).
        // Recording here — not in PAGE_SNAPSHOT — is correct: snapshots arrive before
        // text extraction completes, so snap.visibleText is always undefined at snapshot time.
        if (s.monitoringEnabled && snap.url &&
            !snap.url.startsWith('chrome://') && !snap.url.startsWith('chrome-extension://')) {
          const ptDomain = extractDomain(snap.url)
          if (ptDomain) {
            const nowPt = Date.now()
            const lastPt = recentlyRecordedUrls.get(snap.url)
            if (!lastPt || nowPt - lastPt >= 60_000) {
              recentlyRecordedUrls.set(snap.url, nowPt)
              // Keep map bounded
              if (recentlyRecordedUrls.size > 500) {
                const cutoffPt = nowPt - 120_000
                for (const [u, t] of recentlyRecordedUrls) { if (t < cutoffPt) recentlyRecordedUrls.delete(u) }
              }
              const pageVisitText = (snap.visibleText ?? snap.pageText ?? '').slice(0, 2000)
              // Only store if there is something meaningful to recall
              if (pageVisitText.trim().length > 20 || (snap.title ?? '').trim().length > 0) {
                await addSessionMemory({
                  type: 'page_visit',
                  url: snap.url,
                  domain: ptDomain,
                  content: `${snap.title ?? ''}\n${snap.url}\n${pageVisitText}`,
                  tags: ['page', `domain:${ptDomain}`],
                  timestamp: nowPt,
                  sessionId,
                  tabId,
                })
              }
            }
          }
        }
      }
      return { ok: true }
    }

    case MSG.REQUEST_COMPOSE_REWRITE: {
      if (s.textRewriteEnabled === false || s.composeAssistantEnabled === false) {
        return { ok: false, error: 'disabled' }
      }
      const raw = (msg.text as string)?.trim() ?? ''
      if (raw.length < 20) return { ok: false, error: 'too_short' }
      const composeCtx = (msg.composeContext as string) ?? 'general'
      const composeDetail = (msg.composeDetail as string) ?? 'text'
      const pageTitle = (msg.pageTitle as string) ?? ''
      const systemPrompt = buildRewriteSystemPrompt(composeCtx, composeDetail, pageTitle)
      const improved = await callAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: raw.slice(0, 12_000) },
        ],
        s,
        2048
      )
      const out = improved?.trim()
      if (!out) return { ok: false, error: 'empty' }
      return { ok: true, improved: out }
    }

    case MSG.TEXT_SELECTED: {
      const snap = tabState.get(tabId)
      if (snap) {
        snap.selectedText = msg.text as string
        tabState.set(tabId, snap)
      }
      return { ok: true }
    }

    case MSG.USER_ACTION: {
      // Only record actions from Orion-managed tabs
      if (s.monitoringEnabled && (panelOpenTabs.has(tabId) || isOrionTab(tabId))) {
        recordAction(tabId, msg.event as Parameters<typeof recordAction>[1], sessionId)
      }
      if (isSupervisedActive()) {
        feedUserEvent(msg.event as Parameters<typeof feedUserEvent>[0])
      }
      // Auto-collection: buffer user form inputs for extraction
      if (autoCollectEnabled(s) && tabId > 0) {
        const evt = msg.event as {
          type: string; selector?: string; value?: string; tagName?: string;
          inputType?: string; fieldLabel?: string; detail?: string
        }
        const snap = tabState.get(tabId)
        const domain = snap?.url ? extractDomain(snap.url) : ''
        if (domain) {
          bufferUserInput(tabId, domain, snap?.url ?? '', evt)
        }
        // Flush on form submit or navigation
        if (evt.type === 'submit' || evt.type === 'navigate') {
          triggerFlush(tabId).catch(() => {})
        }

        // Total Recall: journal every meaningful input
        if ((evt.type === 'input' || evt.type === 'change') && evt.value?.trim()) {
          const detailParts = (evt.detail ?? '').split('|')
          const fieldName = detailParts[0] || ''
          const fieldAutocomplete = detailParts[1] || ''
          const fieldType = classifyFieldFromEvent(evt.inputType ?? 'text', fieldName, evt.fieldLabel ?? '', fieldAutocomplete)
          journalInput({
            fieldType,
            fieldLabel: evt.fieldLabel || fieldName || evt.selector || '',
            value: evt.value,
            encrypted: false,
            domain,
            url: snap?.url ?? '',
            inputType: evt.inputType || 'text',
            timestamp: Date.now(),
            source: 'user_action',
          }).catch(() => {})
        }
      }
      return { ok: true }
    }

    case MSG.FLUSH_ACTION_BUFFER: {
      if (tabId <= 0) return { ok: false, error: 'no_tab' }
      if (s.monitoringEnabled) {
        await flushBuffer(tabId)
      }
      return { ok: true }
    }

    // ── Vault CRUD ────────────────────────────────────────────────────────────
    case MSG.VAULT_LIST: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      const entries = await vaultList()
      return { ok: true, entries: entries.map(e => ({ id: e.id, category: e.category, label: e.label, updatedAt: e.updatedAt, autoCollected: e.autoCollected, sourceDomain: e.sourceDomain })) }
    }

    case MSG.VAULT_GET: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      const entry = await vaultGet(msg.id as string)
      if (!entry) return { ok: false, error: 'NOT_FOUND' }
      const plaintext = await decryptData(entry.encryptedData)
      return { ok: true, data: JSON.parse(plaintext) }
    }

    case MSG.VAULT_SET: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      const { id, category, label, data } = msg as { id: string; category: VaultCategory; label: string; data: VaultData }
      const encryptedData = await encryptData(JSON.stringify(data))
      const existing = await vaultGet(id)
      await vaultSet({
        id, category, label, encryptedData,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      })
      return { ok: true }
    }

    case MSG.VAULT_DELETE: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      await vaultDelete(msg.id as string)
      return { ok: true }
    }

    // ── PIN / Session ─────────────────────────────────────────────────────────
    case MSG.SETUP_PIN: {
      await setupPin(msg.pin as string)
      await setSettings({ hasPinSetup: true })  // Sync to IDB
      settings = null
      return { ok: true }
    }

    case MSG.UNLOCK_SESSION: {
      const success = await unlockWithPin(msg.pin as string)
      return { ok: success, error: success ? undefined : 'Wrong PIN' }
    }

    case MSG.SESSION_STATUS: {
      const unlocked = await isSessionUnlocked()
      return { ok: true, unlocked, hasPinSetup: s.hasPinSetup }
    }

    case MSG.CHANGE_PIN: {
      const { oldPin, newPin } = msg as { oldPin: string; newPin: string }
      const success = await changePin(oldPin, newPin)
      if (success) settings = null  // Clear cache after re-encryption
      return { ok: success, error: success ? undefined : 'Wrong PIN' }
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    case MSG.SETTINGS_GET: {
      return { ok: true, settings: s }
    }

    case MSG.SETTINGS_SET: {
      const partial = msg.partial as Partial<Settings>
      await setSettings(partial)
      settings = null
      // Reset background AI failure counter when settings change (e.g., new model, new endpoint)
      resetBgCallFailures()
      return { ok: true }
    }

    case MSG.SET_EXECUTION_MODE: {
      currentExecutionMode = (msg.mode as import('../shared/types').ExecutionMode) || 'approve'
      chrome.storage.local.set({ executionMode: currentExecutionMode }).catch(() => {})
      return { ok: true, mode: currentExecutionMode }
    }

    case 'GROUP_ACTIVE_TAB': {
      const tid = msg.tabId as number
      if (tid > 0) {
        panelOpenTabs.add(tid)
        await chrome.sidePanel.setOptions({
          tabId: tid, path: 'sidepanel/sidepanel.html', enabled: true,
        }).catch(() => {})
        await createGroupForTab(tid)
        broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
      }
      return { ok: true }
    }

    case 'PANEL_CLOSED': {
      const tid = msg.tabId as number
      if (tid > 0) {
        panelOpenTabs.delete(tid)
        await chrome.sidePanel.setOptions({ tabId: tid, enabled: false }).catch(() => {})
        await ungroupTab(tid)
        broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
      }
      return { ok: true }
    }

    case MSG.MEMPALACE_PROBE: {
      const url = (msg.url as string)?.trim() || s.mempalaceBridgeUrl?.trim() || ''
      if (!url) return { ok: false, error: 'no_url' }
      const h = await probeMempalaceBridge(url)
      return { ok: h.ok, mempalaceInstalled: h.mempalaceInstalled, palacePath: h.palacePath, inboxDir: h.inboxDir, error: h.error }
    }

    case MSG.MEMPALACE_PUSH_INBOX: {
      const url = (msg.url as string)?.trim() || s.mempalaceBridgeUrl?.trim() || ''
      if (!url) return { ok: false, error: 'no_url' }
      const recent = await getRecentSessionMemory(100)
      const count = await pushSessionMemoryToPalace(
        s,
        recent.map(m => ({ type: m.type, domain: m.domain, content: m.content, url: m.url }))
      )
      return { ok: true, stored: count }
    }

    case MSG.MODELS_LIST: {
      const url = (msg.url as string) || s.lmStudioUrl
      const token = (msg.authToken as string) || s.authToken
      const models = await fetchModels(url, token)
      return { ok: true, models }
    }

    // ── Endpoint probing ──────────────────────────────────────────────────────
    case MSG.PROBE_ENDPOINT: {
      const url = msg.url as string
      const authToken = msg.authToken as string | undefined
      try {
        const caps = await probeEndpoint(url, authToken)
        return { ok: true, capabilities: caps }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    case MSG.AI_HEALTH_CHECK: {
      const s = await getAllSettings()
      const provider = s.activeProvider || 'local'
      // For cloud providers, verify API key is set; for local, ping the endpoint
      if (provider === 'gemini') {
        return { ok: true, connected: !!s.geminiApiKey, provider }
      }
      if (provider === 'openai') {
        return { ok: true, connected: !!s.openaiApiKey, provider }
      }
      if (provider === 'anthropic') {
        return { ok: true, connected: !!s.anthropicApiKey, provider }
      }
      // Local: actually ping
      const base = (s.apiCapabilities?.baseUrl || s.lmStudioUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '')
      if (!base) return { ok: true, connected: false, provider }
      const healthy = await quickHealthCheck(base, s.authToken)
      return { ok: true, connected: healthy, provider }
    }

    // ── Chat history ──────────────────────────────────────────────────────────
    case MSG.CHAT_SESSION_LIST: {
      const sessions = await getAllSessions()
      return { ok: true, sessions }
    }

    case MSG.CHAT_LOAD_SESSION: {
      const msgs = await getSessionMessages(msg.sessionId as string, 200)
      return { ok: true, messages: msgs }
    }

    // ── Session / context management ───────────────────────────────────────
    case MSG.RESOLVE_SESSION: {
      const targetTabId = msg.tabId as number
      try {
        const tab = await chrome.tabs.get(targetTabId)
        const domain = extractDomain(tab.url ?? '')
        // Priority 1: group-based session (tabs in same Orion group share chat)
        const groupSid = await resolveGroupSession(targetTabId)
        if (groupSid) return { ok: true, sessionId: groupSid, domain, url: tab.url ?? '' }
        // Priority 2: domain-based (non-grouped tabs / legacy)
        const sid = `session_domain_${domain}`
        return { ok: true, sessionId: sid, domain, url: tab.url ?? '' }
      } catch {
        return { ok: true, sessionId: `session_tab_${msg.tabId}`, domain: '', url: '' }
      }
    }

    case MSG.CLEAR_SESSION: {
      const sid = msg.sessionId as string
      await clearSessionChat(sid)
      return { ok: true }
    }

    case MSG.COMPACT_CONTEXT: {
      const compactSid = msg.sessionId as string
      const allMsgs = await getSessionMessages(compactSid, 500)
      if (allMsgs.length <= 6) return { ok: true, compacted: false }

      const toCompact = allMsgs.slice(0, -4)
      const compactText = toCompact
        .filter(m => m.role !== 'system')
        .map(m => `[${m.role}] ${m.content.slice(0, 300)}`)
        .join('\n')
        .slice(0, 3000)

      const summary = await callAI([
        { role: 'system', content: 'Summarize this conversation history in 2-4 sentences, preserving key facts, decisions, and context the user would need to continue. Be concise but complete.' },
        { role: 'user', content: compactText },
      ], s, 400)

      if (summary.length > 20) {
        for (const m of toCompact) {
          if (m.id !== undefined) {
            await import('../shared/idb').then(idb => idb.dbDelete(STORE.CHAT_HISTORY, m.id!))
          }
        }
        await appendChatMessage({
          sessionId: compactSid,
          role: 'system',
          content: `[Context Summary] ${summary}`,
          timestamp: toCompact[0]?.timestamp ?? Date.now(),
        })
        return { ok: true, compacted: true, summary }
      }
      return { ok: true, compacted: false }
    }

    case MSG.GLOBAL_SEARCH: {
      const query = msg.query as string
      const searchResults = await searchAllHistory(query)
      return { ok: true, results: searchResults }
    }

    // ── Memory ────────────────────────────────────────────────────────────────
    case MSG.MEMORY_LIST: {
      const [session, global] = await Promise.all([getRecentSessionMemory(50), getAllGlobalMemory(20)])
      return { ok: true, session, global }
    }

    case MSG.MEMORY_CLEAR: {
      const target = msg.target as string
      if (target === 'session') await clearSessionMemory()
      else if (target === 'global') await clearGlobalMemory()
      else if (target === 'chat') await clearChatHistory()
      else {
        await clearSessionMemory()
        await clearGlobalMemory()
        await clearChatHistory()
      }
      return { ok: true }
    }

    case MSG.MEMORY_EXPORT: {
      const data = await exportMemory()
      return { ok: true, data }
    }

    case MSG.FULL_BACKUP: {
      const backup = await exportFullBackup()
      return { ok: true, data: backup }
    }

    case MSG.FULL_RESTORE: {
      const result = await importFullBackup(msg.backup as Record<string, unknown>)
      return { ok: true, ...result }
    }

    // ── Cross-Tab ─────────────────────────────────────────────────────────────
    case MSG.GET_TAB_LIST: {
      const tabs = await chrome.tabs.query({ currentWindow: true })
      const list = tabs
        .filter(t => t.id && !t.url?.startsWith('chrome://') && !t.url?.startsWith('chrome-extension://'))
        .map(t => ({ id: t.id!, title: t.title ?? '', url: t.url ?? '', active: t.active ?? false }))
      return { ok: true, tabs: list }
    }

    // ── Watch Mode ────────────────────────────────────────────────────────────
    case MSG.WATCH_START: {
      const { startWatch } = await import('./watch-manager')
      const watchTabId = (msg.tabId as number) || sender.tab?.id
      if (!watchTabId) return { ok: false, error: 'No tab' }
      // Get initial baseline from content script
      let baseline = ''
      try {
        const snap = await chrome.tabs.sendMessage(watchTabId, {
          type: MSG.WATCH_CHECK,
          selector: msg.selector as string | undefined,
        }) as { ok?: boolean; currentValue?: string }
        if (snap?.ok) baseline = snap.currentValue ?? ''
      } catch { /* tab may not have content script */ }
      const session = startWatch(watchTabId, msg.selector as string | undefined, baseline, msg.intervalSec as number | undefined)
      return { ok: true, session }
    }
    case MSG.WATCH_STOP: {
      const { stopWatch } = await import('./watch-manager')
      const wTabId = (msg.tabId as number) || sender.tab?.id
      if (wTabId) stopWatch(wTabId)
      return { ok: true }
    }
    case MSG.WATCH_SNAPSHOT: {
      const { getWatchSession } = await import('./watch-manager')
      const sTabId = (msg.tabId as number) || sender.tab?.id
      const session = sTabId ? getWatchSession(sTabId) : undefined
      return { ok: true, session: session ?? null }
    }

    // ── Pinned Facts ──────────────────────────────────────────────────────────
    case MSG.PIN_FACT: {
      const { addPinnedFact } = await import('./pinned-facts-manager')
      await addPinnedFact(msg.fact as import('../shared/types').PinnedFact)
      return { ok: true }
    }
    case MSG.UNPIN_FACT: {
      const { deletePinnedFact } = await import('./pinned-facts-manager')
      await deletePinnedFact(msg.id as string)
      return { ok: true }
    }
    case MSG.GET_PINS: {
      const { getPinnedFacts } = await import('./pinned-facts-manager')
      const facts = await getPinnedFacts()
      return { ok: true, facts }
    }

    // ── Saved Workflows (V3: FR-V3-1) ──────────────────────────────────────────
    case MSG.SAVE_WORKFLOW: {
      const { saveWorkflow } = await import('./workflow-engine')
      await saveWorkflow(msg.workflow as import('../shared/types').SavedWorkflow)
      return { ok: true }
    }
    case MSG.LOAD_WORKFLOWS: {
      const { loadWorkflows } = await import('./workflow-engine')
      const wfs = await loadWorkflows(msg.limit as number | undefined)
      return { ok: true, workflows: wfs }
    }
    case MSG.DELETE_WORKFLOW: {
      const { deleteWorkflowById } = await import('./workflow-engine')
      await deleteWorkflowById(msg.id as string)
      return { ok: true }
    }
    case MSG.RUN_WORKFLOW: {
      const { getWorkflowById, createWorkflow, startWorkflow } = await import('./workflow-engine')
      const saved = await getWorkflowById(msg.id as string)
      if (!saved) return { ok: false, error: 'Workflow not found' }
      // Convert SavedWorkflow steps into runtime WorkflowSteps
      const runtimeSteps = saved.steps.map(s => ({
        description: `${s.type}: ${JSON.stringify(s.params)}`,
        action: s.type,
      }))
      const wf = createWorkflow(saved.name, runtimeSteps)
      startWorkflow(wf.id).catch(() => {})
      return { ok: true, workflowId: wf.id }
    }

    // ── Context Stack (V3: FR-V3-2) ────────────────────────────────────────────
    case MSG.GET_CONTEXT_STACK: {
      const csTabId = (msg.tabId as number) || sender.tab?.id || 0
      const currentDomain = extractDomain(tabState.get(csTabId)?.url ?? '')
      const { getContextSources } = await import('./prompt-engine')
      const { getPinnedFacts, formatPinnedFactsForPrompt } = await import('./pinned-facts-manager')

      const snap = tabState.get(csTabId)
      const tabMem = await getTabMemory(csTabId, 8)
      const memText = tabMem.map(m => m.content).join('\n').slice(0, 1400)
      const domainSkills = await getSkillsForDomain(currentDomain)
      const skillsText = formatSkillsForPrompt(domainSkills)
      const userBehaviors = await getBehaviorsForDomain(currentDomain)
      const behaviorText = formatBehaviorsForPrompt(userBehaviors)
      const instructionEntries = await getAllUserInstructions()
      const instructionsText = formatUserInstructionsForPrompt(instructionEntries, 'general')
      const sitemapText = await getSitemapForPrompt(currentDomain)
      let pinnedText = ''
      try { pinnedText = formatPinnedFactsForPrompt(await getPinnedFacts()) } catch { /* */ }
      let mempalaceText = ''
      if (mempalaceEnabled(s) && currentDomain) {
        try { mempalaceText = await recallRelevantMemories(s, '', currentDomain).catch(() => '') || '' } catch { /* */ }
      }
      if (localMemoryEnabled(s) && currentDomain) {
        try {
          const lr = await recallLocalMemories('', currentDomain).catch(() => '')
          if (lr) mempalaceText = mempalaceText ? mempalaceText + '\n' + lr : lr
        } catch { /* */ }
      }

      const sources = getContextSources({
        userText: '',
        pageSnapshot: snap,
        accessibilityTree: snap ? (tabState as unknown as { getA11yTree?: (id: number) => string }).getA11yTree?.(csTabId) ?? '' : '',
        memories: memText,
        skills: skillsText,
        behaviors: behaviorText,
        instructions: instructionsText,
        mempalace: mempalaceText,
        sitemap: sitemapText,
        pinnedFacts: pinnedText,
        isLocal: (s.activeProvider ?? 'local') === 'local',
        contextWindow: s.contextWindowTokens || 32768,
        liteMode: s.liteMode ?? false,
      })

      const totalTokens = sources.reduce((sum, src) => sum + src.tokens, 0)
      return { ok: true, sources, totalTokens }
    }

    // ── Modular handlers (clipboard, workflow, debug) are in handlers/ ──
    // They're routed via the msg-router at the end of this switch (default case).

    // ── Command Palette ───────────────────────────────────────────────────────
    case MSG.COMMAND_PALETTE_SEARCH: {
      const q = (msg.query as string || '').toLowerCase()
      const results: Array<{ label: string; description: string; action: string }> = []

      // Built-in commands
      const commands = [
        { label: 'Summarize page', description: 'Get a summary of the current page', action: 'chat:Summarize this page for me.' },
        { label: 'Fill form', description: 'Fill forms using vault data', action: 'chat:Fill the forms on this page using my vault data.' },
        { label: 'Describe page', description: 'Describe what this page is about', action: 'chat:Describe this page and what I can do here.' },
        { label: 'Draft reply', description: 'Help draft a reply', action: 'chat:Help me draft a reply to this conversation.' },
        { label: 'Research topic', description: 'Deep research on a topic', action: 'chat:Research this topic thoroughly.' },
        { label: 'Search memory', description: 'Open memory search', action: 'switch:memory' },
        { label: 'Open vault', description: 'Go to encrypted vault', action: 'switch:vault' },
        { label: 'Open settings', description: 'Configure Orion', action: 'switch:settings' },
        { label: 'New chat', description: 'Start a fresh conversation', action: 'new-chat' },
        { label: 'Take screenshot', description: 'Capture current page', action: 'screenshot' },
      ]
      for (const cmd of commands) {
        if (cmd.label.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q)) {
          results.push(cmd)
        }
      }

      // Search vault entries
      try {
        const vaultEntries = await vaultList()
        for (const v of vaultEntries.slice(0, 20)) {
          const label = v.label || v.category
          if (label.toLowerCase().includes(q)) {
            results.push({ label: `Vault: ${label}`, description: v.category, action: `vault:${v.id}` })
          }
        }
      } catch { /* vault may be locked */ }

      return { ok: true, results: results.slice(0, 8) }
    }
    case MSG.COMMAND_PALETTE_EXECUTE: {
      const action = msg.action as string
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (action.startsWith('chat:')) {
        if (tab?.id) try { await chrome.sidePanel.open({ tabId: tab.id }) } catch {}
        await sleep(300)
        broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text: action.slice(5), tabId: tab?.id })
      } else if (action.startsWith('switch:')) {
        if (tab?.id) try { await chrome.sidePanel.open({ tabId: tab.id }) } catch {}
        await sleep(300)
        broadcastToPanel({ type: `SWITCH_TO_${action.slice(7).toUpperCase()}` })
      } else if (action === 'new-chat') {
        if (tab?.id) try { await chrome.sidePanel.open({ tabId: tab.id }) } catch {}
        await sleep(300)
        broadcastToPanel({ type: 'NEW_CHAT' })
      } else if (action === 'screenshot') {
        if (tab?.id) await captureScreenshot(tab.id)
      }
      return { ok: true }
    }
    case MSG.TOGGLE_COMMAND_PALETTE: {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/command-palette.js'],
          })
          await chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_COMMAND_PALETTE })
        } catch { /* tab may not support scripts */ }
      }
      return { ok: true }
    }

    // ── Stats ─────────────────────────────────────────────────────────────────
    case MSG.GET_STATS: {
      const stats = await getDomainStats()
      return { ok: true, stats }
    }

    case MSG.GET_HABITS: {
      await analyzeHabits(s)
      const patterns = await getHabitPatterns(20)
      return { ok: true, patterns }
    }

    case MSG.GET_CALENDAR_EVENTS: {
      const events = await getAllCalendarEvents()
      return { ok: true, events }
    }

    case MSG.GET_ACTION_LOG: {
      const actions = await getRecentActions(50)
      return { ok: true, actions }
    }

    // ── Form fill ─────────────────────────────────────────────────────────────
    case MSG.FILL_FORM: {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }

      const { vaultId, formSelector, includePasswords } = msg as { vaultId: string; formSelector: string; includePasswords?: boolean }
      const entry = await vaultGet(vaultId)
      if (!entry) return { ok: false, error: 'Vault entry not found' }

      const plaintext = await decryptData(entry.encryptedData)
      const vaultData = JSON.parse(plaintext) as VaultData

      const snap = tabState.get(tabId)
      if (!snap) return { ok: false, error: 'No page snapshot. Reload the page.' }

      const form = snap.forms.find(f => f.selector === formSelector) ?? snap.forms[0]
      if (!form) return { ok: false, error: 'No form found on this page' }

      const assignments = includePasswords
        ? matchCredentialsToForm(form, vaultData)
        : matchVaultToForm(form, vaultData)

      if (assignments.length === 0) return { ok: false, error: 'No matching fields found' }

      await chrome.tabs.sendMessage(tabId, { type: MSG.DO_FILL, assignments })
      return { ok: true, fieldCount: assignments.length }
    }

    case MSG.FORM_ASSIST_FILL_FIELD: {
      const { selector, value, inputType } = msg as { selector: string; value: string; inputType: string }
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: MSG.DO_FILL,
          assignments: [{ selector, value, inputType }],
        })
        return { ok: true }
      } catch {
        return { ok: false, error: 'FILL_FAILED' }
      }
    }

    case MSG.GET_TAB_SNAPSHOT: {
      const snap = tabState.get(tabId) ?? tabState.get(msg.tabId as number)
      return { ok: true, snapshot: snap ?? null }
    }

    case MSG.TAKE_SCREENSHOT: {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 })
        return { ok: true, dataUrl }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    // ── Action execution ──────────────────────────────────────────────────────
    case MSG.EXECUTE_ACTION: {
      const action = msg.action as Record<string, unknown>
      const targetTabId = msg.tabId as number ?? tabId
      try {
        const result = await chrome.tabs.sendMessage(targetTabId, { type: MSG.EXECUTE_ACTION, action })
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    // ── Learning Mode ──────────────────────────────────────────────────────
    case MSG.LEARNING_START: {
      const learnTabId = (msg.tabId as number) || tabId
      const session = await startLearning(learnTabId, s)
      return { ok: true, sessionId: session.id }
    }

    case MSG.LEARNING_STOP: {
      const session = await stopLearning(s)
      if (!session) return { ok: false, error: 'No active learning session' }

      let analysis = ''
      if (s.lmStudioUrl) {
        try {
          analysis = await analyzeLearningSession(session, s)
        } catch (err) {
          analysis = `Analysis error: ${String(err)}`
        }
      }
      return { ok: true, sessionId: session.id, snapshotCount: session.snapshots.length, analysis }
    }

    case MSG.LEARNING_STATUS: {
      const active = isLearningActive()
      const current = getActiveSession()
      return {
        ok: true,
        active,
        sessionId: current?.id,
        snapshotCount: current?.snapshots.length ?? 0,
        domain: current?.domain,
        startedAt: current?.startedAt,
      }
    }

    // ── Supervised Learning Mode ────────────────────────────────────────
    case MSG.SUPERVISED_START: {
      const supTabId = (msg.tabId as number) || tabId
      if (supTabId <= 0) {
        return { ok: false, error: 'No active tab found for supervised learning' }
      }

      const contentReady = await ensureContentScript(supTabId)
      if (!contentReady) {
        return { ok: false, error: 'This tab cannot be observed. Open a normal webpage and try again.' }
      }

      const session = await startSupervisedSession(supTabId)
      await requestFreshSnapshot(supTabId).catch(() => undefined)
      return { ok: true, sessionId: session.id }
    }

    case MSG.SUPERVISED_STOP: {
      const session = await stopSupervisedSession()
      if (!session) return { ok: false, error: 'No active supervised session' }

      let analysis = ''
      let playbookCount = 0
      try {
        analysis = await analyzeFullSupervisedSession(session, s)
        const countMatch = analysis.match(/created (\d+) playbooks/)
        playbookCount = countMatch ? Number(countMatch[1]) : 0
      } catch (err) {
        analysis = `Analysis error: ${String(err)}`
      }
      return {
        ok: true,
        sessionId: session.id,
        interactionCount: session.interactions.length,
        playbookCount,
        analysis,
      }
    }

    case MSG.SUPERVISED_STATUS: {
      const supActive = isSupervisedActive()
      const supSession = getActiveSupervisedSession()
      return {
        ok: true,
        active: supActive,
        sessionId: supSession?.id,
        interactionCount: supSession?.interactions.length ?? 0,
        actionCount: getSupervisedActionCount(),
        domain: supSession?.domain,
        startedAt: supSession?.startedAt,
      }
    }

    case MSG.SUPERVISED_VOICE_SEGMENT: {
      const transcript = msg.transcript as string
      if (transcript && isSupervisedActive()) {
        const currentInt = getCurrentInteraction()
        if (currentInt) {
          addVoiceSegment(transcript)
        } else {
          beginInteraction(transcript)
        }
      }
      return { ok: true }
    }

    case MSG.SUPERVISED_COMMAND_DONE: {
      const interaction = await completeInteraction()
      return { ok: true, hasInteraction: !!interaction }
    }

    case MSG.PLAYBOOK_LIST: {
      const playbooks = await getAllPlaybooks()
      return { ok: true, playbooks }
    }

    case MSG.PLAYBOOK_DELETE: {
      const pbId = msg.id as string
      if (pbId) await deletePlaybook(pbId)
      return { ok: true }
    }

    case MSG.PLAYBOOK_MATCH: {
      const query = msg.query as string
      const domain = msg.domain as string ?? ''
      if (!query) return { ok: false, error: 'No query' }
      const match = await findMatchingPlaybook(query, domain, s)
      return { ok: true, match: match ? { playbook: match.playbook, score: match.score } : null }
    }

    case MSG.GEMINI_MODELS: {
      const apiKey = (msg.apiKey as string) || s.geminiApiKey || ''
      if (!apiKey) return { ok: false, error: 'No Gemini API key provided' }
      const models = await listGeminiModels(apiKey)
      return { ok: true, models }
    }

    // ── Offscreen STT Relay (from offscreen document → sidepanel) ──────
    case MSG.STT_TRANSCRIPT_RELAY: {
      relayToSttPort({ type: MSG.STT_TRANSCRIPT_RELAY, text: msg.text, isFinal: msg.isFinal })

      if (msg.isFinal && isSupervisedActive()) {
        const transcript = msg.text as string
        if (transcript) {
          const currentInt = getCurrentInteraction()
          if (currentInt) {
            addVoiceSegment(transcript)
          } else {
            beginInteraction(transcript)
          }
        }
      }
      return { ok: true }
    }

    case MSG.STT_COMMAND_RELAY: {
      relayToSttPort({ type: MSG.STT_COMMAND_RELAY, command: msg.command })

      if (isSupervisedActive()) {
        await completeInteraction()
      }
      return { ok: true }
    }

    case MSG.STT_ERROR_RELAY: {
      relayToSttPort({ type: MSG.STT_ERROR_RELAY, error: msg.error })
      return { ok: true }
    }

    case MSG.STT_STATUS_RELAY: {
      relayToSttPort({ type: MSG.STT_STATUS_RELAY, listening: msg.listening })
      return { ok: true }
    }

    case MSG.STT_START_VIA_OFFSCREEN: {
      await startOffscreenSTT((msg.lang as string) ?? 'en-US')
      return { ok: true }
    }

    case MSG.STT_STOP_VIA_OFFSCREEN: {
      await stopOffscreenSTT()
      return { ok: true }
    }

    case MSG.MIC_PERMISSION_RESULT: {
      if (msg.granted === true) {
        await persistMicGrantTimestamp()
      }
      return { ok: true }
    }

    // STT_OFFSCREEN_START/STOP are consumed by the offscreen doc, not the SW
    case MSG.STT_OFFSCREEN_START:
    case MSG.STT_OFFSCREEN_STOP:
      return { ok: true }

    case MSG.STT_OFFSCREEN_READY: {
      if (pendingSTTLang) {
        const lang = pendingSTTLang
        pendingSTTLang = null
        sendSTTStartToOffscreen(lang)
      }
      return { ok: true }
    }

    // ── Local Memory management ──────────────────────────────────────────────
    case 'LOCAL_MEMORY_STATS': {
      const stats = await getLocalMemoryStats()
      return { ok: true, total: stats.total, byCategory: stats.byCategory }
    }

    case 'LOCAL_MEMORY_CLEAR': {
      await clearLocalMemory()
      return { ok: true }
    }

    // ── Auto-collection management ──────────────────────────────────────────
    case 'AUTO_COLLECT_COUNT': {
      const count = await getAutoCollectedCount()
      return { ok: true, count }
    }

    case 'AUTO_COLLECT_APPROVE': {
      await approveAutoCollected(msg.id as string)
      return { ok: true }
    }

    case 'AUTO_COLLECT_APPROVE_ALL': {
      const approved = await approveAllAutoCollected()
      return { ok: true, count: approved }
    }

    // ── Telegram Bot management ──────────────────────────────────────────────
    case 'TELEGRAM_TEST': {
      const token = (msg.token as string)?.trim()
      if (!token) return { ok: false, error: 'No token provided' }
      const result = await testTelegramBot(token)
      return result
    }

    case 'TELEGRAM_TOGGLE': {
      const enabled = msg.enabled as boolean
      if (enabled && s.telegramBotToken) {
        const intervalMin = Math.max(0.083, (s.telegramPollIntervalSec ?? 5) / 60)
        await chrome.alarms.create('telegram-poll', { periodInMinutes: intervalMin })
      } else {
        await chrome.alarms.clear('telegram-poll')
      }
      return { ok: true }
    }

    case 'TELEGRAM_RESET': {
      resetTelegramOffset()
      return { ok: true }
    }

    case 'JOURNAL_DECRYPT': {
      const unlocked = await isSessionUnlocked()
      if (!unlocked) return { ok: false, error: 'SESSION_LOCKED' }
      try {
        const { decryptJournalValue } = await import('./input-journal')
        const { dbGet } = await import('../shared/idb')
        const entry = await dbGet<import('../shared/types').InputJournalEntry>(STORE.INPUT_JOURNAL, msg.entryId as number)
        if (!entry) return { ok: false, error: 'NOT_FOUND' }
        const value = await decryptJournalValue(entry)
        return { ok: true, value }
      } catch {
        return { ok: false, error: 'DECRYPT_FAILED' }
      }
    }

    // ── Active Groups panel ────────────────────────────────────────────────
    case MSG.GET_ACTIVE_GROUPS: {
      const groups = await getActiveGroups()
      return { ok: true, groups }
    }

    case MSG.PAUSE_GROUP: {
      const gid = msg.groupId as number
      pauseGroup(gid)
      // Cancel running automation + abort LLM stream for every tab in the group
      for (const tid of getTabsInGroup(gid)) {
        cancelAutomation(tid)
        abortStream(tid)
      }
      broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
      return { ok: true }
    }

    case MSG.RESUME_GROUP: {
      const gid = msg.groupId as number
      resumeGroup(gid)
      broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
      return { ok: true }
    }

    case MSG.STOP_GROUP: {
      const gid = msg.groupId as number
      // Cancel automation + abort streams for all tabs first
      for (const tid of getTabsInGroup(gid)) {
        cancelAutomation(tid)
        abortStream(tid)
        panelOpenTabs.delete(tid)
        await chrome.sidePanel.setOptions({ tabId: tid, enabled: false }).catch(() => {})
      }
      await stopGroup(gid)
      broadcastToPanel({ type: MSG.ACTIVE_GROUPS_CHANGED })
      return { ok: true }
    }

    default: {
      // Try modular handlers registered via msg-router
      if (hasHandler(msg.type as string)) {
        return routeMessage(msg, sender)
      }
      return { ok: false, error: `Unknown message type: ${msg.type}` }
    }
  }
}

// ─── Context-aware rewrite prompt ────────────────────────────────────────────

function buildRewriteSystemPrompt(context: string, detail: string, pageTitle: string): string {
  const contextInstructions: Record<string, string> = {
    email: `You are revising an ${detail}. Improve clarity, grammar, and professional tone. Keep the message polite and well-structured. For subject lines, make them concise and descriptive. For email bodies, ensure proper greeting, clear body, and appropriate sign-off.`,
    chat: `You are revising an ${detail} in a messaging app. Keep it conversational, natural, and concise. Fix typos and grammar but preserve the casual tone. Do NOT add formal greetings or sign-offs. Keep it brief — this is instant messaging.`,
    social: `You are revising a ${detail}. Keep it engaging, authentic, and appropriate for social media. Fix grammar and clarity while preserving the original voice and personality. Keep it concise and impactful.`,
    code: `You are revising ${detail} on a developer platform. Use clear, technical language. Be precise and well-structured. Use proper technical terminology. For issue descriptions, include clear problem statements. For code review comments, be constructive and specific.`,
    comment: `You are revising a ${detail}. Keep it relevant, clear, and respectful. Fix grammar and improve readability while preserving the original point. Be concise — comments should add value without being overly long.`,
    document: `You are revising text in a document editor (${detail}). Improve clarity, structure, and flow. Fix grammar and enhance readability. Maintain consistent tone and style throughout. Preserve formatting intent.`,
    form: `You are revising text in a ${detail}. Make the message clear, professional, and well-structured. Ensure all key points are communicated effectively. Fix grammar and improve readability.`,
    general: `You are revising text (${detail}). Improve clarity and grammar while keeping the tone appropriate for the context. Fix any errors and enhance readability.`,
  }

  const instruction = contextInstructions[context] ?? contextInstructions.general
  const titleHint = pageTitle ? ` The user is on a page titled "${pageTitle.slice(0, 80)}".` : ''

  return `${instruction}${titleHint} Return ONLY the revised text, no quotes, labels, or preamble. Do not add any text the user did not write — only improve what's there.`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/** Classify a field from USER_ACTION event metadata using form-intelligence. */
function classifyFieldFromEvent(
  inputType: string,
  name: string,
  label: string,
  autocomplete: string
): InputFieldType {
  return classifyField({
    selector: '',
    type: inputType,
    name,
    label,
    required: false,
    autocomplete,
  }) as InputFieldType
}

// Safety border removed — signalActivityBorder is now a no-op
function signalActivityBorder(_tabId: number, _show: boolean): void {
  // Border feature removed per user request
}
