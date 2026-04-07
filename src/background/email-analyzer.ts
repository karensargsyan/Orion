import { callAI } from './ai-client'
import { addSessionMemory } from './memory-manager'
import type { Settings } from '../shared/types'

interface EmailAnalysis {
  subject: string
  sender: string
  summary: string
  actionItems: string[]
  appointments: Array<{ date: string; time?: string; description: string }>
  sentiment: string
  suggestedReply?: string
}

export async function analyzeEmail(
  emailContent: string,
  pageUrl: string,
  settings: Settings,
  sessionId: string,
  tabId?: number
): Promise<EmailAnalysis | null> {
  if (!emailContent || emailContent.length < 20) return null

  const result = await callAI([
    {
      role: 'system',
      content: `Analyze this email and return a JSON object with:
- "subject": string (email subject or topic)
- "sender": string (who sent it)
- "summary": string (2-3 sentence summary)
- "actionItems": string[] (things the user needs to do)
- "appointments": array of {date, time, description} for any meetings/events mentioned
- "sentiment": string (positive/neutral/negative/urgent)
- "suggestedReply": string (a brief suggested reply if appropriate)

Return ONLY valid JSON.`,
    },
    { role: 'user', content: emailContent.slice(0, 4000) },
  ], settings, 1024)

  try {
    const analysis = JSON.parse(result) as EmailAnalysis
    const domain = extractDomain(pageUrl)

    await addSessionMemory({
      type: 'email_detected',
      url: pageUrl,
      domain,
      content: `Email from ${analysis.sender}: ${analysis.summary}`,
      tags: ['email', `domain:${domain}`, `sentiment:${analysis.sentiment}`],
      timestamp: Date.now(),
      sessionId,
      tabId,
    })

    if (analysis.appointments.length > 0) {
      for (const apt of analysis.appointments) {
        await addSessionMemory({
          type: 'calendar_detected',
          url: pageUrl,
          domain,
          content: `Appointment: ${apt.description} on ${apt.date}${apt.time ? ' at ' + apt.time : ''}`,
          tags: ['calendar', 'appointment', `domain:${domain}`],
          timestamp: Date.now(),
          sessionId,
          tabId,
        })
      }
    }

    return analysis
  } catch {
    return null
  }
}

export async function draftEmailReply(
  emailContent: string,
  instructions: string,
  settings: Settings
): Promise<string> {
  return callAI([
    {
      role: 'system',
      content: 'Draft a reply to the email below. Be professional, concise, and helpful. Only output the reply text.',
    },
    {
      role: 'user',
      content: `Original email:\n${emailContent.slice(0, 3000)}\n\nInstructions: ${instructions || 'Write a professional reply'}`,
    },
  ], settings, 1024)
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}
