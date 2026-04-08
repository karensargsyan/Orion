/**
 * Periodically sends aggregated user-action summaries to the local model to
 * distill habits and store lightweight insights (learning loop).
 */

import { callAI } from './ai-client'
import { getRecentSessionMemory, addGlobalMemory } from './memory-manager'
import type { Settings } from '../shared/types'

export async function runAIActionLearningCycle(settings: Settings): Promise<void> {
  if (!settings.monitoringEnabled || settings.aiActionLearningEnabled === false) return
  const base = settings.apiCapabilities?.baseUrl || settings.lmStudioUrl
  if (!base?.trim()) return

  const recent = await getRecentSessionMemory(120)
  const actionLines = recent.filter(m => m.type === 'action').map(m => m.content)
  if (actionLines.length < 2) return

  const blob = actionLines.slice(-40).join('\n').slice(0, 12_000)

  const insight = await callAI(
    [
      {
        role: 'system',
        content:
          'You analyze browser interaction summaries (clicks, typing, pointer movement, scrolling, navigation). Infer how the user explores UIs and completes tasks. Output 2-6 short bullet lines: habits, frequent regions or flows, and workflow hints. Plain text bullets only. No JSON, no preamble.',
      },
      { role: 'user', content: `Recent action summaries:\n${blob}` },
    ],
    settings,
    400
  )

  if (insight.length < 25) return

  await addGlobalMemory({
    domain: 'ai_action_insights',
    summary: insight.slice(0, 2000),
    tags: ['ai-learning', 'action-analysis'],
    importance: 0.45,
    timestamp: Date.now(),
    sourceCount: 1,
  })
}
