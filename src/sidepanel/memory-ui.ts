/**
 * Memory UI — browse and search session/global memory entries.
 */

import { MSG } from '../shared/constants'
import type { SessionMemoryEntry, GlobalMemoryEntry } from '../shared/types'

interface MemoryResponse {
  ok: boolean
  session?: SessionMemoryEntry[]
  global?: GlobalMemoryEntry[]
}

export async function initMemory(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="memory-container">
      <div class="memory-header">
        <h2>Memory</h2>
        <input type="search" id="memory-search" placeholder="Search memory…" class="search-input">
      </div>
      <div class="memory-tabs">
        <button class="mem-tab active" data-tab="session">Session</button>
        <button class="mem-tab" data-tab="global">Global</button>
      </div>
      <div id="memory-list" class="memory-list">
        <p class="hint-text">Loading…</p>
      </div>
    </div>
  `

  let sessionEntries: SessionMemoryEntry[] = []
  let globalEntries: GlobalMemoryEntry[] = []
  let activeTab = 'session'

  async function loadData(): Promise<void> {
    const res = await chrome.runtime.sendMessage({ type: MSG.MEMORY_LIST }) as MemoryResponse
    sessionEntries = res.session ?? []
    globalEntries = res.global ?? []
    renderList()
  }

  function renderList(filter = ''): void {
    const listEl = container.querySelector('#memory-list')!
    const query = filter.toLowerCase()

    if (activeTab === 'session') {
      const entries = sessionEntries
        .filter(e => !query || e.content.toLowerCase().includes(query) || e.url.toLowerCase().includes(query))
        .slice(0, 100)

      if (entries.length === 0) {
        listEl.innerHTML = '<p class="hint-text">No session memory yet. Browse some pages to start building memory.</p>'
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
          ${e.tags.length ? `<div class="memory-tags">${e.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
        </div>
      `).join('')
    } else {
      const entries = globalEntries
        .filter(e => !query || e.summary.toLowerCase().includes(query) || e.domain.toLowerCase().includes(query))
        .slice(0, 50)

      if (entries.length === 0) {
        listEl.innerHTML = '<p class="hint-text">No global memory yet. Keep using the assistant and it will build up over time.</p>'
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

  // Tab switching
  container.querySelectorAll('.mem-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.mem-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeTab = (btn as HTMLElement).dataset.tab!
      renderList((container.querySelector('#memory-search') as HTMLInputElement).value)
    })
  })

  // Search
  let searchDebounce: ReturnType<typeof setTimeout> | null = null
  container.querySelector('#memory-search')?.addEventListener('input', (e) => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      renderList((e.target as HTMLInputElement).value)
    }, 300)
  })

  await loadData()
}

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
