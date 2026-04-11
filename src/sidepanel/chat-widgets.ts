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

// ─── Form Assist Card ─────────────────────────────────────────────────────────

import type { FormAssistField } from '../shared/types'

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const LONG_FIELD_RE = /justification|description|reason|explain|why|purpose|detail|comment|note|message|summary/i

function isLongField(label: string, value: string): boolean {
  return LONG_FIELD_RE.test(label) || value.length > 80
}

function confidenceBadge(conf: FormAssistField['confidence'], hint: string): string {
  const cls = `confidence-badge confidence-${conf}`
  const label = conf === 'high' ? 'vault' : conf === 'medium' ? 'suggested' : 'needs input'
  return `<span class="${cls}" title="${escapeAttr(hint)}">${label}</span>`
}

export function createFormAssistElement(
  id: string,
  fields: FormAssistField[],
  formTitle: string
): HTMLElement {
  const div = document.createElement('div')
  div.className = 'form-assist-card'
  div.dataset.assistId = id

  const vaultCount = fields.filter(f => f.confidence === 'high').length
  const aiCount = fields.filter(f => f.confidence === 'medium').length

  let subtitle = `${fields.length} field${fields.length !== 1 ? 's' : ''} found`
  if (vaultCount > 0) subtitle += ` · ${vaultCount} from vault`
  if (aiCount > 0) subtitle += ` · ${aiCount} AI suggested`

  const fieldsHtml = fields.map(f => {
    const reqStar = f.required ? '<span class="required-star">*</span>' : ''
    const badge = confidenceBadge(f.confidence, f.hint)

    let inputHtml: string
    if (f.inputType === 'select' && f.options?.length) {
      const opts = f.options.map(o => {
        const sel = o === f.value ? ' selected' : ''
        return `<option value="${escapeAttr(o)}"${sel}>${escapeHtml(o)}</option>`
      }).join('')
      inputHtml = `<select class="form-assist-value" data-field-id="${f.fieldId}"><option value="">-- Select --</option>${opts}</select>`
    } else if (f.inputType === 'checkbox') {
      const checked = f.value === 'true' || f.value === '1' || f.value === 'yes' ? ' checked' : ''
      inputHtml = `<label class="form-assist-checkbox"><input type="checkbox" class="form-assist-value" data-field-id="${f.fieldId}"${checked}> ${escapeHtml(f.label)}</label>`
    } else if (isLongField(f.label, f.value)) {
      inputHtml = `<textarea class="form-assist-value" data-field-id="${f.fieldId}" rows="3" placeholder="${escapeAttr(f.hint)}">${escapeHtml(f.value)}</textarea>`
    } else {
      const type = f.inputType === 'email' ? 'email' : f.inputType === 'tel' ? 'tel' : f.inputType === 'date' ? 'date' : 'text'
      inputHtml = `<input class="form-assist-value" type="${type}" data-field-id="${f.fieldId}" value="${escapeAttr(f.value)}" placeholder="${escapeAttr(f.hint)}">`
    }

    return `
      <div class="form-assist-field" data-field-id="${f.fieldId}">
        <div class="form-assist-field-header">
          <label class="form-assist-label">${escapeHtml(f.label)} ${reqStar}</label>
          ${badge}
        </div>
        ${inputHtml}
        <div class="form-assist-field-actions">
          <button class="btn-small btn-copy-field" data-field-id="${f.fieldId}" title="Copy to clipboard">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy
          </button>
          <button class="btn-small btn-fill-field" data-field-id="${f.fieldId}" data-selector="${escapeAttr(f.selector)}" data-input-type="${escapeAttr(f.inputType)}" title="Fill this field on the page">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Fill
          </button>
        </div>
      </div>`
  }).join('')

  div.innerHTML = `
    <div class="form-assist-header">
      <div class="form-assist-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
      </div>
      <div>
        <div class="form-assist-title">Form Assistant</div>
        <div class="form-assist-subtitle">${escapeHtml(subtitle)}</div>
      </div>
    </div>
    <div class="form-assist-fields">${fieldsHtml}</div>
    <div class="form-assist-footer">
      <button class="btn-primary btn-fill-all" data-assist-id="${id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        Fill All
      </button>
      <button class="btn-small btn-copy-all" data-assist-id="${id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        Copy All
      </button>
    </div>
  `
  return div
}

function getFieldValue(card: HTMLElement, fieldId: string): string {
  const el = card.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`.form-assist-value[data-field-id="${fieldId}"]`)
  if (!el) return ''
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked ? 'true' : 'false'
  return el.value
}

function flashButton(btn: HTMLElement, cls: string, text: string, duration = 1500): void {
  const origText = btn.innerHTML
  btn.classList.add(cls)
  btn.innerHTML = text
  setTimeout(() => { btn.classList.remove(cls); btn.innerHTML = origText }, duration)
}

export interface FormAssistCallbacks {
  onFillField: (selector: string, value: string, inputType: string) => Promise<boolean>
  onCopyField: (value: string) => void
  onCopyAll: (text: string) => void
}

export function attachFormAssistHandlers(
  card: HTMLElement,
  callbacks: FormAssistCallbacks
): void {
  // Copy field
  card.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const btn = target.closest('.btn-copy-field') as HTMLElement | null
    if (btn) {
      const fid = btn.dataset.fieldId!
      const val = getFieldValue(card, fid)
      if (val) {
        callbacks.onCopyField(val)
        flashButton(btn, 'copied', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!')
      }
      return
    }

    // Fill field
    const fillBtn = target.closest('.btn-fill-field') as HTMLElement | null
    if (fillBtn) {
      const fid = fillBtn.dataset.fieldId!
      const selector = fillBtn.dataset.selector!
      const inputType = fillBtn.dataset.inputType!
      const val = getFieldValue(card, fid)
      if (!val) return

      const ok = await callbacks.onFillField(selector, val, inputType)
      if (ok) {
        flashButton(fillBtn, 'filled', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Filled!')
      } else {
        // Fallback: copy to clipboard instead
        callbacks.onCopyField(val)
        flashButton(fillBtn, 'fill-failed', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copied instead', 2000)
      }
      return
    }

    // Fill All
    const fillAll = target.closest('.btn-fill-all') as HTMLButtonElement | null
    if (fillAll) {
      fillAll.disabled = true
      const fields = card.querySelectorAll<HTMLElement>('.form-assist-field')
      let filled = 0, copied = 0, skipped = 0
      const total = fields.length

      for (const field of fields) {
        const fid = field.dataset.fieldId!
        const val = getFieldValue(card, fid)
        if (!val) { skipped++; continue }

        const fb = field.querySelector<HTMLElement>('.btn-fill-field')
        const selector = fb?.dataset.selector ?? ''
        const inputType = fb?.dataset.inputType ?? 'text'

        fillAll.textContent = `Filling... ${filled + copied + skipped + 1}/${total}`

        if (selector) {
          const ok = await callbacks.onFillField(selector, val, inputType)
          if (ok) { filled++ } else { callbacks.onCopyField(val); copied++ }
        } else { skipped++ }
      }

      card.classList.add('form-assist-done')
      const summaryEl = document.createElement('div')
      summaryEl.className = 'form-assist-summary'
      let summary = `Filled ${filled} field${filled !== 1 ? 's' : ''}`
      if (copied > 0) summary += `, copied ${copied} (site blocked fill)`
      if (skipped > 0) summary += `, skipped ${skipped} empty`
      summaryEl.textContent = summary
      card.querySelector('.form-assist-footer')?.replaceWith(summaryEl)
      return
    }

    // Copy All
    const copyAll = target.closest('.btn-copy-all') as HTMLElement | null
    if (copyAll) {
      const fields = card.querySelectorAll<HTMLElement>('.form-assist-field')
      const lines: string[] = []
      for (const field of fields) {
        const fid = field.dataset.fieldId!
        const label = field.querySelector('.form-assist-label')?.textContent?.trim() ?? fid
        const val = getFieldValue(card, fid)
        if (val) lines.push(`${label}:\n${val}`)
      }
      const text = lines.join('\n\n')
      callbacks.onCopyAll(text)
      flashButton(copyAll, 'copied', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied all!')
    }
  })
}
