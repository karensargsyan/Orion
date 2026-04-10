export interface ChoiceWidget {
  kind: 'choice'
  id: string
  options: string[]
}

export interface ConfirmWidget {
  kind: 'confirm'
  id: string
  label: string
}

export interface ActionConfirmWidget {
  kind: 'action_confirm'
  id: string
  description: string
  risk: 'read' | 'write' | 'destructive'
  actions: string[]
}

export type Widget = ChoiceWidget | ConfirmWidget | ActionConfirmWidget

const CHOICE_RE = /\[CHOICE:id=&quot;([^&]*)&quot;\]\s*(.*?)\s*\[\/CHOICE\]/g
const CONFIRM_RE = /\[CONFIRM:id=&quot;([^&]*)&quot;\]\s*(.*?)\s*\[\/CONFIRM\]/g
const ACTION_RESULT_RE = /\[ACTION_RESULT\s+status=&quot;(success|error)&quot;\s+action=&quot;([^&]*)&quot;\]\s*(.*?)\s*\[\/ACTION_RESULT\]/g

const CHOICE_RAW_RE = /\[CHOICE:id="([^"]*)"\]\s*(.*?)\s*\[\/CHOICE\]/g
const CONFIRM_RAW_RE = /\[CONFIRM:id="([^"]*)"\]\s*(.*?)\s*\[\/CONFIRM\]/g
const ACTION_RESULT_RAW_RE = /\[ACTION_RESULT\s+status="(success|error)"\s+action="([^"]*)"\]\s*(.*?)\s*\[\/ACTION_RESULT\]/g

export function parseWidgets(html: string): { html: string; widgets: Widget[] } {
  const widgets: Widget[] = []

  html = replaceWithRegex(html, CHOICE_RE, widgets) 
  html = replaceWithRegex(html, CHOICE_RAW_RE, widgets)
  html = replaceConfirm(html, CONFIRM_RE, widgets)
  html = replaceConfirm(html, CONFIRM_RAW_RE, widgets)

  return { html, widgets }
}

function replaceWithRegex(html: string, re: RegExp, widgets: Widget[]): string {
  re.lastIndex = 0
  return html.replace(re, (_match, id: string, optionsStr: string) => {
    const options = optionsStr.split('|').map((o: string) => o.trim()).filter(Boolean)
    widgets.push({ kind: 'choice', id, options })
    return `<div class="choice-card" data-widget-id="${id}"></div>`
  })
}

function replaceConfirm(html: string, re: RegExp, widgets: Widget[]): string {
  re.lastIndex = 0
  return html.replace(re, (_match, id: string, label: string) => {
    widgets.push({ kind: 'confirm', id, label: label.trim() })
    return `<div class="confirm-card" data-widget-id="${id}"></div>`
  })
}

export function parseActionResults(html: string): string {
  html = stripActionResultBlocks(html, ACTION_RESULT_RE)
  html = stripActionResultBlocks(html, ACTION_RESULT_RAW_RE)
  return html
}

function stripActionResultBlocks(html: string, re: RegExp): string {
  re.lastIndex = 0
  return html.replace(re, '')
}

export function renderWidgetsInContainer(container: HTMLElement, widgets: Widget[]): void {
  for (const w of widgets) {
    const slot = container.querySelector(`[data-widget-id="${w.id}"]`) as HTMLElement | null
    if (!slot) continue

    if (w.kind === 'choice') {
      renderChoiceCard(slot, w)
    } else if (w.kind === 'action_confirm') {
      renderActionConfirmCard(slot, w)
    } else {
      renderConfirmCard(slot, w)
    }
  }
}

function renderChoiceCard(slot: HTMLElement, widget: ChoiceWidget): void {
  slot.innerHTML = ''
  for (const option of widget.options) {
    const btn = document.createElement('button')
    btn.className = 'choice-option chip'
    btn.textContent = option
    btn.dataset.widgetId = widget.id
    btn.dataset.value = option
    slot.appendChild(btn)
  }
}

function renderConfirmCard(slot: HTMLElement, widget: ConfirmWidget): void {
  slot.innerHTML = ''
  const btn = document.createElement('button')
  btn.className = 'btn-primary confirm-btn'
  btn.textContent = widget.label
  btn.dataset.widgetId = widget.id
  btn.dataset.value = widget.label
  slot.appendChild(btn)
}

export function renderActionConfirmCard(slot: HTMLElement, widget: ActionConfirmWidget): void {
  const riskClass = `risk-${widget.risk}`
  const riskLabel = widget.risk === 'destructive' ? 'High Risk' : widget.risk === 'write' ? 'Write Action' : 'Action'
  slot.className = `confirm-action-card ${riskClass}`
  slot.innerHTML = `
    <div class="confirm-action-header">
      <span class="confirm-action-risk">${riskLabel}</span>
      <span class="confirm-action-title">The assistant wants to:</span>
    </div>
    <div class="confirm-action-desc">${widget.description}</div>
    <div class="confirm-action-options">
      <button class="confirm-action-btn confirm-accept" data-confirm-id="${widget.id}" data-preference="once">Accept</button>
      <button class="confirm-action-btn confirm-always" data-confirm-id="${widget.id}" data-preference="always_this">Accept &amp; Don't Ask Again</button>
      <button class="confirm-action-btn confirm-all" data-confirm-id="${widget.id}" data-preference="always_all">Accept All (never ask)</button>
      <button class="confirm-action-btn confirm-decline" data-confirm-id="${widget.id}" data-preference="decline">Decline</button>
    </div>
  `
}

export function createActionConfirmElement(
  id: string,
  description: string,
  risk: string,
  actions: string[]
): HTMLElement {
  const div = document.createElement('div')
  div.dataset.widgetId = id
  const widget: ActionConfirmWidget = { kind: 'action_confirm', id, description, risk: risk as ActionConfirmWidget['risk'], actions }
  renderActionConfirmCard(div, widget)
  return div
}

export function createModeChoiceElement(
  id: string,
  description: string,
): HTMLElement {
  const div = document.createElement('div')
  div.className = 'mode-choice-card'
  div.dataset.modeChoiceId = id
  div.innerHTML = `
    <div class="mode-choice-header">How should I handle this?</div>
    <div class="mode-choice-desc">${description}</div>
    <div class="mode-choice-buttons">
      <button class="mode-choice-btn mode-choice-guide" data-mode-id="${id}" data-mode="guided">
        <span class="mode-choice-icon">🎯</span>
        <span class="mode-choice-label">Guide me</span>
        <span class="mode-choice-hint">Highlight what to click</span>
      </button>
      <button class="mode-choice-btn mode-choice-auto" data-mode-id="${id}" data-mode="auto">
        <span class="mode-choice-icon">⚡</span>
        <span class="mode-choice-label">Do for me</span>
        <span class="mode-choice-hint">Auto-click everything</span>
      </button>
    </div>
    <label class="mode-choice-remember">
      <input type="checkbox" class="mode-choice-remember-check" data-mode-id="${id}">
      <span>Remember my choice</span>
    </label>
  `
  return div
}

export function attachWidgetHandlers(
  container: HTMLElement,
  onChoice: (widgetId: string, value: string) => void,
  onConfirmAction?: (confirmId: string, preference: string, container: HTMLElement) => void,
  onModeChoice?: (modeId: string, mode: 'auto' | 'guided', remember: boolean) => void
): void {
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

    if (target.classList.contains('choice-option')) {
      const siblings = target.parentElement?.querySelectorAll('.choice-option')
      siblings?.forEach(s => s.classList.remove('selected'))
      target.classList.add('selected')
      onChoice(target.dataset.widgetId!, target.dataset.value!)
      return
    }

    if (target.classList.contains('confirm-btn')) {
      target.classList.add('confirmed')
      target.textContent = 'Confirmed'
      ;(target as HTMLButtonElement).disabled = true
      onChoice(target.dataset.widgetId!, target.dataset.value!)
      return
    }

    if (target.classList.contains('confirm-action-btn')) {
      const confirmId = target.dataset.confirmId!
      const preference = target.dataset.preference!
      const card = target.closest('.confirm-action-card') as HTMLElement
      if (card) {
        const btns = card.querySelectorAll<HTMLButtonElement>('.confirm-action-btn')
        btns.forEach(b => { b.disabled = true })
        if (preference === 'decline') {
          card.classList.add('confirm-declined')
        } else {
          card.classList.add('confirm-accepted')
        }
      }
      onConfirmAction?.(confirmId, preference, container)
    }

    if (target.classList.contains('mode-choice-btn') || target.closest('.mode-choice-btn')) {
      const btn = target.closest('.mode-choice-btn') as HTMLElement
      if (!btn) return
      const modeId = btn.dataset.modeId!
      const mode = btn.dataset.mode as 'auto' | 'guided'
      const card = btn.closest('.mode-choice-card') as HTMLElement
      if (card) {
        const allBtns = card.querySelectorAll<HTMLButtonElement>('.mode-choice-btn')
        allBtns.forEach(b => { b.disabled = true })
        btn.classList.add('mode-choice-selected')
        card.classList.add('mode-choice-done')
      }
      const rememberCheck = card?.querySelector<HTMLInputElement>(`.mode-choice-remember-check[data-mode-id="${modeId}"]`)
      const remember = rememberCheck?.checked ?? false
      onModeChoice?.(modeId, mode, remember)
    }
  })
}
