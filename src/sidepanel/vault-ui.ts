/**
 * Vault UI — encrypted storage CRUD with PIN lock/unlock screen.
 */

import { MSG } from '../shared/constants'
import type { VaultCategory, VaultData } from '../shared/types'

interface VaultEntryMeta {
  id: string
  category: VaultCategory
  label: string
  updatedAt: number
}

const CATEGORY_LABELS: Record<VaultCategory, string> = {
  credential: '🔑 Credential',
  address: '🏠 Address',
  card: '💳 Card',
  contact: '👤 Contact',
  identity: '🪪 Identity',
  custom: '📝 Custom',
}

const CATEGORY_FIELDS: Record<VaultCategory, Array<{ key: string; label: string; type?: string }>> = {
  credential: [
    { key: 'username', label: 'Username / Email' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'url', label: 'Website URL' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ],
  address: [
    { key: 'firstName', label: 'First Name' },
    { key: 'lastName', label: 'Last Name' },
    { key: 'street', label: 'Street Address' },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State / Region' },
    { key: 'zip', label: 'ZIP / Postal Code' },
    { key: 'country', label: 'Country' },
    { key: 'phone', label: 'Phone' },
  ],
  card: [
    { key: 'cardholderName', label: 'Cardholder Name' },
    { key: 'number', label: 'Card Number', type: 'password' },
    { key: 'expiry', label: 'Expiry (MM/YY)' },
    { key: 'cvv', label: 'CVV', type: 'password' },
    { key: 'billingZip', label: 'Billing ZIP' },
  ],
  contact: [
    { key: 'firstName', label: 'First Name' },
    { key: 'lastName', label: 'Last Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'company', label: 'Company' },
    { key: 'birthday', label: 'Birthday (YYYY-MM-DD)' },
  ],
  identity: [
    { key: 'firstName', label: 'First Name' },
    { key: 'lastName', label: 'Last Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'birthday', label: 'Birthday (YYYY-MM-DD)' },
  ],
  custom: [
    { key: 'field1', label: 'Field 1' },
    { key: 'field2', label: 'Field 2' },
    { key: 'field3', label: 'Field 3' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ],
}

// ─── State ────────────────────────────────────────────────────────────────────

let container: HTMLElement
let isUnlocked = false

// ─── Main render ──────────────────────────────────────────────────────────────

export async function initVault(el: HTMLElement): Promise<void> {
  container = el
  await checkAndRender()
}

async function checkAndRender(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.SESSION_STATUS }) as {
    ok: boolean; unlocked: boolean; hasPinSetup: boolean
  }
  isUnlocked = res.unlocked

  if (!res.hasPinSetup) {
    renderSetupPin()
  } else if (!res.unlocked) {
    renderLockScreen()
  } else {
    await renderVaultList()
  }
}

// ─── PIN Setup ────────────────────────────────────────────────────────────────

function renderSetupPin(): void {
  container.innerHTML = `
    <div class="vault-lock">
      <div class="lock-icon">🔒</div>
      <h2>Set Up Your PIN</h2>
      <p>Create a 4–6 digit PIN to protect your vault. This encrypts all stored data.</p>
      <input type="password" id="pin-setup-1" placeholder="Enter PIN (4–6 digits)" maxlength="6" inputmode="numeric" class="pin-input">
      <input type="password" id="pin-setup-2" placeholder="Confirm PIN" maxlength="6" inputmode="numeric" class="pin-input">
      <button id="btn-setup-pin" class="btn-primary">Create PIN</button>
      <p id="pin-error" class="error-text" style="display:none"></p>
    </div>
  `

  container.querySelector('#btn-setup-pin')?.addEventListener('click', async () => {
    const pin1 = (container.querySelector('#pin-setup-1') as HTMLInputElement).value
    const pin2 = (container.querySelector('#pin-setup-2') as HTMLInputElement).value
    const errEl = container.querySelector('#pin-error') as HTMLElement

    if (pin1.length < 4 || !/^\d+$/.test(pin1)) {
      showError(errEl, 'PIN must be 4–6 digits')
      return
    }
    if (pin1 !== pin2) {
      showError(errEl, 'PINs do not match')
      return
    }

    const res = await chrome.runtime.sendMessage({ type: MSG.SETUP_PIN, pin: pin1 }) as { ok: boolean }
    if (res.ok) {
      // Sync hasPinSetup to IDB so it persists across sessions
      await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, partial: { hasPinSetup: true } }).catch(() => {})
      await checkAndRender()
    } else {
      showError(errEl, 'Setup failed. Try again.')
    }
  })
}

// ─── Lock Screen ──────────────────────────────────────────────────────────────

function renderLockScreen(): void {
  container.innerHTML = `
    <div class="vault-lock">
      <div class="lock-icon">🔒</div>
      <h2>Vault Locked</h2>
      <p>Enter your PIN to unlock your secure vault.</p>
      <input type="password" id="pin-unlock" placeholder="Enter PIN" maxlength="6" inputmode="numeric" class="pin-input" autofocus>
      <button id="btn-unlock" class="btn-primary">Unlock</button>
      <p id="pin-error" class="error-text" style="display:none"></p>
    </div>
  `

  const pinInput = container.querySelector('#pin-unlock') as HTMLInputElement
  const doUnlock = async () => {
    const errEl = container.querySelector('#pin-error') as HTMLElement
    const pin = pinInput.value
    if (!pin) return
    const res = await chrome.runtime.sendMessage({ type: MSG.UNLOCK_SESSION, pin }) as { ok: boolean; error?: string }
    if (res.ok) {
      isUnlocked = true
      try {
        await renderVaultList()
      } catch (err) {
        isUnlocked = false
        showError(errEl, 'Unlocked but failed to load vault. Try again.')
        console.error('[Vault] renderVaultList failed after unlock:', err)
      }
    } else {
      showError(errEl, res.error ?? 'Wrong PIN')
      pinInput.value = ''
    }
  }

  container.querySelector('#btn-unlock')?.addEventListener('click', doUnlock)
  pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock() })
}

// ─── Vault List ───────────────────────────────────────────────────────────────

async function renderVaultList(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.VAULT_LIST }) as {
    ok: boolean; error?: string; entries?: VaultEntryMeta[]
  }

  if (!res.ok) {
    if (res.error === 'SESSION_LOCKED') { renderLockScreen(); return }
    container.innerHTML = `<p class="error-text">Error: ${escHtml(res.error ?? 'Unknown error')}</p>`
    return
  }

  const entries = res.entries ?? []

  container.innerHTML = `
    <div class="vault-header">
      <h2>Vault</h2>
      <button id="btn-add-entry" class="btn-primary btn-small">+ Add</button>
    </div>
    <div class="vault-categories">
      ${renderCategoryGroups(entries)}
    </div>
    ${entries.length === 0 ? '<p class="empty-hint">No entries yet. Click <strong>+ Add</strong> to store your first profile.</p>' : ''}
  `

  container.querySelector('#btn-add-entry')?.addEventListener('click', () => renderAddForm())

  container.querySelectorAll('.vault-entry').forEach(el => {
    const id = el.getAttribute('data-id')!
    el.querySelector('.btn-edit')?.addEventListener('click', () => renderEditForm(id))
    el.querySelector('.btn-delete')?.addEventListener('click', () => deleteEntry(id))
    el.querySelector('.btn-fill')?.addEventListener('click', () => fillEntry(id))
  })
}

function renderCategoryGroups(entries: VaultEntryMeta[]): string {
  if (entries.length === 0) return ''

  const groups: Record<string, VaultEntryMeta[]> = {}
  for (const e of entries) {
    if (!groups[e.category]) groups[e.category] = []
    groups[e.category].push(e)
  }

  return Object.entries(groups).map(([cat, items]) => `
    <div class="vault-group">
      <div class="vault-group-label">${CATEGORY_LABELS[cat as VaultCategory] ?? cat}</div>
      ${items.map(item => `
        <div class="vault-entry" data-id="${item.id}">
          <div class="vault-entry-label">${escHtml(item.label)}</div>
          <div class="vault-entry-actions">
            <button class="btn-fill btn-small" title="Fill form with this">Fill</button>
            <button class="btn-edit btn-small" title="Edit">Edit</button>
            <button class="btn-delete btn-small btn-danger" title="Delete">✕</button>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('')
}

// ─── Add / Edit Form ──────────────────────────────────────────────────────────

function renderAddForm(defaultCategory: VaultCategory = 'contact'): void {
  renderEntryForm(null, defaultCategory, null)
}

async function renderEditForm(id: string): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.VAULT_GET, id }) as {
    ok: boolean; data?: VaultData; error?: string
  }
  if (!res.ok || !res.data) return

  const metaRes = await chrome.runtime.sendMessage({ type: MSG.VAULT_LIST }) as { ok: boolean; entries?: VaultEntryMeta[] }
  const meta = metaRes.entries?.find(e => e.id === id)
  if (!meta) return

  renderEntryForm(id, meta.category, res.data as Record<string, string>)
}

function renderEntryForm(
  id: string | null,
  category: VaultCategory,
  existingData: Record<string, string> | null
): void {
  const isNew = id === null
  const slugId = id ?? `${category}_${Date.now()}`

  container.innerHTML = `
    <div class="vault-form">
      <div class="vault-form-header">
        <button id="btn-back" class="btn-small">← Back</button>
        <h2>${isNew ? 'Add Entry' : 'Edit Entry'}</h2>
      </div>
      ${isNew ? `
        <div class="form-group">
          <label>Category</label>
          <select id="entry-category">
            ${Object.entries(CATEGORY_LABELS).map(([v, l]) =>
              `<option value="${v}" ${v === category ? 'selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
      ` : ''}
      <div class="form-group">
        <label>Label (nickname)</label>
        <input type="text" id="entry-label" placeholder="e.g. Work email, Home address" value="${escHtml(existingData?.label ?? '')}">
      </div>
      <div id="entry-fields">
        ${renderFieldsForCategory(category, existingData)}
      </div>
      <div class="form-actions">
        <button id="btn-save-entry" class="btn-primary">Save</button>
        <button id="btn-cancel-entry" class="btn-small">Cancel</button>
        <p id="save-error" class="error-text" style="display:none"></p>
      </div>
    </div>
  `

  // Dynamic field update when category changes
  const categorySelect = container.querySelector('#entry-category') as HTMLSelectElement | null
  categorySelect?.addEventListener('change', () => {
    const newCat = categorySelect.value as VaultCategory
    const fieldsEl = container.querySelector('#entry-fields')!
    fieldsEl.innerHTML = renderFieldsForCategory(newCat, null)
  })

  container.querySelector('#btn-back')?.addEventListener('click', () => renderVaultList())
  container.querySelector('#btn-cancel-entry')?.addEventListener('click', () => renderVaultList())
  container.querySelector('#btn-save-entry')?.addEventListener('click', () => saveEntry(
    isNew ? slugId : id!,
    isNew ? (categorySelect?.value ?? category) as VaultCategory : category
  ))
}

function renderFieldsForCategory(category: VaultCategory, data: Record<string, string> | null): string {
  const fields = CATEGORY_FIELDS[category] ?? []
  return fields.map(f => {
    const val = escHtml(data?.[f.key] ?? '')
    if (f.type === 'textarea') {
      return `<div class="form-group"><label>${f.label}</label><textarea name="${f.key}" rows="3">${val}</textarea></div>`
    }
    return `<div class="form-group"><label>${f.label}</label><input type="${f.type ?? 'text'}" name="${f.key}" value="${val}" autocomplete="off"></div>`
  }).join('')
}

async function saveEntry(id: string, category: VaultCategory): Promise<void> {
  const errEl = container.querySelector('#save-error') as HTMLElement
  const label = (container.querySelector('#entry-label') as HTMLInputElement)?.value?.trim()
  if (!label) { showError(errEl, 'Please enter a label'); return }

  const data: Record<string, string> = {}
  container.querySelectorAll('#entry-fields input, #entry-fields textarea, #entry-fields select').forEach(el => {
    const input = el as HTMLInputElement
    if (input.name) data[input.name] = input.value
  })

  const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
  const res = await chrome.runtime.sendMessage({
    type: MSG.VAULT_SET,
    id: cleanId,
    category,
    label,
    data,
  }) as { ok: boolean; error?: string }

  if (res.ok) await renderVaultList()
  else showError(errEl, res.error ?? 'Save failed')
}

async function deleteEntry(id: string): Promise<void> {
  if (!confirm('Delete this vault entry?')) return
  await chrome.runtime.sendMessage({ type: MSG.VAULT_DELETE, id })
  await renderVaultList()
}

async function fillEntry(id: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) { alert('No active tab found'); return }

  const res = await chrome.runtime.sendMessage({
    type: MSG.FILL_FORM,
    vaultId: id,
    formSelector: '',
    tabId: tab.id,
    includePasswords: id.includes('credential') || id.includes('login'),
  }) as { ok: boolean; fieldCount?: number; error?: string }

  if (res.ok) {
    alert(`✓ Filled ${res.fieldCount} field(s)`)
  } else {
    alert(`Could not fill: ${res.error}`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showError(el: HTMLElement, msg: string): void {
  el.textContent = msg
  el.style.display = ''
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
