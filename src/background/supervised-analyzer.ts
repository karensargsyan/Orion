import type { SupervisedInteraction, SupervisedSession, LearnedPlaybook, Settings } from '../shared/types'
import { callAI } from './ai-client'
import { savePlaybook } from './memory-manager'
import { mempalaceEnabled } from './mempalace-client'
import { recordLesson, recordDomainKnowledge } from './mempalace-learner'

export async function analyzeSupervisedInteraction(
  interaction: SupervisedInteraction,
  session: SupervisedSession,
  settings: Settings
): Promise<LearnedPlaybook | null> {
  if (interaction.snapshots.length < 1 && interaction.actions.length < 1) {
    return null
  }

  const trajectory = buildInteractionTrajectory(interaction)
  const prompt = buildPlaybookPrompt(interaction.command, trajectory, session.domain)

  let rawAnalysis: string
  try {
    rawAnalysis = await callAI(prompt, settings, 4096)
  } catch (err) {
    console.warn('[SupervisedAnalyzer] AI analysis failed:', err)
    return null
  }

  const playbook = parsePlaybookFromAnalysis(rawAnalysis, interaction, session)
  if (!playbook) return null

  await savePlaybook(playbook)

  if (mempalaceEnabled(settings)) {
    await storeToPalace(playbook, rawAnalysis, session, settings)
  }

  return playbook
}

export async function analyzeFullSupervisedSession(
  session: SupervisedSession,
  settings: Settings
): Promise<string> {
  const results: string[] = []

  for (const interaction of session.interactions) {
    const playbook = await analyzeSupervisedInteraction(interaction, session, settings)
    if (playbook) {
      results.push(`Learned: "${interaction.command}" → ${playbook.steps.length} steps (${playbook.triggers.join(', ')})`)
    }
  }

  const summary = results.length > 0
    ? [
        `Saved ${results.length} new playbook(s) from ${session.interactions.length} demonstration(s) on ${session.domain}.`,
        '',
        'Each line is one learned task the assistant can try to reuse later:',
        '',
        ...results,
      ].join('\n')
    : [
        `Reviewed ${session.interactions.length} demonstration(s) on ${session.domain}.`,
        'No new playbooks were generated (not enough captured actions or the model could not extract steps).',
        'Try again with clearer voice commands and more visible clicks/navigation before saying “done”.',
      ].join('\n')

  session.analysis = summary
  return summary
}

// ─── Trajectory Building ─────────────────────────────────────────────────────

function buildInteractionTrajectory(interaction: SupervisedInteraction): string {
  const lines: string[] = []
  const startTime = interaction.startedAt

  if (interaction.actions.length > 0) {
    lines.push('User actions during this interaction:')
    for (const a of interaction.actions.slice(0, 50)) {
      const elapsed = Math.round((a.timestamp - startTime) / 1000)
      const detail = a.text ? ` "${a.text.slice(0, 40)}"` : ''
      const extra = a.detail ? ` (${a.detail})` : ''
      lines.push(`  +${elapsed}s ${a.type}: ${a.selector.slice(0, 60)}${detail}${extra}`)
    }
  }

  for (let i = 0; i < interaction.snapshots.length; i++) {
    const snap = interaction.snapshots[i]
    const elapsed = Math.round((snap.timestamp - startTime) / 1000)
    lines.push(`\n--- Snapshot ${i + 1} at +${elapsed}s ---`)
    lines.push(`URL: ${snap.url}`)
    lines.push(`Title: ${snap.pageTitle}`)

    if (snap.accessibilityTree) {
      const treeLines = snap.accessibilityTree.split('\n').slice(0, 15)
      lines.push(`Interactive elements:\n${treeLines.join('\n')}`)
    }

    if (i < interaction.snapshots.length - 1) {
      const next = interaction.snapshots[i + 1]
      if (snap.url !== next.url) lines.push('>> PAGE NAVIGATED')
    }
  }

  return lines.join('\n').slice(0, 10000)
}

// ─── Prompt Construction ─────────────────────────────────────────────────────

function buildPlaybookPrompt(
  command: string,
  trajectory: string,
  domain: string
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: `You are a browser automation learning system. A user has demonstrated how to perform a task on a website by narrating their intent and then executing it manually. Your job is to analyze the demonstrated interaction and produce a structured playbook that an AI agent can follow to replicate the task automatically.

You MUST respond with a JSON object (and nothing else) in this exact format:
{
  "triggers": ["phrase 1", "phrase 2", "phrase 3"],
  "steps": ["step 1 description", "step 2 description"],
  "selectors": ["selector1", "selector2"],
  "domain": "${domain}",
  "confidence": 0.8
}

Rules:
- "triggers" should contain 3-5 natural language phrases that a user might say or type to invoke this task. Include variations in wording.
- "steps" should be the ordered sequence of browser actions needed (click, type, navigate, scroll, etc.) with specific element references.
- "selectors" should list the CSS selectors or element identifiers used.
- "confidence" should be between 0.0 and 1.0, reflecting how reliable this playbook is based on the demonstrated data.
- Be specific about which elements to interact with. Use actual selectors, aria-labels, or text content from the trajectory.`,
    },
    {
      role: 'user',
      content: `The user said: "${command}"

Then performed these actions on ${domain}:

${trajectory}

Analyze this interaction and produce the playbook JSON.`,
    },
  ]
}

// ─── Playbook Parsing ────────────────────────────────────────────────────────

function parsePlaybookFromAnalysis(
  raw: string,
  interaction: SupervisedInteraction,
  session: SupervisedSession
): LearnedPlaybook | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      triggers?: string[]
      steps?: string[]
      selectors?: string[]
      domain?: string
      confidence?: number
    }

    if (!parsed.triggers?.length || !parsed.steps?.length) return null

    return {
      id: `playbook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      triggers: parsed.triggers,
      steps: parsed.steps,
      selectors: parsed.selectors ?? [],
      domain: parsed.domain ?? session.domain,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      successCount: 0,
      failureCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  } catch {
    return null
  }
}

// ─── MemPalace Integration ───────────────────────────────────────────────────

async function storeToPalace(
  playbook: LearnedPlaybook,
  rawAnalysis: string,
  session: SupervisedSession,
  settings: Settings
): Promise<void> {
  const description = `Supervised playbook for "${playbook.triggers[0]}" on ${playbook.domain}: ${playbook.steps.join(' → ')}`

  await recordDomainKnowledge(settings, session.domain, description).catch(() => {})
  await recordLesson(settings, description, {
    source: 'supervised-learning',
    domain: session.domain,
  }).catch(() => {})
}
