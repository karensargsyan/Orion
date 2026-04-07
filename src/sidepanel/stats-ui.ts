import { MSG } from '../shared/constants'
import type { DetectedCalendarEvent } from '../shared/types'

interface DomainStat {
  domain: string
  count: number
  lastVisit: number
}

export async function initStats(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="stats-container">
      <div class="stats-header">
        <h2>Insights</h2>
      </div>
      <div class="stats-tabs">
        <button class="stat-tab active" data-tab="overview">Overview</button>
        <button class="stat-tab" data-tab="calendar">Calendar</button>
        <button class="stat-tab" data-tab="habits">Habits</button>
      </div>
      <div id="stats-content" class="stats-content">
        <p class="hint-text" style="padding:12px">Loading insights...</p>
      </div>
    </div>
  `

  let activeStatTab = 'overview'

  container.querySelectorAll('.stat-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.stat-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeStatTab = (btn as HTMLElement).dataset.tab!
      renderTab(activeStatTab)
    })
  })

  async function renderTab(tab: string): Promise<void> {
    const content = container.querySelector('#stats-content')!
    if (tab === 'overview') await renderOverview(content)
    else if (tab === 'calendar') await renderCalendar(content)
    else if (tab === 'habits') await renderHabits(content)
  }

  await renderTab('overview')
}

async function renderOverview(container: Element): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_STATS }) as {
    ok: boolean; stats?: DomainStat[]
  }
  const stats = res.stats ?? []

  if (stats.length === 0) {
    container.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center">No browsing data yet. Keep using the extension to build insights.</p>'
    return
  }

  const totalVisits = stats.reduce((s, d) => s + d.count, 0)
  const topDomains = stats.slice(0, 10)

  container.innerHTML = `
    <div class="stats-overview">
      <div class="stat-card">
        <div class="stat-number">${totalVisits}</div>
        <div class="stat-label">Total Activities</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${stats.length}</div>
        <div class="stat-label">Domains Tracked</div>
      </div>
    </div>
    <div class="stats-section">
      <h3>Most Visited</h3>
      <div class="domain-list">
        ${topDomains.map((d, i) => `
          <div class="domain-row">
            <span class="domain-rank">${i + 1}</span>
            <span class="domain-name">${esc(d.domain)}</span>
            <div class="domain-bar-container">
              <div class="domain-bar" style="width:${Math.round(d.count / topDomains[0].count * 100)}%"></div>
            </div>
            <span class="domain-count">${d.count}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `
}

async function renderCalendar(container: Element): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_CALENDAR_EVENTS }) as {
    ok: boolean; events?: DetectedCalendarEvent[]
  }
  const events = res.events ?? []

  if (events.length === 0) {
    container.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center">No calendar events detected yet. Browse emails and web pages with dates to detect events.</p>'
    return
  }

  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date))

  container.innerHTML = `
    <div class="calendar-list">
      ${sorted.map(e => `
        <div class="calendar-event">
          <div class="cal-date">
            <span class="cal-day">${new Date(e.date).getDate()}</span>
            <span class="cal-month">${new Date(e.date).toLocaleDateString('en', { month: 'short' })}</span>
          </div>
          <div class="cal-details">
            <div class="cal-title">${esc(e.title)}</div>
            ${e.time ? `<div class="cal-time">${esc(e.time)}${e.endTime ? ' - ' + esc(e.endTime) : ''}</div>` : ''}
            ${e.location ? `<div class="cal-location">${esc(e.location)}</div>` : ''}
            ${e.description ? `<div class="cal-desc">${esc(e.description.slice(0, 100))}</div>` : ''}
          </div>
          <div class="cal-actions">
            <button class="btn-small btn-gcal" data-event='${esc(JSON.stringify(e))}' title="Add to Google Calendar">+ GCal</button>
          </div>
        </div>
      `).join('')}
    </div>
  `

  container.querySelectorAll('.btn-gcal').forEach(btn => {
    btn.addEventListener('click', () => {
      const event = JSON.parse((btn as HTMLElement).dataset.event!) as DetectedCalendarEvent
      const start = (event.date + (event.time ? 'T' + event.time.replace(':', '') + '00' : '')).replace(/[-:]/g, '')
      const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: event.title,
        dates: `${start}/${start}`,
        details: event.description ?? '',
        location: event.location ?? '',
      })
      window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, '_blank')
    })
  })
}

async function renderHabits(container: Element): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_HABITS }) as {
    ok: boolean; patterns?: Array<{ pattern: string; confidence: number; domain: string }>
  }
  const patterns = res.patterns ?? []

  if (patterns.length === 0) {
    container.innerHTML = '<p class="hint-text" style="padding:20px;text-align:center">Not enough data to detect habits yet. Keep browsing to build patterns.</p>'
    return
  }

  container.innerHTML = `
    <div class="habits-list">
      ${patterns.map(p => `
        <div class="habit-item">
          <div class="habit-pattern">${esc(p.pattern)}</div>
          <div class="habit-meta">
            <span class="habit-domain">${esc(p.domain)}</span>
            <span class="habit-confidence">${Math.round(p.confidence * 100)}% confident</span>
          </div>
        </div>
      `).join('')}
    </div>
  `
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
