import type { LearningSession, LearningSnapshot, Settings } from '../shared/types'
import { callAI } from './ai-client'
import { addSessionMemory } from './memory-manager'
import { recordDomainKnowledge, recordLesson } from './mempalace-learner'
import { mempalaceEnabled } from './mempalace-client'
import { STORE } from '../shared/constants'
import { dbPut } from '../shared/idb'

export async function analyzeLearningSession(
  session: LearningSession,
  settings: Settings
): Promise<string> {
  if (session.snapshots.length < 2) {
    return 'Not enough snapshots to analyze (need at least 2).'
  }

  const trajectory = buildTrajectory(session)
  const prompt = buildAnalysisPrompt(trajectory, session)

  let analysis: string
  try {
    analysis = await callAI(prompt, settings, 2048)
  } catch (err) {
    return `Analysis failed: ${String(err)}`
  }

  if (!analysis || analysis.length < 20) {
    return 'AI returned insufficient analysis.'
  }

  session.analysis = analysis
  await dbPut<LearningSession>(STORE.LEARNING_SESSIONS, session)

  await storeAsMemory(session, analysis, settings)

  return analysis
}

function buildTrajectory(session: LearningSession): string {
  const lines: string[] = []
  const startTime = session.startedAt

  for (let i = 0; i < session.snapshots.length; i++) {
    const snap = session.snapshots[i]
    const elapsed = Math.round((snap.timestamp - startTime) / 1000)
    lines.push(`--- Snapshot ${i + 1} at +${elapsed}s ---`)
    lines.push(`URL: ${snap.url}`)
    lines.push(`Title: ${snap.pageTitle}`)

    if (snap.recentActions.length > 0) {
      lines.push('User actions:')
      for (const a of snap.recentActions.slice(-10)) {
        const detail = a.text ? ` "${a.text.slice(0, 40)}"` : ''
        const extra = a.detail ? ` (${a.detail})` : ''
        lines.push(`  ${a.type}: ${a.selector.slice(0, 60)}${detail}${extra}`)
      }
    }

    if (snap.accessibilityTree) {
      const treeLines = snap.accessibilityTree.split('\n').slice(0, 20)
      lines.push(`Interactive elements (${treeLines.length} shown):`)
      lines.push(treeLines.join('\n'))
    }

    if (i < session.snapshots.length - 1) {
      const pageChanged = snap.url !== session.snapshots[i + 1].url
      const titleChanged = snap.pageTitle !== session.snapshots[i + 1].pageTitle
      if (pageChanged) lines.push('>> PAGE NAVIGATED')
      else if (titleChanged) lines.push('>> PAGE CONTENT CHANGED')
    }

    lines.push('')
  }

  return lines.join('\n').slice(0, 12000)
}

function buildAnalysisPrompt(
  trajectory: string,
  session: LearningSession
): Array<{ role: 'system' | 'user'; content: string }> {
  const duration = session.endedAt
    ? Math.round((session.endedAt - session.startedAt) / 1000)
    : 0

  return [
    {
      role: 'system',
      content: `You are a browser behavior analyst. You observe user interaction trajectories — sequences of actions, page states, and navigation — and extract reusable knowledge.

Your job: analyze the trajectory below and produce a structured learning report with:

1. WORKFLOW SUMMARY: What was the user trying to accomplish? (1-2 sentences)
2. STEP-BY-STEP PROCEDURE: The exact sequence of steps the user took, as an ordered list. Be specific about which elements were clicked, what text was entered, which pages were visited.
3. KEY PATTERNS: Recurring behaviors, preferred navigation paths, element interaction preferences.
4. DOMAIN KNOWLEDGE: Facts about how this website/app works — its structure, navigation patterns, where features are located, how toggles/buttons behave.
5. REUSABLE PLAYBOOK: A concise set of instructions that an AI agent could follow to replicate this workflow. Use specific selectors and element names from the trajectory.

Be concrete and specific. Reference actual element names, URLs, and page titles from the trajectory. This analysis will be stored as permanent knowledge.`,
    },
    {
      role: 'user',
      content: `Learning session on "${session.domain}" (${duration}s, ${session.snapshots.length} snapshots):

${trajectory}

Analyze this interaction and produce the structured learning report.`,
    },
  ]
}

async function storeAsMemory(
  session: LearningSession,
  analysis: string,
  settings: Settings
): Promise<void> {
  await addSessionMemory({
    type: 'learning_snapshot',
    url: session.snapshots[0]?.url ?? '',
    domain: session.domain,
    content: `Learning session analysis (${session.snapshots.length} snapshots, ${formatDuration(session)}):\n${analysis.slice(0, 3000)}`,
    tags: ['learning-mode', `domain:${session.domain}`, 'trajectory-analysis'],
    timestamp: Date.now(),
    sessionId: session.id,
    tabId: session.tabId,
  })

  if (mempalaceEnabled(settings)) {
    await recordDomainKnowledge(
      settings,
      session.domain,
      `[Learning Mode] ${analysis.slice(0, 2000)}`
    ).catch(() => {})

    const playbookMatch = analysis.match(/REUSABLE PLAYBOOK[:\s]*([\s\S]*?)(?=\n\n|\n[A-Z]|$)/i)
    if (playbookMatch?.[1]?.trim()) {
      await recordLesson(
        settings,
        `Playbook for ${session.domain}: ${playbookMatch[1].trim().slice(0, 1500)}`,
        { source: 'learning-mode', domain: session.domain }
      ).catch(() => {})
    }
  }
}

function formatDuration(session: LearningSession): string {
  const ms = (session.endedAt ?? Date.now()) - session.startedAt
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}
