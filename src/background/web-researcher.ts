/**
 * Web Researcher — opens tabs for Google search and page reading.
 * Groups all AI-managed tabs (research + automation) under a collapsible "AI Working" tab group.
 * Tabs are kept open during multi-step research and cleaned up when done.
 */

import { ensureContentScript } from './action-executor'
import { MSG } from '../shared/constants'
import type { SearchResult, PageContent } from '../shared/types'
import { logTabEvent } from './error-logger'

const researchTabIds = new Set<number>()
const TAB_LOAD_TIMEOUT = 15_000
const MAX_RESEARCH_TABS = 6

// ─── Global Tab Registry ────────────────────────────────────────────────────
// Tracks ALL tabs opened by any part of the extension (research, workflow, etc.)

const extensionTabIds = new Set<number>()
const GLOBAL_TAB_LIMIT = 12

/** Register a tab as extension-managed. Enforces global limit. */
export function registerExtensionTab(tabId: number): void {
  extensionTabIds.add(tabId)
  // Enforce global limit — close oldest if over
  if (extensionTabIds.size > GLOBAL_TAB_LIMIT) {
    const oldest = extensionTabIds.values().next().value
    if (oldest !== undefined && oldest !== tabId) {
      extensionTabIds.delete(oldest)
      logTabEvent('limit_evicted', oldest, '', 'research')
      chrome.tabs.remove(oldest).catch(() => {})
      researchTabIds.delete(oldest) // also clean up if it was a research tab
    }
  }
}

/** Unregister a tab (called when tab is closed). */
export function unregisterExtensionTab(tabId: number): void {
  extensionTabIds.delete(tabId)
}

/** Get total count of extension-managed tabs. */
export function getExtensionTabCount(): number {
  return extensionTabIds.size
}

/** Check if tab is extension-managed. */
export function isExtensionTab(tabId: number): boolean {
  return extensionTabIds.has(tabId)
}

/** Find an existing extension tab with the same URL (cross-system dedup). */
export async function findExistingExtensionTab(url: string): Promise<number | undefined> {
  const targetHref = new URL(url).href
  for (const tabId of extensionTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.url && new URL(tab.url).href === targetHref) return tabId
    } catch { extensionTabIds.delete(tabId) } // tab was closed
  }
  return undefined
}

/**
 * Prune stale entries from both registries.
 * Tabs may have been closed externally (by the user or a crash) without
 * the onRemoved listener firing (e.g. service worker was suspended).
 * Called periodically from the alarm handler.
 */
export async function pruneStaleExtensionTabs(): Promise<number> {
  let pruned = 0
  for (const tabId of [...extensionTabIds]) {
    try { await chrome.tabs.get(tabId) } catch {
      extensionTabIds.delete(tabId)
      researchTabIds.delete(tabId)
      pruned++
    }
  }
  return pruned
}

// ─── Tab Group Management ────────────────────────────────────────────────────
//
// Each tab where the user opens the panel gets its OWN group with a unique color.
// Research tabs opened by the extension join the group of the tab that triggered them.
// Tabs the user didn't open the panel on are NEVER grouped.

const AI_GROUP_TITLE = 'Orion'
const GROUP_COLORS: chrome.tabGroups.ColorEnum[] = ['blue', 'cyan', 'green', 'yellow', 'orange', 'pink', 'purple', 'red']
let colorIndex = 0

/** Maps an origin tabId → its group id */
const tabGroupMap = new Map<number, number>()

/** Maps a groupId → its unique session id (for group-based chat) */
const groupSessionMap = new Map<number, string>()

/** The "active" origin tab whose research tabs should be grouped together */
let activeOriginTabId: number | null = null

function nextGroupColor(): chrome.tabGroups.ColorEnum {
  const color = GROUP_COLORS[colorIndex % GROUP_COLORS.length]
  colorIndex++
  return color
}

/**
 * Create a new Orion group for a tab where the user opened the panel.
 * Each panel-open gets its own uniquely colored group.
 */
export async function createGroupForTab(tabId: number, title?: string): Promise<number> {
  // If this tab already has a group, reuse it
  const existingGroupId = tabGroupMap.get(tabId)
  if (existingGroupId !== undefined) {
    try {
      await chrome.tabGroups.get(existingGroupId)
      return existingGroupId // group still alive — keep existing session
    } catch { tabGroupMap.delete(tabId) }
  }

  try {
    // Determine initial title: "Orion: {domain}" or "Orion: New"
    let groupTitle = title ? `Orion: ${title}` : 'Orion: New'
    if (!title) {
      try {
        const tab = await chrome.tabs.get(tabId)
        const url = tab.url ?? ''
        if (url && !url.startsWith('chrome://') && !url.startsWith('about:') && !url.startsWith('chrome-extension://')) {
          const domain = extractDomainShort(url)
          if (domain) groupTitle = `Orion: ${domain}`
        }
      } catch { /* use default */ }
    }

    const newGroupId = await chrome.tabs.group({ tabIds: [tabId] })
    await chrome.tabGroups.update(newGroupId, {
      title: groupTitle,
      color: nextGroupColor(),
      collapsed: false,
    })
    tabGroupMap.set(tabId, newGroupId)
    // Generate unique session for this group — fresh chat context
    const sid = `session_orion_${Date.now()}`
    groupSessionMap.set(newGroupId, sid)
    activeOriginTabId = tabId
    return newGroupId
  } catch {
    /* tabGroups API may not be available */
    return -1
  }
}

/** Extract short domain for group title (strips www.) */
function extractDomainShort(url: string): string {
  try {
    const host = new URL(url).hostname
    return host.replace(/^www\./, '')
  } catch { return '' }
}

/**
 * Ungroup a tab and clean up its group tracking.
 * Called when the user closes the panel on a tab.
 */
export async function ungroupTab(tabId: number): Promise<void> {
  tabGroupMap.delete(tabId)
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId !== undefined && tab.groupId !== -1) {
      await chrome.tabs.ungroup([tabId])
    }
  } catch { /* tab already gone */ }
}

/** Set which origin tab is currently active (research tabs join this group) */
export function setActiveOriginTab(tabId: number): void {
  activeOriginTabId = tabId
}

/** Get the group id for the currently active origin tab */
function getActiveGroupId(): number | null {
  if (activeOriginTabId === null) return null
  const gid = tabGroupMap.get(activeOriginTabId)
  if (gid === undefined) return null
  return gid
}

/** Check if a tab has an Orion group */
export function hasOrionGroup(tabId: number): boolean {
  return tabGroupMap.has(tabId)
}

/** Returns true if the tab belongs to Orion (grouped or research tab). */
export function isOrionTab(tabId: number): boolean {
  return tabGroupMap.has(tabId) || researchTabIds.has(tabId)
}

/** Clean up tracking when a tab is removed */
export function cleanupTabGroup(tabId: number): void {
  const groupId = tabGroupMap.get(tabId)
  tabGroupMap.delete(tabId)
  if (activeOriginTabId === tabId) activeOriginTabId = null
  // If no other tabs reference this groupId, clean up the session too
  if (groupId !== undefined) {
    let groupStillReferenced = false
    for (const gid of tabGroupMap.values()) {
      if (gid === groupId) { groupStillReferenced = true; break }
    }
    if (!groupStillReferenced) groupSessionMap.delete(groupId)
  }
}

/** Update the title of a tab's group (e.g. for Telegram auto-rename) */
export async function updateGroupTitle(tabId: number, title: string): Promise<void> {
  const groupId = tabGroupMap.get(tabId)
  if (groupId === undefined) return
  try {
    await chrome.tabGroups.update(groupId, { title })
  } catch { /* group may be gone */ }
}

/** Get the session id for a tab's group (fast path — tabGroupMap lookup) */
export function getGroupSessionId(tabId: number): string | null {
  const groupId = tabGroupMap.get(tabId)
  if (groupId === undefined) return null
  return groupSessionMap.get(groupId) ?? null
}

/** Resolve group session for a tab, with Chrome API fallback for manually moved tabs */
export async function resolveGroupSession(tabId: number): Promise<string | null> {
  // Fast path: tabGroupMap
  const directSid = getGroupSessionId(tabId)
  if (directSid) return directSid
  // Slow path: query Chrome for the tab's actual groupId
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId && tab.groupId !== -1) {
      const sid = groupSessionMap.get(tab.groupId)
      if (sid) {
        tabGroupMap.set(tabId, tab.groupId) // cache for next time
        return sid
      }
    }
  } catch { /* tab gone */ }
  return null
}

/**
 * Add a tab to the active origin tab's group.
 * Used by research tabs — they join the group of the tab that triggered the research.
 */
export async function addTabToAIGroup(tabId: number): Promise<void> {
  const groupId = getActiveGroupId()
  if (groupId === null) return

  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId })
    tabGroupMap.set(tabId, groupId) // track so research tabs inherit group session
  } catch { /* group gone or API unavailable */ }
}

/** @deprecated — kept for compatibility, use ungroupTab instead */
export async function removeTabFromAIGroup(tabId: number): Promise<void> {
  await ungroupTab(tabId)
}

async function createResearchTab(url: string): Promise<chrome.tabs.Tab> {
  // Cross-system dedup: check if ANY extension tab already has this URL
  const existingTabId = await findExistingExtensionTab(url).catch(() => undefined)
  if (existingTabId != null) {
    const existingTab = await chrome.tabs.get(existingTabId)
    researchTabIds.add(existingTabId)
    return existingTab
  }

  // Enforce max research tabs — close oldest if at limit
  if (researchTabIds.size >= MAX_RESEARCH_TABS) {
    const oldest = researchTabIds.values().next().value
    if (oldest !== undefined) await safeCloseTab(oldest)
  }

  const tab = await chrome.tabs.create({ url, active: false })
  researchTabIds.add(tab.id!)
  registerExtensionTab(tab.id!)
  logTabEvent('created', tab.id!, url, 'research')
  await addTabToAIGroup(tab.id!)
  // Enable sidebar on research tabs so it's visible if user switches to them
  await chrome.sidePanel.setOptions({
    tabId: tab.id!,
    path: 'sidepanel/sidepanel.html',
    enabled: true,
  }).catch(() => {})
  return tab
}

// ─── Core Research Functions ─────────────────────────────────────────────────

async function waitForTabLoad(tabId: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < TAB_LOAD_TIMEOUT) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') return
    } catch { return }
    await sleep(500)
  }
}

export async function searchGoogle(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query)
  // Use consent-bypass parameters to avoid GDPR consent page in EU
  const url = `https://www.google.com/search?q=${encoded}&hl=en&num=8&gl=us`

  let tabId: number | undefined
  try {
    const tab = await createResearchTab(url)
    tabId = tab.id!

    await waitForTabLoad(tabId)
    await sleep(1200)

    // Try to dismiss Google consent page if present
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Click "Accept all" / "I agree" / "Alle akzeptieren" buttons on consent page
          const btns = document.querySelectorAll('button')
          for (const btn of btns) {
            const text = (btn.textContent ?? '').toLowerCase()
            if (text.includes('accept') || text.includes('agree') || text.includes('akzeptieren') || text.includes('zustimmen')) {
              btn.click()
              return true
            }
          }
          // Also try form-based consent
          const form = document.querySelector('form[action*="consent"]') as HTMLFormElement
          if (form) { form.submit(); return true }
          return false
        },
      })
      // If consent was dismissed, wait for the actual search results to load
      await sleep(2000)
      await waitForTabLoad(tabId)
      await sleep(800)
    } catch { /* no consent page or script injection failed */ }

    // Try structured extraction first
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractGoogleResults,
    })
    let searchResults = (results?.[0]?.result as SearchResult[]) ?? []

    // Fallback: if structured extraction failed, read full page text and extract links
    if (searchResults.length === 0) {
      try {
        const textResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractSearchResultsFromText,
        })
        searchResults = (textResults?.[0]?.result as SearchResult[]) ?? []
      } catch { /* ignore */ }
    }

    await safeCloseTab(tabId)
    return searchResults.slice(0, 8)
  } catch (err) {
    if (tabId) await safeCloseTab(tabId)
    return [{ title: 'Search error', url: '', snippet: String(err) }]
  }
}

/** Fallback: extract any links + surrounding text from the page when structured selectors fail */
function extractSearchResultsFromText(): SearchResult[] {
  const results: SearchResult[] = []
  const links = document.querySelectorAll('a[href^="http"]')

  for (const link of links) {
    const href = (link as HTMLAnchorElement).href
    if (!href || href.includes('google.com') || href.includes('accounts.google') || href.includes('support.google')) continue
    const title = link.textContent?.trim() ?? ''
    if (!title || title.length < 3) continue

    // Get snippet from parent or sibling text
    const parent = link.closest('div, li, article, section')
    const snippet = parent?.textContent?.trim().slice(0, 200) ?? ''

    // Deduplicate by domain
    try {
      const domain = new URL(href).hostname
      if (results.some(r => new URL(r.url).hostname === domain)) continue
    } catch { continue }

    results.push({ title: title.slice(0, 100), url: href, snippet })
    if (results.length >= 8) break
  }
  return results
}

function extractGoogleResults(): SearchResult[] {
  const results: SearchResult[] = []
  // Multiple selectors for different Google layouts (keeps changing)
  const containers = document.querySelectorAll(
    'div.g, div[data-sokoban-container], div[data-hveid] div[data-snf], div.MjjYud div[data-snf], div.MjjYud'
  )

  for (const container of containers) {
    const linkEl = container.querySelector('a[href]') as HTMLAnchorElement | null
    const titleEl = container.querySelector('h3')
    // Multiple snippet selectors for different Google versions
    const snippetEl = container.querySelector(
      '[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"], .lEBKkf, span.aCOpRe, div.IsZvec'
    )

    if (!linkEl || !titleEl) continue
    const href = linkEl.href
    if (!href || href.includes('google.com/search') || href.includes('accounts.google')) continue

    // Deduplicate by URL
    if (results.some(r => r.url === href)) continue

    results.push({
      title: titleEl.textContent?.trim() ?? '',
      url: href,
      snippet: snippetEl?.textContent?.trim().slice(0, 200) ?? '',
    })

    if (results.length >= 8) break
  }

  return results
}

/**
 * Open a URL in a research tab and read its content.
 * The tab stays open in the "AI Research" group so the AI can revisit it.
 */
export async function openAndReadTab(url: string): Promise<PageContent> {
  let tabId: number | undefined
  try {
    // Check if we already have this URL open in a research tab
    for (const existingTabId of researchTabIds) {
      try {
        const tab = await chrome.tabs.get(existingTabId)
        if (tab.url && new URL(tab.url).href === new URL(url).href) {
          tabId = existingTabId
          break
        }
      } catch { /* tab gone */ researchTabIds.delete(existingTabId) }
    }

    // Open new tab if not already open
    if (!tabId) {
      const tab = await createResearchTab(url)
      tabId = tab.id!
    }

    await waitForTabLoad(tabId)
    await sleep(500)

    const alive = await ensureContentScript(tabId)
    if (!alive) {
      return { title: url, url, text: 'Could not inject content script into this page.' }
    }

    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.REQUEST_PAGE_TEXT }) as {
      ok: boolean; pageText?: string; visibleText?: string
    }

    const tabInfo = await chrome.tabs.get(tabId)
    const text = (response?.pageText ?? response?.visibleText ?? '').slice(0, 12_000)

    const result = {
      title: tabInfo.title ?? url,
      url: tabInfo.url ?? url,
      text: text || 'No readable content found on this page.',
    }

    // Auto-close after reading — content is captured, no need to keep the tab open
    await safeCloseTab(tabId)

    return result
  } catch (err) {
    if (tabId) await safeCloseTab(tabId).catch(() => {})
    return { title: url, url, text: `Error reading page: ${err}` }
  }
}

/**
 * Open multiple URLs at once for parallel research.
 * Returns content from all pages.
 */
export async function openAndReadMultipleTabs(urls: string[]): Promise<PageContent[]> {
  const limited = urls.slice(0, MAX_RESEARCH_TABS)
  return Promise.all(limited.map(url => openAndReadTab(url)))
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function safeCloseTab(tabId: number): Promise<void> {
  researchTabIds.delete(tabId)
  extensionTabIds.delete(tabId)
  logTabEvent('closed', tabId, '', 'research')
  try { await chrome.tabs.remove(tabId) } catch { /* already closed */ }
}

/**
 * Close all research tabs and disband the tab group.
 * Called when the AI signals research is complete.
 */
export async function closeAllResearchTabs(): Promise<void> {
  const tabIds = [...researchTabIds]
  researchTabIds.clear()

  for (const tabId of tabIds) {
    extensionTabIds.delete(tabId) // explicit cleanup — don't rely solely on onRemoved
    try { await chrome.tabs.remove(tabId) } catch { /* already closed */ }
  }
}

/** Get the number of currently open research tabs. */
export function getResearchTabCount(): number {
  return researchTabIds.size
}

/** Check if a tab is a research tab. */
export function isResearchTab(tabId: number): boolean {
  return researchTabIds.has(tabId)
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
