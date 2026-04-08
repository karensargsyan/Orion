import { MSG, PORT_AI_STREAM } from '../shared/constants'
import { renderMarkdown, sanitizeHtml } from './markdown'

let searchInput: HTMLInputElement
let searchResults: HTMLElement
let searchPort: chrome.runtime.Port | null = null
let isSearching = false
let currentTabId = 0

export function initSearch(container: HTMLElement, tabId: number): void {
  currentTabId = tabId

  container.innerHTML = `
    <div class="search-container">
      <div class="search-header">
        <h2>Search & Ask</h2>
        <p class="hint-text">Search your history, or ask a question about past activity.</p>
      </div>
      <div class="search-input-row">
        <input type="search" id="global-search-input" placeholder="Search pages, messages, fields, or ask anything..." autocomplete="off" />
        <button id="global-search-btn" class="btn-primary btn-send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        </button>
      </div>
      <div id="search-results" class="search-results"></div>
    </div>
  `

  searchInput = container.querySelector('#global-search-input')!
  searchResults = container.querySelector('#search-results')!

  container.querySelector('#global-search-btn')?.addEventListener('click', doSearch)
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doSearch()
    }
  })

  searchInput.focus()
}

async function doSearch(): Promise<void> {
  const query = searchInput.value.trim()
  if (!query || isSearching) return

  isSearching = true
  searchResults.innerHTML = '<p class="hint-text" style="padding:12px;text-align:center">Searching...</p>'

  const textResults = await fetchTextSearch(query)
  const isQuestion = query.includes('?') || query.split(' ').length > 3
  || /^(where|what|when|how|who|which|why|did|do|find|show|tell)/i.test(query)

  if (isQuestion) {
    await askAI(query, textResults)
  } else {
    renderTextResults(textResults)
  }

  isSearching = false
}

async function fetchTextSearch(query: string): Promise<string> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.GLOBAL_SEARCH,
      query,
    }) as { ok: boolean; results?: string }
    return res.ok ? (res.results ?? '') : ''
  } catch { return '' }
}

function renderTextResults(text: string): void {
  if (!text) {
    searchResults.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center">No results found.</p>'
    return
  }

  const entries = text.split('\n\n').filter(Boolean)
  searchResults.innerHTML = entries.map(entry => {
    const headerMatch = entry.match(/^\[([^\]]+)\]\s*(.*)$/s)
    if (headerMatch) {
      return `<div class="search-result-item">
        <div class="search-result-meta">${escHtml(headerMatch[1])}</div>
        <div class="search-result-text">${escHtml(headerMatch[2])}</div>
      </div>`
    }
    return `<div class="search-result-item"><div class="search-result-text">${escHtml(entry)}</div></div>`
  }).join('')
}

async function askAI(query: string, context: string): Promise<void> {
  searchResults.innerHTML = '<p class="hint-text" style="padding:12px;text-align:center">Thinking...</p>'

  if (searchPort) {
    try { searchPort.disconnect() } catch { /* ignore */ }
  }
  searchPort = chrome.runtime.connect({ name: PORT_AI_STREAM })

  let fullAnswer = ''
  const answerEl = document.createElement('div')
  answerEl.className = 'search-ai-answer'
  searchResults.innerHTML = ''
  searchResults.appendChild(answerEl)

  searchPort.onMessage.addListener((msg: { type: string; chunk?: string; fullText?: string; error?: string }) => {
    if (msg.type === MSG.STREAM_CHUNK) {
      fullAnswer += msg.chunk ?? ''
      answerEl.innerHTML = sanitizeHtml(renderMarkdown(fullAnswer))
    }
    if (msg.type === MSG.STREAM_END) {
      fullAnswer = msg.fullText ?? fullAnswer
      answerEl.innerHTML = sanitizeHtml(renderMarkdown(fullAnswer))
      if (context) {
        const sourceNote = document.createElement('details')
        sourceNote.className = 'search-sources'
        sourceNote.innerHTML = `<summary>Sources</summary><pre>${escHtml(context.slice(0, 2000))}</pre>`
        searchResults.appendChild(sourceNote)
      }
    }
    if (msg.type === MSG.STREAM_ERROR) {
      answerEl.innerHTML = `<p class="error-text">Error: ${escHtml(msg.error ?? 'Unknown')}</p>`
    }
  })

  searchPort.postMessage({
    type: MSG.AI_RECALL,
    query: `Based on the following browser activity log, answer the user's question as helpfully as possible.\n\nActivity Log:\n${context.slice(0, 3000)}\n\nQuestion: ${query}`,
    sessionId: `search_${Date.now()}`,
    tabId: currentTabId,
  })
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
