/**
 * Web Researcher — opens tabs for Google search and page reading.
 * Groups all research tabs under a collapsible "AI Research" tab group.
 * Tabs are kept open during multi-step research and cleaned up when done.
 */

import { ensureContentScript } from './action-executor'
import { MSG } from '../shared/constants'
import type { SearchResult, PageContent } from '../shared/types'

const researchTabIds = new Set<number>()
let researchGroupId: number | null = null
const TAB_LOAD_TIMEOUT = 15_000
const MAX_RESEARCH_TABS = 8

// ─── Tab Group Management ────────────────────────────────────────────────────

async function getOrCreateResearchGroup(windowId?: number): Promise<number | null> {
  // Reuse existing group if still alive
  if (researchGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(researchGroupId)
      if (group) return researchGroupId
    } catch { /* group was closed */ }
    researchGroupId = null
  }

  // Find an existing "AI Research" group in this window
  try {
    const groups = await chrome.tabGroups.query({ title: 'AI Research' })
    if (groups.length > 0) {
      researchGroupId = groups[0].id
      return researchGroupId
    }
  } catch { /* tabGroups API not available */ }

  return null
}

async function addTabToResearchGroup(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    const groupId = await getOrCreateResearchGroup(tab.windowId)

    if (groupId !== null) {
      // Add to existing group
      await chrome.tabs.group({ tabIds: [tabId], groupId })
    } else {
      // Create new group
      const newGroupId = await chrome.tabs.group({ tabIds: [tabId] })
      researchGroupId = newGroupId
      await chrome.tabGroups.update(newGroupId, {
        title: 'AI Research',
        color: 'blue',
        collapsed: true,
      })
    }
  } catch {
    // tabGroups API may not be available — that's fine, tabs still work
  }
}

async function createResearchTab(url: string): Promise<chrome.tabs.Tab> {
  // Enforce max research tabs — close oldest if at limit
  if (researchTabIds.size >= MAX_RESEARCH_TABS) {
    const oldest = researchTabIds.values().next().value
    if (oldest !== undefined) await safeCloseTab(oldest)
  }

  const tab = await chrome.tabs.create({ url, active: false })
  researchTabIds.add(tab.id!)
  await addTabToResearchGroup(tab.id!)
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
  const url = `https://www.google.com/search?q=${encoded}&hl=en&num=8`

  let tabId: number | undefined
  try {
    const tab = await createResearchTab(url)
    tabId = tab.id!

    await waitForTabLoad(tabId)
    await sleep(800)

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractGoogleResults,
    })

    const searchResults = (results?.[0]?.result as SearchResult[]) ?? []
    // Close the Google search tab (results are extracted, no need to keep it)
    await safeCloseTab(tabId)
    return searchResults.slice(0, 8)
  } catch (err) {
    if (tabId) await safeCloseTab(tabId)
    return [{ title: 'Search error', url: '', snippet: String(err) }]
  }
}

function extractGoogleResults(): SearchResult[] {
  const results: SearchResult[] = []
  const containers = document.querySelectorAll('div.g, div[data-sokoban-container]')

  for (const container of containers) {
    const linkEl = container.querySelector('a[href]') as HTMLAnchorElement | null
    const titleEl = container.querySelector('h3')
    const snippetEl = container.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]')

    if (!linkEl || !titleEl) continue
    const href = linkEl.href
    if (!href || href.startsWith('https://www.google.com')) continue

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

    return {
      title: tabInfo.title ?? url,
      url: tabInfo.url ?? url,
      text: text || 'No readable content found on this page.',
    }
  } catch (err) {
    return { title: url, url, text: `Error reading page: ${err}` }
  }
  // NOTE: tab is NOT auto-closed here — it stays in the research group
  // so the AI can revisit it or the user can see it. Cleaned up via closeAllResearchTabs().
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
    try { await chrome.tabs.remove(tabId) } catch { /* already closed */ }
  }

  // Reset group tracking
  researchGroupId = null
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
