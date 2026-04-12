import { MSG } from '../shared/constants'
import type { StreamPort } from './ai-client'
import type { ConfirmationPreference, ConfirmResponseType, PageSnapshot, ExecutionMode } from '../shared/types'
import { getAllSettings, setSettings } from './memory-manager'
import type { ParsedAction } from './action-executor'
import { sendConfirmationToTelegram } from './telegram-client'

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
  'invite', 'share', 'reveal', 'unmask', 'show password', 'show secret',
]

// ─── Submit Guard ─────────────────────────────────────────────────────────────
// Actions that irrevocably submit/send/post user content or initiate transactions.
const SUBMIT_GUARD_KEYWORDS = [
  'send', 'post', 'publish', 'tweet', 'reply', 'comment',
  'place order', 'confirm order', 'complete purchase', 'pay now',
  'book now', 'reserve', 'apply now', 'submit application',
  'send message', 'send email', 'transfer', 'confirm payment',
  'save & send', 'save and send', 'post comment', 'submit review',
  'absenden', 'senden', 'veröffentlichen', 'bestellen', 'antworten',
  'abschicken', 'einreichen',
  'invite', 'share link', 'share access', 'add member', 'add friend',
]

// "Next"/"Continue" are safe in multi-step wizards unless it's the final step
const WIZARD_SAFE_KEYWORDS = ['next', 'continue', 'weiter', 'fortfahren', 'nächster']

/**
 * Detect if an action batch contains a "submit guard" action — an irreversible
 * final action (form submit, email send, social post, payment, etc.)
 */
export function isSubmitGuardAction(
  actions: ParsedAction[],
  snapshot?: PageSnapshot,
): boolean {
  for (const action of actions) {
    if (action.action !== 'click') continue

    const selectorText = (action.params.selector ?? '').toLowerCase().trim()
    if (!selectorText) continue

    // Find the matching button in the snapshot for richer metadata
    const matchedButton = snapshot?.buttons.find(b =>
      b.text.toLowerCase().includes(selectorText) ||
      selectorText.includes(b.text.toLowerCase()) ||
      b.selector === action.params.selector
    )

    const buttonText = (matchedButton?.text ?? selectorText).toLowerCase()

    // 1. Check against submit guard keywords
    if (SUBMIT_GUARD_KEYWORDS.some(kw => buttonText.includes(kw))) {
      return true
    }

    // 2. "Save" alone is safe, but "Save & Send" / "Save & Publish" triggers
    if (/save\s*[&+]\s*(send|publish|submit|post)/i.test(buttonText)) {
      return true
    }
    // Plain "save" / "speichern" → safe, don't guard
    if (/^(save|speichern|entwurf speichern|draft)$/i.test(buttonText.trim())) {
      continue
    }

    // 3. Wizard anti-false-positive: "Next"/"Continue" only on final step
    if (WIZARD_SAFE_KEYWORDS.some(kw => buttonText === kw || buttonText.startsWith(kw + ' '))) {
      if (snapshot && snapshot.forms.length > 0) {
        const form = snapshot.forms[0]
        const unfilledRequired = form.fields.filter(f => f.required && (!f.value || !f.value.trim()))
        if (unfilledRequired.length > 0) {
          // Still has unfilled required fields → mid-wizard, safe
          continue
        }
        // All required fields filled + "Next" = likely final step
        return true
      }
      // No form context → don't guard simple navigation
      continue
    }

    // 4. Submit-type button inside a form with filled data
    if (matchedButton?.isSubmitType && snapshot && snapshot.forms.length > 0) {
      const hasFilledData = snapshot.forms.some(f =>
        f.fields.some(field => field.value && field.value.trim() && field.type !== 'hidden')
      )
      if (hasFilledData) return true
    }
  }

  return false
}

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

export async function requestConfirmation(
  port: StreamPort,
  actions: ParsedAction[],
  risk: ActionRisk,
  tabId: number,
  sessionId: string,
  snapshot?: PageSnapshot,
): Promise<boolean> {
  const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const description = buildActionDescription(actions)

  // Extract reasoning and target selector from action params if available
  const reasoning = actions.map(a => a.params.reason || a.params.reasoning).filter(Boolean).join('; ') || undefined
  const targetSelector = actions[0]?.params.selector || undefined

  // Channel 1: Sidepanel (existing)
  port.postMessage({
    type: MSG.CONFIRM_ACTION,
    id,
    description,
    risk,
    actions: actions.map(a => a.action),
    reasoning,
    targetSelector,
  })

  // Channel 2: Telegram (if enabled) — inline keyboard with Approve / Decline
  // Fire-and-forget — response comes through handleConfirmResponse via callback_query
  try {
    const settings = await getAllSettings()
    if (settings.telegramBotEnabled && settings.telegramBotToken?.trim()) {
      sendConfirmationToTelegram(
        settings.telegramBotToken!,
        settings.telegramAllowedChatIds ?? [],
        id,
        description,
        risk,
        snapshot ? {
          title: snapshot.title,
          url: snapshot.url,
          forms: snapshot.forms,
        } : undefined,
      ).catch(() => {})
    }
  } catch { /* Telegram unavailable — sidepanel is the only channel */ }

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

// ─── Mode choice (Auto vs Guided) ────────────────────────────────────────────

interface PendingModeChoice {
  resolve: (mode: 'auto' | 'guided') => void
}

const pendingModeChoices = new Map<string, PendingModeChoice>()

export function requestModeChoice(
  port: StreamPort,
  actions: ParsedAction[],
): Promise<'auto' | 'guided'> {
  const id = `mode_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const description = buildActionDescription(actions)

  port.postMessage({
    type: MSG.MODE_CHOICE,
    id,
    description,
    actions: actions.map(a => a.action),
  })

  return new Promise<'auto' | 'guided'>((resolve) => {
    pendingModeChoices.set(id, { resolve })
    // Default to auto after 2 minutes
    setTimeout(() => {
      if (pendingModeChoices.has(id)) {
        pendingModeChoices.delete(id)
        resolve('auto')
      }
    }, 120_000)
  })
}

export async function handleModeChoiceResponse(
  id: string,
  mode: 'auto' | 'guided',
  remember: boolean
): Promise<void> {
  const pending = pendingModeChoices.get(id)
  if (!pending) return

  pendingModeChoices.delete(id)
  pending.resolve(mode)

  if (remember) {
    await setSettings({ automationPreference: mode })
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

// ─── Execution Mode (V3: FR-V3-8) ───────────────────────────────────────────

/**
 * Determine whether an action should be auto-approved based on the execution mode.
 * Returns true if the action should skip the confirmation dialog.
 */
export function shouldAutoApprove(mode: ExecutionMode, risk: ActionRisk): boolean {
  switch (mode) {
    case 'ask_only':
      return false // never execute anything
    case 'suggest':
      return false // show cards but never execute
    case 'approve':
      return false // always require confirmation (default)
    case 'auto_low_risk':
      return risk === 'read' // only auto-approve read actions; write and destructive still need confirmation
    default:
      return false
  }
}

/**
 * Check if action proposals should be suppressed entirely (ask_only mode).
 */
export function shouldSuppressActions(mode: ExecutionMode): boolean {
  return mode === 'ask_only'
}

/**
 * Check if action execution should be disabled (suggest mode — show cards but no execute).
 */
export function shouldDisableExecution(mode: ExecutionMode): boolean {
  return mode === 'suggest' || mode === 'ask_only'
}
