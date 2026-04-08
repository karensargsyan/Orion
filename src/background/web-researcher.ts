import { ensureContentScript } from './action-executor'
import { MSG } from '../shared/constants'
import type { SearchResult, PageContent } from '../shared/types'

const researchTabIds = new Set<number>()
const TAB_LOAD_TIMEOUT = 15000

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
    const tab = await chrome.tabs.create({ url, active: false })
    tabId = tab.id!
    researchTabIds.add(tabId)

    await waitForTabLoad(tabId)
    await sleep(800)

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractGoogleResults,
    })

    const searchResults = (results?.[0]?.result as SearchResult[]) ?? []
    return searchResults.slice(0, 8)
  } catch (err) {
    return [{ title: 'Search error', url: '', snippet: String(err) }]
  } finally {
    if (tabId) await safeCloseTab(tabId)
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

export async function openAndReadTab(url: string): Promise<PageContent> {
  let tabId: number | undefined
  try {
    const tab = await chrome.tabs.create({ url, active: false })
    tabId = tab.id!
    researchTabIds.add(tabId)

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
    const text = (response?.pageText ?? response?.visibleText ?? '').slice(0, 8000)

    return {
      title: tabInfo.title ?? url,
      url: tabInfo.url ?? url,
      text: text || 'No readable content found on this page.',
    }
  } catch (err) {
    return { title: url, url, text: `Error reading page: ${err}` }
  } finally {
    if (tabId) await safeCloseTab(tabId)
  }
}

async function safeCloseTab(tabId: number): Promise<void> {
  researchTabIds.delete(tabId)
  try { await chrome.tabs.remove(tabId) } catch { /* already closed */ }
}

export async function closeAllResearchTabs(): Promise<void> {
  for (const tabId of researchTabIds) {
    await safeCloseTab(tabId)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
