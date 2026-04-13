/**
 * Context Stack Viewer (V3: FR-V3-2)
 * Shows all context sources feeding the AI prompt with token estimates and toggles.
 */

import { MSG } from '../shared/constants'

export interface ContextSource {
  name: string
  type: 'page' | 'memory' | 'system' | 'user'
  tokens: number
  enabled: boolean
  preview: string
}

/** Set of source names the user has toggled off. Persisted in-memory per session. */
const disabledSources = new Set<string>()

export function getDisabledSources(): Set<string> {
  return disabledSources
}

export function createContextStackPanel(tabId: number): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'context-stack-panel'
  panel.id = `context-stack-${tabId}`
  panel.style.display = 'none'
  panel.innerHTML = `
    <div class="context-stack-header">
      <span class="context-stack-title">Context Sources</span>
      <span class="context-stack-total" id="ctx-total-${tabId}">0 tokens</span>
      <button class="context-stack-close" title="Close">&times;</button>
    </div>
    <div class="context-stack-bar-container">
      <div class="context-stack-bar" id="ctx-bar-${tabId}"></div>
    </div>
    <div class="context-stack-list" id="ctx-list-${tabId}"></div>
  `

  panel.querySelector('.context-stack-close')!.addEventListener('click', () => {
    panel.style.display = 'none'
  })

  return panel
}

export async function refreshContextStack(tabId: number, panel: HTMLElement): Promise<void> {
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.GET_CONTEXT_STACK, tabId }) as {
      ok?: boolean
      sources?: ContextSource[]
      totalTokens?: number
    }
    if (!resp?.ok || !resp.sources) return

    const sources = resp.sources
    const totalTokens = resp.totalTokens ?? 0

    // Update total
    const totalEl = panel.querySelector(`#ctx-total-${tabId}`)
    if (totalEl) totalEl.textContent = `${totalTokens.toLocaleString()} tokens`

    // Update bar
    const barEl = panel.querySelector(`#ctx-bar-${tabId}`)
    if (barEl) {
      const maxTokens = 32768 // approximate context window
      const pct = Math.min(100, Math.round((totalTokens / maxTokens) * 100))
      const color = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning, #f59e0b)' : 'var(--accent)'
      ;(barEl as HTMLElement).style.cssText = `width:${pct}%;background:${color};height:100%;border-radius:3px;transition:width 0.3s ease`
    }

    // Update list
    const listEl = panel.querySelector(`#ctx-list-${tabId}`)
    if (!listEl) return
    listEl.innerHTML = ''

    const typeIcons: Record<string, string> = {
      page: '&#128196;',
      memory: '&#129504;',
      system: '&#9881;',
      user: '&#128100;',
    }

    for (const src of sources) {
      const isDisabled = disabledSources.has(src.name)
      const item = document.createElement('div')
      item.className = `context-stack-item${isDisabled ? ' disabled' : ''}${!src.enabled ? ' empty' : ''}`

      const tokenStr = src.tokens > 0 ? src.tokens.toLocaleString() : '0'

      item.innerHTML = `
        <div class="ctx-item-header">
          <span class="ctx-item-icon">${typeIcons[src.type] ?? ''}</span>
          <span class="ctx-item-name">${src.name}</span>
          <span class="ctx-item-tokens">${tokenStr}</span>
          <label class="ctx-item-toggle">
            <input type="checkbox" ${src.enabled && !isDisabled ? 'checked' : ''} ${!src.enabled ? 'disabled' : ''}>
            <span class="ctx-toggle-slider"></span>
          </label>
        </div>
        ${src.preview ? `<div class="ctx-item-preview" style="display:none">${escapeHtml(src.preview)}</div>` : ''}
      `

      // Toggle expand
      const header = item.querySelector('.ctx-item-header')!
      header.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.ctx-item-toggle')) return
        const preview = item.querySelector('.ctx-item-preview')
        if (preview) {
          const isVisible = preview.getAttribute('style') === ''
          ;(preview as HTMLElement).style.display = isVisible ? 'none' : ''
        }
      })

      // Toggle enable/disable
      const checkbox = item.querySelector('input[type="checkbox"]') as HTMLInputElement
      if (checkbox && src.enabled) {
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            disabledSources.delete(src.name)
            item.classList.remove('disabled')
          } else {
            disabledSources.add(src.name)
            item.classList.add('disabled')
          }
        })
      }

      listEl.appendChild(item)
    }
  } catch {
    // SW may not be ready
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
