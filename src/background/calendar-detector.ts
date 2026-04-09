import { callAI } from './ai-client'
import { dbPut, dbGetAll } from '../shared/idb'
import { STORE } from '../shared/constants'
import { addSessionMemory } from './memory-manager'
import type { Settings, DetectedCalendarEvent } from '../shared/types'

export async function detectCalendarEvents(
  pageContent: string,
  pageUrl: string,
  settings: Settings,
  sessionId: string,
  tabId?: number
): Promise<DetectedCalendarEvent[]> {
  if (!settings.calendarDetectionEnabled) return []
  if (!pageContent || pageContent.length < 30) return []

  const result = await callAI([
    {
      role: 'system',
      content: `Analyze the text for any dates, appointments, meetings, or scheduled events. Return a JSON array of objects with:
- "title": string
- "date": string (ISO date YYYY-MM-DD)
- "time": string (HH:MM, optional)
- "endTime": string (HH:MM, optional)
- "location": string (optional)
- "description": string
- "confidence": number (0-1)

If no events found, return []. Return ONLY valid JSON.`,
    },
    { role: 'user', content: pageContent.slice(0, 3000) },
  ], settings, 512)

  try {
    const events = JSON.parse(result) as DetectedCalendarEvent[]
    if (!Array.isArray(events)) return []

    const validEvents: DetectedCalendarEvent[] = []
    for (const event of events) {
      if (!event.title || !event.date) continue
      const calEvent: DetectedCalendarEvent = {
        ...event,
        source: pageUrl,
        detectedAt: Date.now(),
      }
      await dbPut(STORE.CALENDAR_EVENTS, calEvent)
      validEvents.push(calEvent)

      await addSessionMemory({
        type: 'calendar_detected',
        url: pageUrl,
        domain: extractDomain(pageUrl),
        content: `Event: ${event.title} on ${event.date}${event.time ? ' at ' + event.time : ''}`,
        tags: ['calendar', 'event'],
        timestamp: Date.now(),
        sessionId,
        tabId,
      })
    }

    return validEvents
  } catch {
    return []
  }
}

export async function getAllCalendarEvents(): Promise<DetectedCalendarEvent[]> {
  return dbGetAll<DetectedCalendarEvent>(STORE.CALENDAR_EVENTS)
}

export function generateICSContent(event: DetectedCalendarEvent): string {
  const dtStart = formatICSDate(event.date, event.time)
  const dtEnd = event.endTime
    ? formatICSDate(event.date, event.endTime)
    : formatICSDate(event.date, event.time, 60)

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Orion//EN',
    'BEGIN:VEVENT',
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escICS(event.title)}`,
    event.description ? `DESCRIPTION:${escICS(event.description)}` : '',
    event.location ? `LOCATION:${escICS(event.location)}` : '',
    `UID:${Date.now()}@orion`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
}

export function generateGoogleCalendarUrl(event: DetectedCalendarEvent): string {
  const start = (event.date + (event.time ? 'T' + event.time.replace(':', '') + '00' : '')).replace(/[-:]/g, '')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${start}/${start}`,
    details: event.description ?? '',
    location: event.location ?? '',
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function formatICSDate(date: string, time?: string, addMinutes = 0): string {
  const d = new Date(date + (time ? `T${time}:00` : 'T00:00:00'))
  if (addMinutes) d.setMinutes(d.getMinutes() + addMinutes)
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function escICS(s: string): string {
  return s.replace(/[,;\\]/g, c => `\\${c}`).replace(/\n/g, '\\n')
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}
