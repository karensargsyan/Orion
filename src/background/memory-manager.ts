import {
  dbGet, dbGetAll, dbGetAllByIndex, dbGetByIndexRange, dbPut, dbDelete, dbClear,
} from '../shared/idb'
import { STORE, DEFAULTS } from '../shared/constants'
import type {
  ChatMessage, SessionMemoryEntry, GlobalMemoryEntry, VaultEntry, VaultCategory, Settings,
  LearnedPlaybook, SupervisedSession,
} from '../shared/types'

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K] | undefined> {
  const row = await dbGet<{ key: string; value: Settings[K] }>(STORE.SETTINGS, key)
  return row?.value
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await dbPut(STORE.SETTINGS, { key, value })
}

export async function getAllSettings(): Promise<Settings> {
  const rows = await dbGetAll<{ key: string; value: unknown }>(STORE.SETTINGS)
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return {
    activeProvider: (map.activeProvider as Settings['activeProvider']) ?? DEFAULTS.ACTIVE_PROVIDER,
    lmStudioUrl: (map.lmStudioUrl as string) ?? DEFAULTS.LM_STUDIO_URL,
    lmStudioModel: (map.lmStudioModel as string) ?? DEFAULTS.LM_STUDIO_MODEL,
    authToken: (map.authToken as string) ?? DEFAULTS.AUTH_TOKEN,
    apiCapabilities: map.apiCapabilities as Settings['apiCapabilities'],
    rateLimitRpm: (map.rateLimitRpm as number) ?? DEFAULTS.RATE_LIMIT_RPM,
    geminiApiKey: map.geminiApiKey as string | undefined,
    geminiModel: map.geminiModel as string | undefined,
    openaiApiKey: map.openaiApiKey as string | undefined,
    openaiModel: map.openaiModel as string | undefined,
    anthropicApiKey: map.anthropicApiKey as string | undefined,
    anthropicModel: map.anthropicModel as string | undefined,
    monitoringEnabled: (map.monitoringEnabled as boolean) ?? DEFAULTS.MONITORING_ENABLED,
    visionEnabled: (map.visionEnabled as boolean) ?? DEFAULTS.VISION_ENABLED,
    maxContextMessages: (map.maxContextMessages as number) ?? DEFAULTS.MAX_CONTEXT_MESSAGES,
    hasPinSetup: (map.hasPinSetup as boolean) ?? false,
    pbkdf2SaltB64: map.pbkdf2SaltB64 as string | undefined,
    screenshotIntervalSec: (map.screenshotIntervalSec as number) ?? DEFAULTS.SCREENSHOT_INTERVAL_SEC,
    textRewriteEnabled: (map.textRewriteEnabled as boolean) ?? DEFAULTS.TEXT_REWRITE_ENABLED,
    safetyBorderEnabled: (map.safetyBorderEnabled as boolean) ?? DEFAULTS.SAFETY_BORDER_ENABLED,
    composeAssistantEnabled: (map.composeAssistantEnabled as boolean) ?? DEFAULTS.COMPOSE_ASSISTANT_ENABLED,
    aiActionLearningEnabled: (map.aiActionLearningEnabled as boolean) ?? DEFAULTS.AI_ACTION_LEARNING_ENABLED,
    mempalaceBridgeEnabled: (map.mempalaceBridgeEnabled as boolean) ?? DEFAULTS.MEMPALACE_BRIDGE_ENABLED,
    mempalaceBridgeUrl: (map.mempalaceBridgeUrl as string) ?? DEFAULTS.MEMPALACE_BRIDGE_URL,
    mempalaceWing: map.mempalaceWing as string | undefined,
    localMemoryEnabled: (map.localMemoryEnabled as boolean) ?? DEFAULTS.LOCAL_MEMORY_ENABLED,
    localMemoryMaxEntries: (map.localMemoryMaxEntries as number) ?? DEFAULTS.LOCAL_MEMORY_MAX_ENTRIES,
    autoCollectEnabled: (map.autoCollectEnabled as boolean) ?? DEFAULTS.AUTO_COLLECT_ENABLED,
    autoCollectMinFields: (map.autoCollectMinFields as number) ?? DEFAULTS.AUTO_COLLECT_MIN_FIELDS,
    autoCollectExcludeDomains: (map.autoCollectExcludeDomains as string[]) ?? [],
    calendarDetectionEnabled: (map.calendarDetectionEnabled as boolean) ?? DEFAULTS.CALENDAR_DETECTION_ENABLED,
    onboardingComplete: (map.onboardingComplete as boolean) ?? DEFAULTS.ONBOARDING_COMPLETE,
    learningModeActive: (map.learningModeActive as boolean) ?? DEFAULTS.LEARNING_MODE_ACTIVE,
    learningSnapshotIntervalSec: (map.learningSnapshotIntervalSec as number) ?? DEFAULTS.LEARNING_SNAPSHOT_INTERVAL_SEC,
    sttProvider: (map.sttProvider as Settings['sttProvider']) ?? DEFAULTS.STT_PROVIDER,
    whisperEndpoint: (map.whisperEndpoint as string) ?? DEFAULTS.WHISPER_ENDPOINT,
    confirmationPreferences: (map.confirmationPreferences as Settings['confirmationPreferences']) ?? [],
    globalAutoAccept: (map.globalAutoAccept as boolean) ?? false,
    contextWindowTokens: (map.contextWindowTokens as number) ?? DEFAULTS.CONTEXT_WINDOW_TOKENS,
    liteMode: (map.liteMode as boolean) ?? DEFAULTS.LITE_MODE,
  }
}

export async function setSettings(partial: Partial<Settings>): Promise<void> {
  const entries = Object.entries(partial) as [keyof Settings, Settings[keyof Settings]][]
  await Promise.all(entries.map(([k, v]) => setSetting(k, v as Settings[typeof k])))
}

// ─── Chat History ─────────────────────────────────────────────────────────────

export async function appendChatMessage(msg: Omit<ChatMessage, 'id'>): Promise<void> {
  await dbPut<ChatMessage>(STORE.CHAT_HISTORY, msg)
}

export async function getSessionMessages(sessionId: string, limit = 50): Promise<ChatMessage[]> {
  const all = await dbGetAllByIndex<ChatMessage>(STORE.CHAT_HISTORY, 'by_session', sessionId)
  return all.sort((a, b) => a.timestamp - b.timestamp).slice(-limit)
}

export async function getAllSessions(): Promise<string[]> {
  const all = await dbGetAll<ChatMessage>(STORE.CHAT_HISTORY)
  const sessions = [...new Set(all.map(m => m.sessionId))]
  return sessions
}

export async function clearChatHistory(): Promise<void> {
  await dbClear(STORE.CHAT_HISTORY)
}

// ─── Session Memory ────────────────────────────────────────────────────────────

export async function addSessionMemory(entry: Omit<SessionMemoryEntry, 'id'>): Promise<void> {
  await dbPut<SessionMemoryEntry>(STORE.SESSION_MEMORY, entry)
}

export async function getRecentSessionMemory(limit = 20): Promise<SessionMemoryEntry[]> {
  return dbGetByIndexRange<SessionMemoryEntry>(
    STORE.SESSION_MEMORY, 'by_timestamp', IDBKeyRange.lowerBound(0), limit
  )
}

export async function getTabMemory(tabId: number, limit = 30): Promise<SessionMemoryEntry[]> {
  const all = await dbGetAllByIndex<SessionMemoryEntry>(STORE.SESSION_MEMORY, 'by_tabId', tabId)
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
}

export async function getSessionMemoryByDomain(domain: string, limit = 50): Promise<SessionMemoryEntry[]> {
  return dbGetAllByIndex<SessionMemoryEntry>(STORE.SESSION_MEMORY, 'by_domain', domain)
    .then(r => r.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit))
}

export async function clearSessionMemory(): Promise<void> {
  await dbClear(STORE.SESSION_MEMORY)
}

// ─── Global Memory ────────────────────────────────────────────────────────────

export async function addGlobalMemory(entry: Omit<GlobalMemoryEntry, 'id'>): Promise<void> {
  await dbPut<GlobalMemoryEntry>(STORE.GLOBAL_MEMORY, entry)
}

export async function getGlobalMemoryByDomain(domain: string, limit = 10): Promise<GlobalMemoryEntry[]> {
  return dbGetAllByIndex<GlobalMemoryEntry>(STORE.GLOBAL_MEMORY, 'by_domain', domain)
    .then(r => r.sort((a, b) => b.importance - a.importance).slice(0, limit))
}

export async function getAllGlobalMemory(limit = 100): Promise<GlobalMemoryEntry[]> {
  return dbGetByIndexRange<GlobalMemoryEntry>(
    STORE.GLOBAL_MEMORY, 'by_timestamp', IDBKeyRange.lowerBound(0), limit
  )
}

export async function clearGlobalMemory(): Promise<void> {
  await dbClear(STORE.GLOBAL_MEMORY)
}

// ─── Vault ────────────────────────────────────────────────────────────────────

export async function vaultList(): Promise<VaultEntry[]> {
  return dbGetAll<VaultEntry>(STORE.VAULT)
}

export async function vaultListByCategory(category: VaultCategory): Promise<VaultEntry[]> {
  return dbGetAllByIndex<VaultEntry>(STORE.VAULT, 'by_category', category)
}

export async function vaultGet(id: string): Promise<VaultEntry | undefined> {
  return dbGet<VaultEntry>(STORE.VAULT, id)
}

export async function vaultSet(entry: VaultEntry): Promise<void> {
  await dbPut<VaultEntry>(STORE.VAULT, entry)
}

export async function vaultDelete(id: string): Promise<void> {
  await dbDelete(STORE.VAULT, id)
}

// ─── Memory export ─────────────────────────────────────────────────────────────

export async function exportMemory(): Promise<object> {
  const [chatHistory, sessionMemory, globalMemory] = await Promise.all([
    dbGetAll(STORE.CHAT_HISTORY),
    dbGetAll(STORE.SESSION_MEMORY),
    dbGetAll(STORE.GLOBAL_MEMORY),
  ])
  return { chatHistory, sessionMemory, globalMemory, exportedAt: new Date().toISOString() }
}

// ─── Domain Stats ─────────────────────────────────────────────────────────────

export async function getDomainStats(limit = 20): Promise<Array<{ domain: string; count: number; lastVisit: number }>> {
  const all = await dbGetAll<SessionMemoryEntry>(STORE.SESSION_MEMORY)
  const domainMap = new Map<string, { count: number; lastVisit: number }>()

  for (const entry of all) {
    if (!entry.domain) continue
    const existing = domainMap.get(entry.domain)
    if (existing) {
      existing.count++
      existing.lastVisit = Math.max(existing.lastVisit, entry.timestamp)
    } else {
      domainMap.set(entry.domain, { count: 1, lastVisit: entry.timestamp })
    }
  }

  return [...domainMap.entries()]
    .map(([domain, data]) => ({ domain, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

// ─── Session-based clear ──────────────────────────────────────────────────

export async function clearSessionChat(sessionId: string): Promise<void> {
  const all = await dbGetAllByIndex<ChatMessage>(STORE.CHAT_HISTORY, 'by_session', sessionId)
  for (const msg of all) {
    if (msg.id !== undefined) await dbDelete(STORE.CHAT_HISTORY, msg.id)
  }
}

// ─── Full-text search across all stores ───────────────────────────────────

export async function searchAllHistory(query: string, limit = 60): Promise<string> {
  const q = query.toLowerCase()
  const results: Array<{ source: string; time: number; text: string }> = []

  const chat = await dbGetAll<ChatMessage>(STORE.CHAT_HISTORY)
  for (const m of chat) {
    if (m.content.toLowerCase().includes(q)) {
      results.push({
        source: `chat[${m.sessionId}] ${m.role}`,
        time: m.timestamp,
        text: m.content.slice(0, 300),
      })
    }
  }

  const session = await dbGetAll<SessionMemoryEntry>(STORE.SESSION_MEMORY)
  for (const e of session) {
    if (e.content.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)) {
      results.push({
        source: `memory[${e.type}] ${e.domain}`,
        time: e.timestamp,
        text: e.content.slice(0, 300),
      })
    }
  }

  const global = await dbGetAll<GlobalMemoryEntry>(STORE.GLOBAL_MEMORY)
  for (const g of global) {
    if (g.summary.toLowerCase().includes(q) || g.tags.some(t => t.toLowerCase().includes(q))) {
      results.push({
        source: `global[${g.domain}]`,
        time: g.timestamp,
        text: g.summary.slice(0, 300),
      })
    }
  }

  results.sort((a, b) => b.time - a.time)
  return results.slice(0, limit)
    .map(r => `[${new Date(r.time).toLocaleString()} | ${r.source}] ${r.text}`)
    .join('\n\n')
}

// ─── Supervised Playbooks ────────────────────────────────────────────────────

export async function savePlaybook(playbook: LearnedPlaybook): Promise<void> {
  await dbPut<LearnedPlaybook>(STORE.SUPERVISED_PLAYBOOKS, playbook)
}

export async function getPlaybook(id: string): Promise<LearnedPlaybook | undefined> {
  return dbGet<LearnedPlaybook>(STORE.SUPERVISED_PLAYBOOKS, id)
}

export async function getAllPlaybooks(limit = 100): Promise<LearnedPlaybook[]> {
  return dbGetByIndexRange<LearnedPlaybook>(
    STORE.SUPERVISED_PLAYBOOKS, 'by_updated', IDBKeyRange.lowerBound(0), limit
  )
}

export async function getPlaybooksByDomain(domain: string): Promise<LearnedPlaybook[]> {
  return dbGetAllByIndex<LearnedPlaybook>(STORE.SUPERVISED_PLAYBOOKS, 'by_domain', domain)
}

export async function deletePlaybook(id: string): Promise<void> {
  await dbDelete(STORE.SUPERVISED_PLAYBOOKS, id)
}

// ─── Supervised Sessions ─────────────────────────────────────────────────────

export async function saveSupervisedSession(session: SupervisedSession): Promise<void> {
  await dbPut<SupervisedSession>(STORE.SUPERVISED_SESSIONS, session)
}

export async function getSupervisedSession(id: string): Promise<SupervisedSession | undefined> {
  return dbGet<SupervisedSession>(STORE.SUPERVISED_SESSIONS, id)
}
