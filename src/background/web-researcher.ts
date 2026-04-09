/**
 * Web Researcher — opens tabs for Google search and page reading.
 * Groups all AI-managed tabs (research + automation) under a collapsible "AI Working" tab group.
 * Tabs are kept open during multi-step research and cleaned up when done.
 */

import { ensureContentScript } from './action-executor'
import { MSG } from '../shared/constants'
import type { SearchResult, PageContent } from '../shared/types'

const researchTabIds = new Set<number>()
let aiGroupId: number | null = null
const TAB_LOAD_TIMEOUT = 15_000
const MAX_RESEARCH_TABS = 8

// ─── Tab Group Management ────────────────────────────────────────────────────

const AI_GROUP_TITLE = 'Orion'
const AI_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'blue'

async function getOrCreateAIGroup(windowId?: number): Promise<number | null> {
  // Reuse existing group if still alive
  if (aiGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(aiGroupId)
      if (group) return aiGroupId
    } catch { /* group was closed */ }
    aiGroupId = null
  }

  // Find an existing "AI Working" group in this window
  try {
    const groups = await chrome.tabGroups.query({ title: AI_GROUP_TITLE })
    if (groups.length > 0) {
      aiGroupId = groups[0].id
      return aiGroupId
    }
  } catch { /* tabGroups API not available */ }

  return null
}

/**
 * Add any tab to the shared AI tab group.
 * Used by both the web researcher (for research tabs) and the action executor (for the main working tab).
 */
export async function addTabToAIGroup(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    const groupId = await getOrCreateAIGroup(tab.windowId)

    if (groupId !== null) {
      // Add to existing group
      await chrome.tabs.group({ tabIds: [tabId], groupId })
    } else {
      // Create new group
      const newGroupId = await chrome.tabs.group({ tabIds: [tabId] })
      aiGroupId = newGroupId
      await chrome.tabGroups.update(newGroupId, {
        title: AI_GROUP_TITLE,
        color: AI_GROUP_COLOR,
        collapsed: false,
      })
    }
  } catch {
    // tabGroups API may not be available — that's fine, tabs still work
  }
}

/**
 * Remove a tab from the AI group (e.g., when automation finishes on the main tab).
 * If the tab was the last in the group, Chrome auto-removes the group.
 */
export async function removeTabFromAIGroup(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId !== undefined && tab.groupId !== -1 && tab.groupId === aiGroupId) {
      await chrome.tabs.ungroup([tabId])
    }
  } catch { /* tab already gone or API unavailable */ }
}

async function createResearchTab(url: string): Promise<chrome.tabs.Tab> {
  // Enforce max research tabs — close oldest if at limit
  if (researchTabIds.size >= MAX_RESEARCH_TABS) {
    const oldest = researchTabIds.values().next().value
    if (oldest !== undefined) await safeCloseTab(oldest)
  }

  const tab = await chrome.tabs.create({ url, active: false })
  researchTabIds.add(tab.id!)
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

  // Reset group tracking (only if no other tabs remain in the group)
  aiGroupId = null
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
