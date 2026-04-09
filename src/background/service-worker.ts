import { MSG, DEFAULTS, PORT_AI_STREAM, PORT_STT_RELAY, STORE } from '../shared/constants'
import { persistMicGrantTimestamp } from '../shared/mic-permission-storage'
import type { Settings, VaultData, VaultCategory, PageSnapshot, ChatMessage } from '../shared/types'
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
} from './memory-manager'
import { recordAction, flushAllBuffers, flushBuffer, clearTabBuffer } from './action-recorder'
import { matchVaultToForm, matchCredentialsToForm, describeForm } from './form-intelligence'
import { probeEndpoint, quickHealthCheck } from './api-detector'
import { startScreenshotLoop, stopScreenshotLoop, captureScreenshot } from './screenshot-loop'
import { executeActionsFromText, parseActionsFromText, executeWithFollowUp, ensureContentScript, requestFreshSnapshot, cancelAutomation } from './action-executor'
import { addTabToAIGroup } from './web-researcher'
import { analyzeHabits, getHabitPatterns } from './habit-tracker'
import { getAllCalendarEvents } from './calendar-detector'
import { detectPersonalData, storeDetectedPII } from './pii-detector'
import { classifyActionRisk, needsConfirmation, requestConfirmation, handleConfirmResponse } from './confirmation-manager'
import type { ConfirmResponseType } from '../shared/types'
import { getSkillsForDomain, formatSkillsForPrompt } from './skill-manager'
import { getBehaviorsForDomain, formatBehaviorsForPrompt } from './behavior-learner'
import { tryExtractInstructionToSave, saveUserInstruction, getAllUserInstructions, formatUserInstructionsForPrompt } from './instruction-manager'
import { assessPageThreat } from './threat-heuristics'
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
import { getAllPlaybooks, deletePlaybook } from './memory-manager'
import { getCDPAccessibilityTree, type CDPTreeResult } from './cdp-accessibility'
import { captureMiniMap, type MiniMapResult } from './minimap-screenshot'
import { recordPageVisit, getSitemapForPrompt, persistDirtySitemaps } from './visual-sitemap'
import { getPersonaForPrompt } from './page-persona'

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
    console.log(`[LocalAI] Background AI skipped — backoff ${Math.round(backoffMs / 1000)}s, ${Math.round((backoffMs - elapsed) / 1000)}s remaining`)
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
    console.log(`[LocalAI] Background AI call succeeded — resetting failure counter (was ${bgCallFailures})`)
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

  if (settings!.onboardingComplete) {
    startScreenshotLoop(settings!.screenshotIntervalSec)
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => { initSW().catch(console.error) })
chrome.runtime.onStartup.addListener(() => { initSW().catch(console.error) })
chrome.runtime.onSuspend?.addListener(() => {
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

// openPanelOnActionClick: user clicks the extension icon → panel opens on THAT tab only.
// The panel stays open only on tabs where the user opened it; Chrome manages this natively.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

/** Enable sidebar for a specific tab (used by research tabs) */
async function activateOrionForTab(tabId: number): Promise<void> {
  await addTabToAIGroup(tabId).catch(() => {})
  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel/sidepanel.html',
    enabled: true,
  }).catch(() => {})
}

// Capture screenshot when user switches tabs (for page context)
chrome.tabs.onActivated.addListener(async (info) => {
  const s = await getSettings()
  if (s.onboardingComplete) {
    await captureScreenshot(info.tabId).catch(() => {})
  }
})

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bg-summarize') {
    await flushAllBuffers()
    if (!shouldSkipBackgroundAI()) {
      await runBackgroundSummarization()
    }
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

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId)
  flushBuffer(tabId).then(() => clearTabBuffer(tabId)).catch(() => {})
})

// Tab activation screenshot handled in the side panel onActivated listener above

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return
  await flushBuffer(details.tabId)
  tabState.delete(details.tabId)
  const s = await getSettings()
  if (!s.monitoringEnabled) return

  await addSessionMemory({
    type: 'page_visit',
    url: details.url,
    domain: extractDomain(details.url),
    content: `Navigated to: ${details.url}`,
    tags: ['navigation', `domain:${extractDomain(details.url)}`],
    timestamp: Date.now(),
    sessionId,
    tabId: details.tabId,
  })
})

// ─── Port-based streaming (sidepanel -> SW) ───────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_STT_RELAY) {
    sttRelayPort = port
    port.onDisconnect.addListener(() => { sttRelayPort = null })
    return
  }

  if (port.name !== PORT_AI_STREAM) return

  const streamPort = wrapStreamPort(port)
  port.onDisconnect.addListener(() => {
    abortAllStreams()
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

      await appendChatMessage({
        sessionId: chatSessionId,
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        tabId,
      })

  const extractedInstruction = tryExtractInstructionToSave(userText)
  if (extractedInstruction) {
    await saveUserInstruction(extractedInstruction)
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
  const userInstructionsText = formatUserInstructionsForPrompt(userInstructionEntries)

  let mempalaceBlock: string | undefined
  if (mempalaceEnabled(s) && userText.trim().length > 0) {
    const recalled = await recallRelevantMemories(s, userText, currentDomain).catch(() => '')
    if (recalled) mempalaceBlock = recalled
  }

  const isExternalProvider = s.activeProvider === 'gemini' || s.activeProvider === 'openai' || s.activeProvider === 'anthropic'
  const effectiveCapabilities = isExternalProvider
    ? { ...s.apiCapabilities, supportsVision: true }
    : s.apiCapabilities

  // Build sitemap context for the current domain
  const sitemapText = await getSitemapForPrompt(currentDomain)

  // Extract full page text so the AI can read the page content directly
  const currentSnap = tabState.get(tabId)
  const maxPageText = s.liteMode ? 4000 : 10000
  const pageTextForPrompt = (currentSnap?.completePageText ?? currentSnap?.pageText ?? '').slice(0, maxPageText)

  // Detect page type and generate expert persona
  const personaBlock = getPersonaForPrompt(
    currentSnap?.url ?? '',
    currentSnap?.title ?? '',
    currentSnap?.headings ?? [],
    currentSnap?.completePageText ?? currentSnap?.pageText ?? ''
  )

  // Choose system prompt based on lite mode (for small local models)
  const systemPrompt = s.liteMode
    ? buildCompactSystemPrompt(pageContext, accessibilityTree, viewportMeta, pageTextForPrompt || undefined, personaBlock || undefined)
    : buildSystemPrompt(
        pageContext,
        memText,
        effectiveCapabilities,
        knownUserData,
        skillsText || undefined,
        accessibilityTree,
        behaviorText || undefined,
        userInstructionsText || undefined,
        mempalaceBlock,
        viewportMeta,
        sitemapText || undefined,
        pageTextForPrompt || undefined,
        personaBlock || undefined
      )

  let messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[] = [
    { role: 'system', content: systemPrompt },
    ...history.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.content,
      imageData: undefined as string | undefined,
    })),
  ]

  // Token-aware history truncation
  const ctxWindow = s.contextWindowTokens || (s.liteMode ? 8192 : 32768)
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
      // Always try executeWithFollowUp — it has auto-kickstart logic
      // that can detect user intent and inject actions even when the AI didn't emit any
      if (actions.length > 0) {
        const risk = classifyActionRisk(actions)
        const domain = extractDomain(tabState.get(tabId)?.url ?? '')
        const shouldConfirm = await needsConfirmation(risk, actions, domain)

        if (shouldConfirm) {
          const confirmed = await requestConfirmation(port, actions, risk, tabId, chatSessionId)
          if (!confirmed) {
            port.postMessage({ type: MSG.STREAM_CHUNK, chunk: '\n\n*Action declined by user.*\n' })
            port.postMessage({ type: MSG.STREAM_END, fullText: fullText + '\n\n*Action declined by user.*' })
            return
          }
        }
      }

      await executeWithFollowUp(
        fullText, tabId, s, port,
        messages.map(m => ({ role: m.role, content: m.content }))
      )
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
The user is searching their browsing history and saved memories. Your job is to find and present the most relevant results.

RULES:
- Format every URL as a clickable markdown link: [Page Title or description](url)
- Include when the page was visited (date/time) if available
- NEVER fabricate or guess URLs — only use URLs that appear in the provided context
- When the query is vague, use all context clues (domain names, page content, timestamps) to identify the best match
- Present the BEST match first, then alternatives if any exist
- If nothing matches, say so honestly — do not make up results
- Be concise — the user wants the link/data, not a long explanation
- If multiple results match, present them as a numbered list with dates and domains`

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

  // Parallel search: IDB text search + MemPalace semantic search + URL-rich session memory
  const [idbResults, mempalaceResults, sessionEntries] = await Promise.all([
    searchAllHistory(query).catch(() => ''),
    mempalaceEnabled(s)
      ? searchMempalace(s, query, { limit: 8 }).catch(() => '')
      : Promise.resolve(''),
    getRecentSessionMemory(80).catch(() => [] as Awaited<ReturnType<typeof getRecentSessionMemory>>),
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
  })

  // Build combined context for AI
  const sections: string[] = []
  if (urlContext) sections.push(`## Browsing History (URLs and pages visited)\n${urlContext}`)
  if (idbResults) sections.push(`## Text Search Results\n${idbResults.slice(0, 2500)}`)
  if (mempalaceResults) sections.push(`## Semantic Memory (MemPalace)\n${mempalaceResults.slice(0, 2500)}`)

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
      // Hide the activity border
      chrome.tabs.sendMessage(tabId, { type: MSG.HIDE_ACTIVITY_BORDER }).catch(() => {})
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

        if (tabId > 0) {
          if (s.safetyBorderEnabled !== false) {
            const assessment = assessPageThreat(
              snap.url,
              snap.pageText ?? '',
              snap.visibleText ?? '',
              snap.completePageText ?? ''
            )
            const detail = `${assessment.score}/100 · ${assessment.reasons.slice(0, 2).join(' · ')}`
            chrome.tabs.sendMessage(tabId, {
              type: MSG.SET_SAFETY_BORDER,
              level: assessment.level,
              detail,
              hidden: false,
            }).catch(() => {})
          } else {
            chrome.tabs.sendMessage(tabId, { type: MSG.SET_SAFETY_BORDER, hidden: true }).catch(() => {})
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
      const improved = await callAI(
        [
          {
            role: 'system',
            content:
              'You improve draft email and contact-form messages. Fix clarity and grammar; keep tone appropriate. Return ONLY the revised text, no quotes or preamble.',
          },
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
      if (s.monitoringEnabled) {
        recordAction(tabId, msg.event as Parameters<typeof recordAction>[1], sessionId)
      }
      if (isSupervisedActive()) {
        feedUserEvent(msg.event as Parameters<typeof feedUserEvent>[0])
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
      return { ok: true, entries: entries.map(e => ({ id: e.id, category: e.category, label: e.label, updatedAt: e.updatedAt })) }
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
      await setSettings(msg.partial as Partial<Settings>)
      settings = null
      // Reset background AI failure counter when settings change (e.g., new model, new endpoint)
      resetBgCallFailures()
      return { ok: true }
    }

    case 'GROUP_ACTIVE_TAB': {
      // No-op: panel lifecycle is managed by Chrome via openPanelOnActionClick
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

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function signalActivityBorder(tabId: number, show: boolean): void {
  if (tabId <= 0) return
  const type = show ? MSG.SHOW_ACTIVITY_BORDER : MSG.HIDE_ACTIVITY_BORDER
  chrome.tabs.sendMessage(tabId, { type }).catch(() => {})
}
