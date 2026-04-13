/**
 * Memory UI — AI-powered memory search + browse session/global entries.
 *
 * Combines IDB text search, MemPalace semantic search, and AI synthesis
 * to help users find links, data, and content from their browsing history.
 */

import { MSG, PORT_AI_STREAM, STORE } from '../shared/constants'
import { renderMarkdown, sanitizeHtml } from './markdown'
import type { SessionMemoryEntry, GlobalMemoryEntry, InputJournalEntry } from '../shared/types'

// ─── Module state ────────────────────────────────────────────────────────────

let searchPort: chrome.runtime.Port | null = null
let isSearching = false
let currentTabId = 0

// Memory data cache
let sessionEntries: SessionMemoryEntry[] = []
let globalEntries: GlobalMemoryEntry[] = []

// ─── Init ────────────────────────────────────────────────────────────────────

export async function initMemory(container: HTMLElement, tabId: number): Promise<void> {
  currentTabId = tabId

  container.innerHTML = `
    <div class="memory-container">
      <div class="memory-search-header">
        <div class="memory-search-row">
          <input type="text" id="memory-search-input" class="memory-search-input" placeholder="Search your memory... e.g. &quot;that property in Italy&quot;">
          <button id="btn-memory-search" class="btn-primary btn-memory-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          </button>
        </div>
      </div>
      <div class="memory-view-bar">
        <button class="memory-view-btn active" data-view="search">AI Search</button>
        <button class="memory-view-btn" data-view="journal">Journal</button>
        <button class="memory-view-btn" data-view="session">Session</button>
        <button class="memory-view-btn" data-view="global">Global</button>
      </div>
      <div id="memory-search-panel" class="memory-view-panel active">
        <div id="memory-ai-area" class="memory-ai-area">
          <div class="memory-empty-state">
            <div class="memory-empty-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            </div>
            <p>Search your browsing history, saved links, and memories</p>
            <p class="memory-empty-examples">Try: "that booking site" &middot; "article about AI" &middot; "link I opened yesterday"</p>
          </div>
        </div>
      </div>
      <div id="memory-browse-panel" class="memory-view-panel">
        <div class="memory-browse-header">
          <input type="search" id="memory-filter" placeholder="Filter entries..." class="search-input">
        </div>
        <div id="memory-browse-list" class="memory-list">
          <p class="hint-text">Loading...</p>
        </div>
      </div>
      <div id="memory-journal-panel" class="memory-view-panel">
        <div id="memory-journal-list" class="memory-list">
          <p class="hint-text">Loading journal...</p>
        </div>
      </div>
    </div>
  `

  // Wire view toggle
  let activeView = 'search'
  container.querySelectorAll('.memory-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = (btn as HTMLElement).dataset.view!
      activeView = view
      container.querySelectorAll('.memory-view-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')

      const searchPanel = container.querySelector('#memory-search-panel') as HTMLElement
      const browsePanel = container.querySelector('#memory-browse-panel') as HTMLElement

      const journalPanel = container.querySelector('#memory-journal-panel') as HTMLElement

      searchPanel.classList.remove('active')
      browsePanel.classList.remove('active')
      journalPanel.classList.remove('active')

      if (view === 'search') {
        searchPanel.classList.add('active')
      } else if (view === 'journal') {
        journalPanel.classList.add('active')
        renderJournalList(container)
      } else {
        browsePanel.classList.add('active')
        renderBrowseList(container, view, '')
      }
    })
  })

  // Wire search
  const searchInput = container.querySelector('#memory-search-input') as HTMLInputElement
  const searchBtn = container.querySelector('#btn-memory-search') as HTMLButtonElement

  searchBtn.addEventListener('click', () => doSearch(container, searchInput.value.trim()))
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doSearch(container, searchInput.value.trim())
    }
  })

  // Wire browse filter
  let filterDebounce: ReturnType<typeof setTimeout> | null = null
  container.querySelector('#memory-filter')?.addEventListener('input', (e) => {
    if (filterDebounce) clearTimeout(filterDebounce)
    filterDebounce = setTimeout(() => {
      renderBrowseList(container, activeView, (e.target as HTMLInputElement).value)
    }, 300)
  })

  // Load data
  await loadData()

  // Focus search input
  searchInput.focus()
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadData(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.MEMORY_LIST }) as {
      ok: boolean; session?: SessionMemoryEntry[]; global?: GlobalMemoryEntry[]
    }
    sessionEntries = res.session ?? []
    globalEntries = res.global ?? []
  } catch { /* no data */ }
}

// ─── AI Search ───────────────────────────────────────────────────────────────

function doSearch(container: HTMLElement, query: string): void {
  if (!query || isSearching) return
  isSearching = true

  const aiArea = container.querySelector('#memory-ai-area') as HTMLElement

  // Show searching state
  aiArea.innerHTML = `
    <div class="memory-searching">
      <div class="analyzing-spinner"></div>
      <p>Searching your memory...</p>
    </div>
  `

  // Disconnect old port if any
  if (searchPort) {
    try { searchPort.disconnect() } catch { /* already disconnected */ }
    searchPort = null
  }

  // Connect streaming port
  const port = chrome.runtime.connect({ name: PORT_AI_STREAM })
  searchPort = port

  let answerText = ''
  let answerEl: HTMLElement | null = null
  let rawSourcesRendered = false

  port.onMessage.addListener((msg: Record<string, unknown>) => {
    switch (msg.type as string) {
      case MSG.MEMORY_SEARCH_CONTEXT: {
        // Render raw sources below AI answer
        const idbResults = msg.idbResults as string ?? ''
        const mempalaceResults = msg.mempalaceResults as string ?? ''
        const urlEntries = msg.urlEntries as Array<{ date: string; type: string; domain: string; url: string; content: string }> ?? []
        const journalResultsRaw = msg.journalResults as string ?? ''
        rawSourcesRendered = true

        // We'll append raw sources after the AI answer area
        renderRawSources(aiArea, idbResults, mempalaceResults, urlEntries, journalResultsRaw)
        break
      }

      case MSG.STREAM_CHUNK: {
        const chunk = msg.chunk as string ?? ''
        if (!answerEl) {
          // Remove searching indicator, create answer container
          const searchingEl = aiArea.querySelector('.memory-searching')
          if (searchingEl) searchingEl.remove()

          answerEl = document.createElement('div')
          answerEl.className = 'memory-ai-response'
          // Insert before raw sources if they exist
          const rawSources = aiArea.querySelector('.memory-raw-sources')
          if (rawSources) {
            aiArea.insertBefore(answerEl, rawSources)
          } else {
            aiArea.appendChild(answerEl)
          }
        }

        answerText += chunk
        answerEl.innerHTML = sanitizeHtml(renderMarkdown(answerText))
        break
      }

      case MSG.STREAM_END: {
        const fullText = msg.fullText as string ?? answerText
        if (answerEl) {
          answerEl.innerHTML = sanitizeHtml(renderMarkdown(fullText))
          makeLinksClickable(answerEl)
        } else if (fullText) {
          // No chunks received, just full text
          const searchingEl = aiArea.querySelector('.memory-searching')
          if (searchingEl) searchingEl.remove()

          answerEl = document.createElement('div')
          answerEl.className = 'memory-ai-response'
          answerEl.innerHTML = sanitizeHtml(renderMarkdown(fullText))
          const rawSources = aiArea.querySelector('.memory-raw-sources')
          if (rawSources) {
            aiArea.insertBefore(answerEl, rawSources)
          } else {
            aiArea.appendChild(answerEl)
          }
          makeLinksClickable(answerEl)
        }
        isSearching = false
        try { port.disconnect() } catch { /* ok */ }
        searchPort = null
        break
      }

      case MSG.STREAM_ERROR: {
        const error = msg.error as string ?? 'Search failed'
        const searchingEl = aiArea.querySelector('.memory-searching')
        if (searchingEl) searchingEl.remove()

        const errorEl = document.createElement('div')
        errorEl.className = 'message message-error'
        errorEl.textContent = error
        aiArea.appendChild(errorEl)

        isSearching = false
        try { port.disconnect() } catch { /* ok */ }
        searchPort = null
        break
      }
    }
  })

  port.onDisconnect.addListener(() => {
    isSearching = false
    searchPort = null
  })

  // Send search request
  port.postMessage({
    type: MSG.AI_MEMORY_SEARCH,
    query,
    tabId: currentTabId,
  })
}

// ─── Raw sources (collapsible) ───────────────────────────────────────────────

function renderRawSources(
  container: HTMLElement,
  idbResults: string,
  mempalaceResults: string,
  urlEntries: Array<{ date: string; type: string; domain: string; url: string; content: string }>,
  journalResults?: string
): void {
  // Remove existing raw sources
  const existing = container.querySelector('.memory-raw-sources')
  if (existing) existing.remove()

  const totalSources = urlEntries.length + (idbResults ? 1 : 0) + (mempalaceResults ? 1 : 0) + (journalResults ? 1 : 0)
  if (totalSources === 0) return

  const details = document.createElement('details')
  details.className = 'memory-raw-sources'

  const summary = document.createElement('summary')
  summary.textContent = `Raw sources (${urlEntries.length} entries${mempalaceResults ? ' + MemPalace' : ''}${journalResults ? ' + Journal' : ''})`
  details.appendChild(summary)

  const content = document.createElement('div')
  content.className = 'memory-raw-content'

  // Journal results
  if (journalResults) {
    const section = document.createElement('div')
    section.className = 'raw-section'
    section.innerHTML = `<div class="raw-section-label">Input Journal (Total Recall)</div><pre class="raw-section-text">${escHtml(journalResults)}</pre>`
    content.appendChild(section)
  }

  // URL entries
  if (urlEntries.length > 0) {
    for (const entry of urlEntries) {
      const card = document.createElement('div')
      card.className = 'memory-raw-entry'
      card.innerHTML = `
        <div class="raw-entry-meta">
          <span class="memory-type-badge memory-type-${escHtml(entry.type)}">${escHtml(entry.type.replace('_', ' '))}</span>
          <span class="memory-domain">${escHtml(entry.domain)}</span>
          <span class="memory-time">${escHtml(entry.date)}</span>
        </div>
        <a href="${escAttr(entry.url)}" class="raw-entry-url" title="${escAttr(entry.url)}">${escHtml(entry.url)}</a>
        <div class="raw-entry-content">${escHtml(entry.content)}</div>
      `
      // Wire link click
      const link = card.querySelector('.raw-entry-url') as HTMLAnchorElement
      if (link) {
        link.addEventListener('click', (e) => {
          e.preventDefault()
          chrome.tabs.create({ url: entry.url })
        })
      }
      content.appendChild(card)
    }
  }

  // MemPalace results
  if (mempalaceResults) {
    const section = document.createElement('div')
    section.className = 'raw-section'
    section.innerHTML = `<div class="raw-section-label">MemPalace semantic matches</div><pre class="raw-section-text">${escHtml(mempalaceResults)}</pre>`
    content.appendChild(section)
  }

  details.appendChild(content)
  container.appendChild(details)
}

// ─── Link handling ───────────────────────────────────────────────────────────

function makeLinksClickable(el: HTMLElement): void {
  el.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
    if (a.dataset.wired) return
    a.dataset.wired = 'true'
    a.addEventListener('click', (e) => {
      e.preventDefault()
      const url = a.href
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        chrome.tabs.create({ url })
      }
    })
  })
}

// ─── Browse view (Session / Global) ──────────────────────────────────────────

function renderBrowseList(container: HTMLElement, view: string, filter: string): void {
  const listEl = container.querySelector('#memory-browse-list')!
  const query = filter.toLowerCase()

  if (view === 'session') {
    const entries = sessionEntries
      .filter(e => !query || e.content.toLowerCase().includes(query) || e.url.toLowerCase().includes(query))
      .slice(0, 100)

    if (entries.length === 0) {
      listEl.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center">No session memory yet. Browse some pages to start building memory.</p>'
      return
    }

    listEl.innerHTML = entries.map(e => `
      <div class="memory-entry">
        <div class="memory-entry-meta">
          <span class="memory-type-badge memory-type-${e.type}">${e.type.replace('_', ' ')}</span>
          <span class="memory-domain">${getDomain(e.url)}</span>
          <span class="memory-time">${formatTime(e.timestamp)}</span>
        </div>
        <div class="memory-content">${escHtml(e.content)}</div>
        ${e.url ? `<a href="${escAttr(e.url)}" class="memory-entry-link" title="${escAttr(e.url)}">${escHtml(getDomain(e.url) + e.url.replace(/https?:\/\/[^/]+/, '').slice(0, 60))}</a>` : ''}
        ${e.tags.length ? `<div class="memory-tags">${e.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    `).join('')

    // Wire links
    listEl.querySelectorAll<HTMLAnchorElement>('.memory-entry-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        chrome.tabs.create({ url: a.href })
      })
    })
  } else {
    const entries = globalEntries
      .filter(e => !query || e.summary.toLowerCase().includes(query) || e.domain.toLowerCase().includes(query))
      .slice(0, 50)

    if (entries.length === 0) {
      listEl.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center">No global memory yet. Keep using the assistant and it will build up over time.</p>'
      return
    }

    listEl.innerHTML = entries.map(e => `
      <div class="memory-entry">
        <div class="memory-entry-meta">
          <span class="memory-domain">${escHtml(e.domain)}</span>
          <span class="memory-importance">importance: ${(e.importance * 100).toFixed(0)}%</span>
          <span class="memory-time">${formatTime(e.timestamp)}</span>
        </div>
        <div class="memory-content">${escHtml(e.summary)}</div>
        ${e.tags.length ? `<div class="memory-tags">${e.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    `).join('')
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url.slice(0, 30) }
}

function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return d.toLocaleDateString()
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Journal Browse View ────────────────────────────────────────────────────

const FIELD_TYPE_ICONS: Record<string, string> = {
  email: '\u2709',      // envelope
  password: '\uD83D\uDD12', // lock
  username: '\uD83D\uDC64', // bust
  phone: '\uD83D\uDCDE',    // phone
  firstName: '\uD83D\uDC64',
  lastName: '\uD83D\uDC64',
  fullName: '\uD83D\uDC64',
  birthday: '\uD83C\uDF82', // cake
  street: '\uD83C\uDFE0',   // house
  city: '\uD83C\uDFD9',     // cityscape
  state: '\uD83C\uDFD9',
  zip: '\uD83D\uDCEE',      // postbox
  country: '\uD83C\uDF0D',  // globe
  cardNumber: '\uD83D\uDCB3', // credit card
  cardExpiry: '\uD83D\uDCB3',
  cardCvv: '\uD83D\uDCB3',
  cardholderName: '\uD83D\uDCB3',
  company: '\uD83C\uDFE2',  // office
  unknown: '\u2699',    // gear
}

const ENCRYPTED_FIELD_TYPES = new Set(['password', 'cardNumber', 'cardCvv', 'cardExpiry'])

async function renderJournalList(container: HTMLElement): Promise<void> {
  const listEl = container.querySelector('#memory-journal-list') as HTMLElement
  if (!listEl) return

  listEl.innerHTML = '<div class="analyzing-spinner" style="margin:20px auto"></div>'

  try {
    // Fetch recent journal entries from the background via IDB (sidepanel has direct access)
    const { openDB } = await import('../shared/idb')
    const db = await openDB()
    const tx = db.transaction('input_journal', 'readonly')
    const store = tx.objectStore('input_journal')
    const index = store.index('by_timestamp')

    const entries: InputJournalEntry[] = await new Promise((resolve, reject) => {
      const results: InputJournalEntry[] = []
      const req = index.openCursor(null, 'prev')
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || results.length >= 100) { resolve(results); return }
        results.push(cursor.value as InputJournalEntry)
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })

    if (entries.length === 0) {
      listEl.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center">No inputs recorded yet. Fill some forms to start building your recall journal.</p>'
      return
    }

    // Group by domain
    const grouped = new Map<string, InputJournalEntry[]>()
    for (const e of entries) {
      const key = e.domain || 'unknown'
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(e)
    }

    listEl.innerHTML = ''

    for (const [domain, domEntries] of grouped) {
      const group = document.createElement('div')
      group.className = 'journal-group'

      const header = document.createElement('div')
      header.className = 'journal-group-header'
      header.textContent = domain
      group.appendChild(header)

      for (const entry of domEntries) {
        const icon = FIELD_TYPE_ICONS[entry.fieldType] || '\u2699'
        const isEncrypted = entry.encrypted || ENCRYPTED_FIELD_TYPES.has(entry.fieldType)
        const displayValue = isEncrypted ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : escHtml(entry.value).slice(0, 80)

        const row = document.createElement('div')
        row.className = 'journal-entry'
        row.innerHTML = `
          <span class="journal-icon">${icon}</span>
          <span class="journal-label">${escHtml(entry.fieldLabel || entry.fieldType)}</span>
          <span class="journal-value ${isEncrypted ? 'journal-encrypted' : ''}" data-real="${escAttr(isEncrypted ? '' : entry.value)}">${displayValue}</span>
          <span class="journal-time">${formatTime(entry.timestamp)}</span>
          <button class="journal-copy-btn" title="Copy value">\uD83D\uDCCB</button>
        `

        // Copy button handler
        const copyBtn = row.querySelector('.journal-copy-btn') as HTMLButtonElement
        copyBtn.addEventListener('click', async () => {
          let valueToCopy = entry.value
          if (entry.encrypted) {
            try {
              // Try to decrypt via background
              const res = await chrome.runtime.sendMessage({ type: 'JOURNAL_DECRYPT', entryId: entry.id })
              if (res?.ok) valueToCopy = res.value
              else { copyBtn.textContent = '\u274C'; return }
            } catch {
              copyBtn.textContent = '\u274C'; return
            }
          }
          await navigator.clipboard.writeText(valueToCopy)
          copyBtn.textContent = '\u2705'
          setTimeout(() => { copyBtn.textContent = '\uD83D\uDCCB' }, 1500)
        })

        group.appendChild(row)
      }

      listEl.appendChild(group)
    }
  } catch (err) {
    listEl.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center;color:var(--text-dim)">Failed to load journal entries.</p>'
    console.warn('[MemoryUI] Journal load error:', err)
  }
}
