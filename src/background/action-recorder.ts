/**
 * Action Recorder — buffers user action events per tab and flushes to IndexedDB.
 */

import type { UserActionEvent } from '../shared/types'
import { addSessionMemory } from './memory-manager'
import { DEFAULTS } from '../shared/constants'

interface TabBuffer {
  tabId: number
  events: UserActionEvent[]
  sessionId: string
  lastFlushMs: number
}

const buffers = new Map<number, TabBuffer>()

function getBuffer(tabId: number, sessionId: string): TabBuffer {
  let buf = buffers.get(tabId)
  if (!buf) {
    buf = { tabId, events: [], sessionId, lastFlushMs: Date.now() }
    buffers.set(tabId, buf)
  }
  return buf
}

export function recordAction(tabId: number, event: UserActionEvent, sessionId: string): void {
  const buf = getBuffer(tabId, sessionId)
  buf.events.push(event)
  // Trim to max buffer size
  if (buf.events.length > DEFAULTS.ACTION_BUFFER_SIZE) {
    buf.events = buf.events.slice(-DEFAULTS.ACTION_BUFFER_SIZE)
  }
}

/** Flush a tab's buffer to IndexedDB. Called periodically and on navigation. */
export async function flushBuffer(tabId: number): Promise<void> {
  const buf = buffers.get(tabId)
  if (!buf || buf.events.length === 0) return

  const events = [...buf.events]
  buf.events = []
  buf.lastFlushMs = Date.now()

  if (events.length === 0) return

  const domain = extractDomain(events[0].url)

  // Group into a single session memory entry
  const summary = summarizeActions(events)
  await addSessionMemory({
    type: 'action',
    url: events[events.length - 1].url,
    domain,
    content: summary,
    tags: deriveTagsFromActions(events),
    timestamp: Date.now(),
    sessionId: buf.sessionId,
    tabId,
  })
}

/** Flush all tab buffers (called on alarm). */
export async function flushAllBuffers(): Promise<void> {
  const tabIds = [...buffers.keys()]
  await Promise.all(tabIds.map(id => flushBuffer(id)))
}

export function clearTabBuffer(tabId: number): void {
  buffers.delete(tabId)
}

/** Returns a human-readable summary of a batch of actions. */
function summarizeActions(events: UserActionEvent[]): string {
  const counts: Record<string, number> = {}
  const urls = new Set<string>()
  const formSubmits: string[] = []
  const clicks: string[] = []

  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1
    urls.add(e.url)
    if (e.type === 'submit') formSubmits.push(e.url)
    if (e.type === 'click' && e.text) clicks.push(e.text)
  }

  const parts: string[] = []
  if (counts.navigate) parts.push(`Navigated to ${counts.navigate} page(s)`)
  if (counts.click) parts.push(`Clicked: ${clicks.slice(0, 3).join(', ')}${clicks.length > 3 ? '…' : ''}`)
  if (counts.input) parts.push(`Typed in ${counts.input} field(s)`)
  if (counts.submit) parts.push(`Submitted form(s) on: ${formSubmits.slice(0, 2).join(', ')}`)

  return parts.join('. ') || `${events.length} user interactions`
}

function deriveTagsFromActions(events: UserActionEvent[]): string[] {
  const tags = new Set<string>()
  for (const e of events) {
    if (e.type === 'submit') tags.add('form-submit')
    if (e.type === 'navigate') tags.add('navigation')
    if (e.type === 'input') tags.add('typing')
    const domain = extractDomain(e.url)
    if (domain) tags.add(`domain:${domain}`)
  }
  return [...tags]
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Get recent events for a tab (for AI context). */
export function getRecentEvents(tabId: number, limit = 20): UserActionEvent[] {
  const buf = buffers.get(tabId)
  return buf ? buf.events.slice(-limit) : []
}
