import { MSG } from '../shared/constants'
import type { StreamPort } from './ai-client'
import type { ConfirmationPreference, ConfirmResponseType } from '../shared/types'
import { getAllSettings, setSettings } from './memory-manager'
import type { ParsedAction } from './action-executor'

const WRITE_ACTIONS = new Set([
  'click', 'type', 'check', 'clear', 'select_option',
  'keypress', 'navigate', 'doubleclick', 'fill_form',
])

const READ_ACTIONS = new Set([
  'read', 'screenshot', 'get_page_state', 'scroll', 'hover',
  'read_options', 'wait', 'focus', 'scroll_to', 'search',
  'open_tab', 'read_tab', 'back', 'forward', 'select_text',
  'batch_read', 'analyze_file',
])

const DESTRUCTIVE_KEYWORDS = [
  'delete', 'remove', 'cancel', 'unsubscribe', 'pay',
  'submit', 'purchase', 'buy', 'checkout', 'confirm order',
  'place order', 'send payment', 'close account', 'deactivate',
]

export type ActionRisk = 'read' | 'write' | 'destructive'

interface PendingEntry {
  resolve: (accepted: boolean) => void
}

const pendingConfirmations = new Map<string, PendingEntry>()

export function classifyActionRisk(actions: ParsedAction[]): ActionRisk {
  let maxRisk: ActionRisk = 'read'

  for (const a of actions) {
    if (READ_ACTIONS.has(a.action)) continue

    if (WRITE_ACTIONS.has(a.action)) {
      if (maxRisk === 'read') maxRisk = 'write'
    }

    const selectorLower = (a.params.selector ?? a.params.value ?? '').toLowerCase()
    if (DESTRUCTIVE_KEYWORDS.some(kw => selectorLower.includes(kw))) {
      return 'destructive'
    }
  }

  return maxRisk
}

export function buildActionDescription(actions: ParsedAction[]): string {
  return actions.map(a => {
    const target = a.params.selector ?? a.params.value ?? a.params.url ?? ''
    return `**${a.action}** ${target}`.trim()
  }).join(', ')
}

export async function needsConfirmation(
  risk: ActionRisk,
  actions: ParsedAction[],
  domain: string
): Promise<boolean> {
  if (risk === 'read') return false

  const settings = await getAllSettings()
  if (settings.globalAutoAccept) return false

  const actionTypes = [...new Set(actions.map(a => a.action))]
  for (const actionType of actionTypes) {
    const pref = findPreference(settings.confirmationPreferences, actionType, domain)
    if (pref?.level === 'auto_accept') return false
  }

  return true
}

function findPreference(
  prefs: ConfirmationPreference[],
  actionType: string,
  domain: string
): ConfirmationPreference | undefined {
  const domainPref = prefs.find(p => p.actionType === actionType && p.domain === domain)
  if (domainPref) return domainPref
  return prefs.find(p => p.actionType === actionType && !p.domain)
}

export function requestConfirmation(
  port: StreamPort,
  actions: ParsedAction[],
  risk: ActionRisk,
  tabId: number,
  sessionId: string
): Promise<boolean> {
  const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const description = buildActionDescription(actions)

  port.postMessage({
    type: MSG.CONFIRM_ACTION,
    id,
    description,
    risk,
    actions: actions.map(a => a.action),
  })

  return new Promise<boolean>((resolve) => {
    pendingConfirmations.set(id, { resolve })
    setTimeout(() => {
      if (pendingConfirmations.has(id)) {
        pendingConfirmations.delete(id)
        resolve(false)
      }
    }, 120_000)
  })
}

export async function handleConfirmResponse(
  id: string,
  preference: ConfirmResponseType,
  actionTypes: string[],
  domain: string
): Promise<void> {
  const pending = pendingConfirmations.get(id)
  if (!pending) return

  pendingConfirmations.delete(id)

  if (preference === 'decline') {
    pending.resolve(false)
    return
  }

  pending.resolve(true)

  if (preference === 'always_this') {
    await saveActionPreferences(actionTypes, domain)
  } else if (preference === 'always_all') {
    await setSettings({ globalAutoAccept: true })
  }
}

async function saveActionPreferences(
  actionTypes: string[],
  domain: string
): Promise<void> {
  const settings = await getAllSettings()
  const prefs = [...settings.confirmationPreferences]
  const now = Date.now()

  for (const actionType of actionTypes) {
    const idx = prefs.findIndex(p => p.actionType === actionType && p.domain === domain)
    const entry: ConfirmationPreference = {
      actionType,
      domain,
      level: 'auto_accept',
      updatedAt: now,
    }
    if (idx >= 0) {
      prefs[idx] = entry
    } else {
      prefs.push(entry)
    }
  }

  await setSettings({ confirmationPreferences: prefs })
}
