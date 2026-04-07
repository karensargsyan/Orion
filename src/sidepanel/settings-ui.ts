import { MSG } from '../shared/constants'
import type { Settings, APICapabilities } from '../shared/types'

export async function initSettings(container: HTMLElement): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET }) as { ok: boolean; settings: Settings }
  const s = res.ok ? res.settings : {} as Settings

  container.innerHTML = `
    <div class="settings-form">
      <h2>Settings</h2>

      <section class="settings-section">
        <h3>AI Model</h3>
        ${renderConnectionInfo(s)}
        <div class="form-group">
          <label>Server URL</label>
          <div class="input-row-inline">
            <input type="text" id="lm-url" value="${esc(s.lmStudioUrl ?? '')}" placeholder="http://192.168.8.155:1234">
            <button id="btn-test-connection" class="btn-small">Test</button>
          </div>
          <p id="connection-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>Auth Token</label>
          <input type="password" id="auth-token" value="${esc(s.authToken ?? '')}" placeholder="Optional">
        </div>
        <div class="form-group">
          <label>Model</label>
          <div class="input-row-inline">
            <select id="lm-model">
              <option value="${esc(s.lmStudioModel ?? '')}">
                ${s.lmStudioModel ? esc(s.lmStudioModel) : '- click Refresh -'}
              </option>
            </select>
            <button id="btn-refresh-models" class="btn-small">Refresh</button>
          </div>
        </div>
        <div class="form-group">
          <label>Rate Limit (requests/minute)</label>
          <input type="number" id="rate-limit" value="${s.rateLimitRpm ?? 10}" min="1" max="60">
        </div>
        <div class="form-group">
          <label>Context Window (messages kept)</label>
          <input type="number" id="ctx-window" value="${s.maxContextMessages ?? 20}" min="2" max="50">
        </div>
        <div class="form-actions">
          <button id="btn-re-probe" class="btn-small">Re-detect Capabilities</button>
          <p id="probe-status" class="hint-text"></p>
        </div>
      </section>

      <section class="settings-section">
        <h3>Monitoring</h3>
        <div class="form-group form-group-toggle">
          <label>Background monitoring</label>
          <input type="checkbox" id="monitoring-enabled" ${s.monitoringEnabled ? 'checked' : ''}>
        </div>
        <div class="form-group form-group-toggle">
          <label>Vision mode (screenshots to AI)</label>
          <input type="checkbox" id="vision-enabled" ${s.visionEnabled ? 'checked' : ''}>
        </div>
        <div class="form-group">
          <label>Screenshot interval (seconds)</label>
          <input type="number" id="screenshot-interval" value="${s.screenshotIntervalSec ?? 10}" min="5" max="120">
        </div>
        <div class="form-group form-group-toggle">
          <label>Text rewrite suggestions</label>
          <input type="checkbox" id="text-rewrite-enabled" ${s.textRewriteEnabled ? 'checked' : ''}>
        </div>
        <div class="form-group form-group-toggle">
          <label>Calendar detection</label>
          <input type="checkbox" id="calendar-detection" ${s.calendarDetectionEnabled ? 'checked' : ''}>
        </div>
      </section>

      <section class="settings-section">
        <h3>Security</h3>
        ${s.hasPinSetup ? `
          <div class="form-group">
            <label>Change PIN</label>
            <input type="password" id="old-pin" placeholder="Current PIN" maxlength="6" inputmode="numeric" class="pin-input">
            <input type="password" id="new-pin" placeholder="New PIN" maxlength="6" inputmode="numeric" class="pin-input" style="margin-top:6px">
            <input type="password" id="new-pin-2" placeholder="Confirm" maxlength="6" inputmode="numeric" class="pin-input" style="margin-top:6px">
            <button id="btn-change-pin" class="btn-small" style="margin-top:8px">Change PIN</button>
            <p id="pin-change-status" class="hint-text"></p>
          </div>
        ` : '<p class="hint-text">No PIN set. Go to Vault to set up encryption.</p>'}
      </section>

      <section class="settings-section">
        <h3>Data</h3>
        <div class="form-row">
          <button id="btn-export-memory" class="btn-small">Export Memory</button>
          <button id="btn-clear-session-mem" class="btn-small btn-danger">Clear Session</button>
          <button id="btn-clear-all-mem" class="btn-small btn-danger">Clear All</button>
        </div>
      </section>

      <div class="settings-footer">
        <button id="btn-save-settings" class="btn-primary">Save Settings</button>
        <p id="save-status" class="hint-text"></p>
      </div>
    </div>
  `

  wireSettingsEvents(container, s)
}

function renderConnectionInfo(s: Settings): string {
  const caps = s.apiCapabilities
  if (!caps) return ''
  return `
    <div class="connection-info">
      <span class="connection-badge connected">Connected</span>
      <span class="hint-text">${esc(caps.serverType)} &middot; ${caps.availableModels.length} model(s) &middot; ${caps.apiFormat}</span>
    </div>
  `
}

function wireSettingsEvents(container: HTMLElement, s: Settings): void {
  container.querySelector('#btn-test-connection')?.addEventListener('click', async () => {
    const url = (container.querySelector('#lm-url') as HTMLInputElement).value.trim()
    const token = (container.querySelector('#auth-token') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#connection-status') as HTMLElement
    statusEl.textContent = 'Testing...'
    const res = await chrome.runtime.sendMessage({ type: MSG.MODELS_LIST, url, authToken: token }) as { ok: boolean; models: string[] }
    if (res.models?.length > 0) {
      statusEl.textContent = `Connected! ${res.models.length} model(s) available.`
      statusEl.style.color = 'var(--color-success)'
    } else {
      statusEl.textContent = 'Could not connect. Check URL and server.'
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-refresh-models')?.addEventListener('click', async () => {
    const url = (container.querySelector('#lm-url') as HTMLInputElement).value.trim()
    const token = (container.querySelector('#auth-token') as HTMLInputElement).value.trim()
    const res = await chrome.runtime.sendMessage({ type: MSG.MODELS_LIST, url, authToken: token }) as { ok: boolean; models: string[] }
    const select = container.querySelector('#lm-model') as HTMLSelectElement
    select.innerHTML = res.models.map(m =>
      `<option value="${esc(m)}" ${m === s.lmStudioModel ? 'selected' : ''}>${esc(m)}</option>`
    ).join('') || '<option value="">No models found</option>'
  })

  container.querySelector('#btn-re-probe')?.addEventListener('click', async () => {
    const url = (container.querySelector('#lm-url') as HTMLInputElement).value.trim()
    const token = (container.querySelector('#auth-token') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#probe-status') as HTMLElement
    statusEl.textContent = 'Probing...'
    const res = await chrome.runtime.sendMessage({ type: MSG.PROBE_ENDPOINT, url, authToken: token || undefined }) as { ok: boolean; capabilities?: APICapabilities; error?: string }
    if (res.ok && res.capabilities) {
      statusEl.textContent = `Detected: ${res.capabilities.serverType}, ${res.capabilities.availableModels.length} models, format: ${res.capabilities.apiFormat}`
      statusEl.style.color = 'var(--color-success)'
      await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, partial: { apiCapabilities: res.capabilities } })
    } else {
      statusEl.textContent = `Failed: ${res.error || 'Unknown'}`
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-save-settings')?.addEventListener('click', async () => {
    const partial: Partial<Settings> = {
      lmStudioUrl: (container.querySelector('#lm-url') as HTMLInputElement).value.trim(),
      lmStudioModel: (container.querySelector('#lm-model') as HTMLSelectElement).value,
      authToken: (container.querySelector('#auth-token') as HTMLInputElement).value.trim(),
      rateLimitRpm: Number((container.querySelector('#rate-limit') as HTMLInputElement).value),
      maxContextMessages: Number((container.querySelector('#ctx-window') as HTMLInputElement).value),
      monitoringEnabled: (container.querySelector('#monitoring-enabled') as HTMLInputElement).checked,
      visionEnabled: (container.querySelector('#vision-enabled') as HTMLInputElement).checked,
      screenshotIntervalSec: Number((container.querySelector('#screenshot-interval') as HTMLInputElement).value),
      textRewriteEnabled: (container.querySelector('#text-rewrite-enabled') as HTMLInputElement).checked,
      calendarDetectionEnabled: (container.querySelector('#calendar-detection') as HTMLInputElement).checked,
    }
    await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, partial })
    const statusEl = container.querySelector('#save-status') as HTMLElement
    statusEl.textContent = 'Saved!'
    statusEl.style.color = 'var(--color-success)'
    setTimeout(() => { statusEl.textContent = '' }, 2000)
  })

  container.querySelector('#btn-change-pin')?.addEventListener('click', async () => {
    const oldPin = (container.querySelector('#old-pin') as HTMLInputElement).value
    const newPin = (container.querySelector('#new-pin') as HTMLInputElement).value
    const newPin2 = (container.querySelector('#new-pin-2') as HTMLInputElement).value
    const statusEl = container.querySelector('#pin-change-status') as HTMLElement
    if (newPin !== newPin2) { statusEl.textContent = 'PINs do not match'; return }
    if (newPin.length < 4) { statusEl.textContent = 'PIN must be at least 4 digits'; return }
    const res = await chrome.runtime.sendMessage({ type: MSG.CHANGE_PIN, oldPin, newPin }) as { ok: boolean; error?: string }
    statusEl.textContent = res.ok ? 'PIN changed' : (res.error ?? 'Failed')
    statusEl.style.color = res.ok ? 'var(--color-success)' : 'var(--color-error)'
  })

  container.querySelector('#btn-export-memory')?.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: MSG.MEMORY_EXPORT }) as { ok: boolean; data?: object }
    if (res.data) {
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `localai-memory-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    }
  })

  container.querySelector('#btn-clear-session-mem')?.addEventListener('click', async () => {
    if (!confirm('Clear session memory?')) return
    await chrome.runtime.sendMessage({ type: MSG.MEMORY_CLEAR, target: 'session' })
  })

  container.querySelector('#btn-clear-all-mem')?.addEventListener('click', async () => {
    if (!confirm('Clear ALL memory and chat history?')) return
    await chrome.runtime.sendMessage({ type: MSG.MEMORY_CLEAR })
  })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
