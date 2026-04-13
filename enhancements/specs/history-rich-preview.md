# Rich History Item Previews

**Slug:** history-rich-preview
**Type:** Improvement (UI + data)
**Priority:** P2 (medium — usability, not broken)
**Requested:** 2026-04-12
**Status:** SPECCED

## Summary
The history tab shows each conversation as a bare session-type label ("Orion session" or a domain) plus a timestamp. There is no preview of what the conversation was about, no message count, and no last-message excerpt. Users cannot identify which session to return to without clicking each one. All data needed for richer display is already stored in IndexedDB — this is a rendering change only.

## Current Behavior
**File:** `src/sidepanel/sidepanel.ts` — `initHistory()` lines 38–93

Each history item renders:
```html
<div class="session-item" data-session="session_orion_1712345678000">
  <div class="session-date">🚀 Orion session</div>
  <div class="session-id">Apr 4, 2024, 2:14:56 PM</div>  <!-- only if timestamp parseable -->
</div>
```

Data shown: session type icon + label + timestamp. Nothing about conversation content.

**Data available but unused** (already in IndexedDB via `getSessionMessages(sessionId, 50)`):
- First user message → conversation title
- Last message timestamp → "last active"
- Message count
- URL of first message → domain context

## Desired Behavior
Each history item shows:
```
┌─────────────────────────────────────────────┐
│ 🚀  "How do I book a flight to Paris?"       │  ← first user msg (60 chars)
│     mail.google.com · 3h ago · 12 messages  │  ← domain, relative time, count
└─────────────────────────────────────────────┘
```

- **Title line:** First user message text, truncated to 60 characters
- **Meta line:** domain from URL · relative time · message count
- **Fallback title:** If no user message: session type label as before
- **Loading:** Show a skeleton/spinner while messages load asynchronously

## Technical Analysis

**Files to modify:**
- `src/sidepanel/sidepanel.ts` — `initHistory()` (lines 38–93) and `renderSessionItem()`

**Data fetching approach:**
The current `initHistory()` fetches all session IDs from `getAllSessions()` and renders synchronously. To add content previews, we need to fetch a preview per session. Options:

1. **Lazy-load on scroll** — render basic items first, fetch previews as they enter viewport (best for many sessions)
2. **Batch fetch on open** — fetch first message of each session concurrently on panel open (simpler, fine for <50 sessions)

Recommend option 2 (simpler, users rarely have >50 sessions):

```typescript
// New helper in memory-manager.ts
export async function getSessionPreview(sessionId: string): Promise<{
  title: string
  domain: string
  lastTimestamp: number
  messageCount: number
}> {
  const msgs = await getSessionMessages(sessionId, 50)
  const userMsgs = msgs.filter(m => m.role === 'user')
  const firstUser = userMsgs[0]
  const lastMsg = msgs[msgs.length - 1]
  const title = firstUser
    ? firstUser.content.replace(/\s+/g, ' ').slice(0, 60) + (firstUser.content.length > 60 ? '…' : '')
    : ''
  const domain = firstUser?.url ? new URL(firstUser.url).hostname.replace('www.', '') : ''
  return {
    title,
    domain,
    lastTimestamp: lastMsg?.timestamp ?? 0,
    messageCount: msgs.filter(m => m.role === 'user' || m.role === 'assistant').length,
  }
}
```

**Relative time helper:**
```typescript
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString()
}
```

**Updated `renderSessionItem()` in `sidepanel.ts`:**
```typescript
function renderSessionItem(sid: string, preview?: SessionPreview): string {
  const isOrion = sid.startsWith('session_orion_')
  const isDomain = sid.startsWith('session_domain_')
  const icon = isOrion ? '🚀' : isDomain ? '🌐' : '💬'
  const fallbackLabel = isDomain ? sid.replace('session_domain_', '') : 'Session'

  const title = preview?.title || fallbackLabel
  const meta: string[] = []
  if (preview?.domain) meta.push(preview.domain)
  if (preview?.lastTimestamp) meta.push(relativeTime(preview.lastTimestamp))
  if (preview?.messageCount) meta.push(`${preview.messageCount} messages`)

  return `<div class="session-item" data-session="${escHtml(sid)}">
    <div class="session-title">${icon} ${escHtml(title)}</div>
    ${meta.length ? `<div class="session-meta">${escHtml(meta.join(' · '))}</div>` : ''}
  </div>`
}
```

**Updated `initHistory()` loading flow:**
```typescript
async function initHistory() {
  const container = document.getElementById('history-list')
  if (!container) return
  container.innerHTML = '<div class="loading-spinner">Loading…</div>'

  const sessions = await getAllSessions()  // existing function
  // Render skeleton items immediately
  container.innerHTML = sessions.map(sid => renderSessionItem(sid)).join('')

  // Then enrich with previews concurrently (cap at 30 parallel)
  const batch = sessions.slice(0, 30)
  await Promise.all(batch.map(async sid => {
    const preview = await getSessionPreview(sid)  // new function
    const el = container.querySelector(`[data-session="${CSS.escape(sid)}"]`)
    if (el) el.outerHTML = renderSessionItem(sid, preview)
  }))
}
```

**CSS additions** (in sidepanel styles):
```css
.session-item { padding: 10px 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
.session-item:hover { background: var(--hover-bg); }
.session-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
```

## Acceptance Criteria
- [ ] AC1: Each history item shows the first user message (truncated to 60 chars) as its title
- [ ] AC2: Each item shows domain, relative time ("3h ago"), and message count in a meta line
- [ ] AC3: Sessions with no user messages fall back to the current label (session type)
- [ ] AC4: History panel loads within 500ms — basic items appear immediately, previews populate within 1s
- [ ] AC5: Items remain clickable and load the full conversation as before
- [ ] AC6: Relative time updates correctly: <1h shows minutes, <24h shows hours, else shows days

## Files to Modify
- `src/sidepanel/sidepanel.ts` — `initHistory()` (lines 38–93), add `relativeTime()`, update `renderSessionItem()`
- `src/background/memory-manager.ts` — add `getSessionPreview()` function
- `src/sidepanel/sidepanel.css` or inline styles — add `.session-title`, `.session-meta` styles

## Regression Risk
- `getSessionMessages()` is called up to 30× on panel open — verify IndexedDB performance is acceptable (messages store is indexed by sessionId, so lookups are O(1))
- `data-session` click handler in `initHistory()` lines 86–91 must still work after outerHTML replacement — use event delegation on the container instead of per-item listeners

## Out of Scope
- Search/filter UI in the history panel
- User-editable session titles
- Deleting individual sessions from the history panel
- Pagination (all sessions still shown)
