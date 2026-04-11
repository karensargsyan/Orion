import { MSG } from '../shared/constants'

interface ActiveGroupInfo {
  groupId: number
  title: string
  color: string
  sessionId: string | null
  paused: boolean
  tabIds: number[]
}

const COLOR_MAP: Record<string, string> = {
  grey: '#9aa0a6',
  blue: '#8ab4f8',
  cyan: '#78d9ec',
  green: '#81c995',
  yellow: '#fdd663',
  red: '#f28b82',
  pink: '#ff8bcb',
  purple: '#c58af9',
  orange: '#fcad70',
}

let listContainer: HTMLElement | null = null

export function initActiveTabs(container: HTMLElement): void {
  container.innerHTML = `
    <div class="active-tabs-container">
      <div class="active-tabs-header">
        <h2>Active Groups</h2>
        <button class="btn-small btn-refresh-groups" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
        </button>
      </div>
      <div class="active-tabs-list"></div>
    </div>
  `
  listContainer = container.querySelector('.active-tabs-list')
  container.querySelector('.btn-refresh-groups')?.addEventListener('click', () => refreshGroupList())
  refreshGroupList()
}

export async function refreshGroupList(): Promise<void> {
  if (!listContainer) return

  let groups: ActiveGroupInfo[] = []
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.GET_ACTIVE_GROUPS })
    if (resp?.ok) groups = resp.groups ?? []
  } catch { /* SW not ready */ }

  if (groups.length === 0) {
    listContainer.innerHTML = `
      <div class="active-tabs-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3">
          <rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect>
          <rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect>
        </svg>
        <p>No active groups</p>
        <p class="hint">Click the Orion icon on any tab to create a group</p>
      </div>
    `
    return
  }

  listContainer.innerHTML = groups.map(g => {
    const dotColor = COLOR_MAP[g.color] ?? COLOR_MAP.grey
    const statusClass = g.paused ? 'status-paused' : 'status-running'
    const statusLabel = g.paused ? 'Paused' : 'Running'
    const pauseBtnLabel = g.paused ? 'Resume' : 'Pause'
    const pauseBtnClass = g.paused ? 'btn-primary' : 'btn-warning'
    const pauseIcon = g.paused
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'
    return `
      <div class="active-group-card${g.paused ? ' group-paused' : ''}" data-group-id="${g.groupId}">
        <div class="group-info">
          <span class="group-color-dot" style="background:${dotColor}"></span>
          <div class="group-details">
            <span class="group-name">${escapeHtml(g.title)}</span>
            <span class="group-meta">${g.tabIds.length} tab${g.tabIds.length !== 1 ? 's' : ''} <span class="group-status ${statusClass}">${statusLabel}</span></span>
          </div>
        </div>
        <div class="group-actions">
          <button class="btn-small ${pauseBtnClass} btn-pause-group" data-group-id="${g.groupId}" data-paused="${g.paused}" title="${pauseBtnLabel}">
            ${pauseIcon} ${pauseBtnLabel}
          </button>
          <button class="btn-small btn-danger btn-stop-group" data-group-id="${g.groupId}" title="Stop group">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
            Stop
          </button>
        </div>
      </div>
    `
  }).join('')

  // Wire up buttons
  listContainer.querySelectorAll<HTMLButtonElement>('.btn-pause-group').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gid = Number(btn.dataset.groupId)
      const isPaused = btn.dataset.paused === 'true'
      const msgType = isPaused ? MSG.RESUME_GROUP : MSG.PAUSE_GROUP
      await chrome.runtime.sendMessage({ type: msgType, groupId: gid }).catch(() => {})
      refreshGroupList()
    })
  })

  listContainer.querySelectorAll<HTMLButtonElement>('.btn-stop-group').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gid = Number(btn.dataset.groupId)
      await chrome.runtime.sendMessage({ type: MSG.STOP_GROUP, groupId: gid }).catch(() => {})
      refreshGroupList()
    })
  })
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
