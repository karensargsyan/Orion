/**
 * Quick Action Command Palette — a floating overlay for fast command execution.
 * Uses Shadow DOM for full style isolation from the host page.
 * Toggle via the 'orion-toggle-palette' custom event on document.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface PaletteResult {
  label: string
  description: string
  action: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HOST_ID = '__orion-command-palette'
const MAX_VISIBLE = 8
const DEBOUNCE_MS = 180

// ─── State ───────────────────────────────────────────────────────────────────

let hostEl: HTMLDivElement | null = null
let shadowRoot: ShadowRoot | null = null
let inputEl: HTMLInputElement | null = null
let listEl: HTMLDivElement | null = null
let results: PaletteResult[] = []
let selectedIndex = -1
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// ─── Styles ──────────────────────────────────────────────────────────────────

const PALETTE_CSS = /* css */ `
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 18vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    pointer-events: auto;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    animation: fadeIn 120ms ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-12px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .palette {
    position: relative;
    z-index: 1;
    width: 520px;
    max-width: calc(100vw - 32px);
    background: #1a1c25;
    border: 1px solid rgba(108, 92, 231, 0.25);
    border-radius: 14px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.55),
                0 0 0 1px rgba(108, 92, 231, 0.08);
    overflow: hidden;
    animation: slideDown 150ms ease-out;
  }

  .search-wrap {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(228, 230, 239, 0.08);
    gap: 10px;
  }

  .search-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    color: rgba(228, 230, 239, 0.4);
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 15px;
    font-family: inherit;
    color: #e4e6ef;
    caret-color: #6c5ce7;
    line-height: 1.5;
  }

  .search-input::placeholder {
    color: rgba(228, 230, 239, 0.35);
  }

  .results {
    max-height: ${MAX_VISIBLE * 52}px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 0;
    scrollbar-width: thin;
    scrollbar-color: rgba(108, 92, 231, 0.3) transparent;
  }

  .results::-webkit-scrollbar {
    width: 5px;
  }

  .results::-webkit-scrollbar-track {
    background: transparent;
  }

  .results::-webkit-scrollbar-thumb {
    background: rgba(108, 92, 231, 0.3);
    border-radius: 3px;
  }

  .result-item {
    display: flex;
    flex-direction: column;
    padding: 10px 16px;
    cursor: pointer;
    transition: background 80ms ease;
    border-left: 3px solid transparent;
  }

  .result-item:hover,
  .result-item.selected {
    background: rgba(108, 92, 231, 0.12);
    border-left-color: #6c5ce7;
  }

  .result-label {
    font-size: 14px;
    font-weight: 500;
    color: #e4e6ef;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .result-desc {
    font-size: 12px;
    color: rgba(228, 230, 239, 0.45);
    line-height: 1.3;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty {
    padding: 24px 16px;
    text-align: center;
    color: rgba(228, 230, 239, 0.3);
    font-size: 13px;
  }

  .hint-bar {
    display: flex;
    gap: 12px;
    padding: 8px 16px;
    border-top: 1px solid rgba(228, 230, 239, 0.06);
    font-size: 11px;
    color: rgba(228, 230, 239, 0.25);
  }

  .hint-bar kbd {
    display: inline-block;
    padding: 1px 5px;
    background: rgba(228, 230, 239, 0.06);
    border: 1px solid rgba(228, 230, 239, 0.1);
    border-radius: 4px;
    font-family: inherit;
    font-size: 10px;
    color: rgba(228, 230, 239, 0.4);
    margin: 0 2px;
    vertical-align: baseline;
  }
`

// ─── DOM Construction ────────────────────────────────────────────────────────

function buildDOM(): { host: HTMLDivElement; shadow: ShadowRoot; input: HTMLInputElement; list: HTMLDivElement } {
  const host = document.createElement('div')
  host.id = HOST_ID

  const shadow = host.attachShadow({ mode: 'open' })

  // Inline styles
  const styleEl = document.createElement('style')
  styleEl.textContent = PALETTE_CSS
  shadow.appendChild(styleEl)

  // Backdrop
  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'
  backdrop.addEventListener('click', () => hideCommandPalette())
  shadow.appendChild(backdrop)

  // Palette container
  const palette = document.createElement('div')
  palette.className = 'palette'
  shadow.appendChild(palette)

  // Search wrapper
  const searchWrap = document.createElement('div')
  searchWrap.className = 'search-wrap'
  palette.appendChild(searchWrap)

  // Search icon (inline SVG)
  const iconWrap = document.createElement('div')
  iconWrap.className = 'search-icon'
  iconWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`
  searchWrap.appendChild(iconWrap)

  // Search input
  const input = document.createElement('input')
  input.className = 'search-input'
  input.type = 'text'
  input.placeholder = 'Type a command...'
  input.spellcheck = false
  input.autocomplete = 'off'
  searchWrap.appendChild(input)

  // Results list
  const list = document.createElement('div')
  list.className = 'results'
  palette.appendChild(list)

  // Hint bar
  const hintBar = document.createElement('div')
  hintBar.className = 'hint-bar'
  hintBar.innerHTML =
    `<span><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span>` +
    `<span><kbd>Enter</kbd> select</span>` +
    `<span><kbd>Esc</kbd> close</span>`
  palette.appendChild(hintBar)

  return { host, shadow, input, list }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderResults(): void {
  if (!listEl) return
  listEl.innerHTML = ''

  if (results.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = inputEl?.value ? 'No matching commands' : 'Start typing to search commands...'
    listEl.appendChild(empty)
    return
  }

  results.forEach((r, i) => {
    const item = document.createElement('div')
    item.className = 'result-item' + (i === selectedIndex ? ' selected' : '')
    item.setAttribute('data-index', String(i))

    const label = document.createElement('div')
    label.className = 'result-label'
    label.textContent = r.label

    const desc = document.createElement('div')
    desc.className = 'result-desc'
    desc.textContent = r.description

    item.appendChild(label)
    item.appendChild(desc)

    item.addEventListener('mouseenter', () => {
      selectedIndex = i
      updateSelection()
    })

    item.addEventListener('click', () => {
      executeSelected()
    })

    listEl.appendChild(item)
  })
}

function updateSelection(): void {
  if (!listEl) return
  const items = listEl.querySelectorAll('.result-item')
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === selectedIndex)
  })

  // Scroll selected item into view
  if (selectedIndex >= 0 && selectedIndex < items.length) {
    items[selectedIndex].scrollIntoView({ block: 'nearest' })
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────

function performSearch(query: string): void {
  chrome.runtime.sendMessage(
    { type: 'COMMAND_PALETTE_SEARCH', query },
    (response: PaletteResult[] | undefined) => {
      if (chrome.runtime.lastError) {
        results = []
      } else {
        results = Array.isArray(response) ? response : []
      }
      selectedIndex = results.length > 0 ? 0 : -1
      renderResults()
    }
  )
}

function debouncedSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  const query = inputEl?.value.trim() ?? ''
  debounceTimer = setTimeout(() => performSearch(query), DEBOUNCE_MS)
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function executeSelected(): void {
  if (selectedIndex < 0 || selectedIndex >= results.length) return
  const selected = results[selectedIndex]
  chrome.runtime.sendMessage(
    { type: 'COMMAND_PALETTE_EXECUTE', action: selected.action },
    () => {
      if (chrome.runtime.lastError) {
        // Silently ignore — extension context may have been invalidated
      }
    }
  )
  hideCommandPalette()
}

// ─── Keyboard Handling ───────────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      if (results.length > 0) {
        selectedIndex = (selectedIndex + 1) % results.length
        updateSelection()
      }
      break

    case 'ArrowUp':
      e.preventDefault()
      if (results.length > 0) {
        selectedIndex = selectedIndex <= 0 ? results.length - 1 : selectedIndex - 1
        updateSelection()
      }
      break

    case 'Enter':
      e.preventDefault()
      executeSelected()
      break

    case 'Escape':
      e.preventDefault()
      hideCommandPalette()
      break
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function showCommandPalette(): void {
  // Already open — refocus
  if (hostEl && document.body.contains(hostEl)) {
    inputEl?.focus()
    return
  }

  const { host, shadow, input, list } = buildDOM()
  hostEl = host
  shadowRoot = shadow
  inputEl = input
  listEl = list
  results = []
  selectedIndex = -1

  // Wire events
  input.addEventListener('input', debouncedSearch)
  input.addEventListener('keydown', onKeyDown)

  // Inject into page
  document.body.appendChild(host)

  // Focus after mount (next frame to ensure render)
  requestAnimationFrame(() => {
    input.focus()
  })

  // Initial render (empty state)
  renderResults()
}

export function hideCommandPalette(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  if (hostEl && document.body.contains(hostEl)) {
    document.body.removeChild(hostEl)
  }

  hostEl = null
  shadowRoot = null
  inputEl = null
  listEl = null
  results = []
  selectedIndex = -1
}

export function isPaletteVisible(): boolean {
  return hostEl !== null && document.body.contains(hostEl)
}

// ─── Custom Event Listener ───────────────────────────────────────────────────

document.addEventListener('orion-toggle-palette', () => {
  if (isPaletteVisible()) {
    hideCommandPalette()
  } else {
    showCommandPalette()
  }
})

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TOGGLE_COMMAND_PALETTE') {
    document.dispatchEvent(new CustomEvent('orion-toggle-palette'))
  }
})
