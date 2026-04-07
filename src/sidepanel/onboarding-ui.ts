import { MSG } from '../shared/constants'
import type { APICapabilities } from '../shared/types'

export async function initOnboarding(
  container: HTMLElement,
  onComplete: () => void
): Promise<void> {
  renderWelcome(container, onComplete)
}

function renderWelcome(container: HTMLElement, onComplete: () => void): void {
  container.innerHTML = `
    <div class="onboarding">
      <div class="onboarding-header">
        <div class="onboarding-logo">AI</div>
        <h1>LocalAI Assistant</h1>
        <p class="onboarding-subtitle">Your private AI browser assistant. Runs entirely on your local machine.</p>
      </div>

      <div class="onboarding-step">
        <h2>Connect to your AI model</h2>
        <p class="hint-text">Enter the URL of your local AI server (LM Studio, Ollama, vLLM, etc.)</p>

        <div class="form-group">
          <label>Server URL</label>
          <input type="text" id="ob-url" placeholder="http://192.168.8.155:1234" value="" autocomplete="off">
        </div>

        <div class="form-group">
          <label>Auth Token (optional)</label>
          <input type="password" id="ob-token" placeholder="Leave empty if not required" autocomplete="off">
        </div>

        <div class="form-actions">
          <button id="ob-detect" class="btn-primary">Detect & Connect</button>
        </div>

        <div id="ob-status" class="onboarding-status" style="display:none"></div>
      </div>

      <div id="ob-results" style="display:none">
        <div class="onboarding-step">
          <h2>Server Detected</h2>
          <div id="ob-caps" class="onboarding-caps"></div>

          <div class="form-group">
            <label>Select Model</label>
            <select id="ob-model"></select>
          </div>

          <div class="form-group form-group-toggle">
            <label>Enable Vision (screenshots)</label>
            <input type="checkbox" id="ob-vision">
          </div>

          <div class="form-actions">
            <button id="ob-save" class="btn-primary">Start Using Assistant</button>
          </div>
        </div>
      </div>
    </div>
  `

  container.querySelector('#ob-detect')?.addEventListener('click', () => {
    detectEndpoint(container, onComplete)
  })

  const urlInput = container.querySelector('#ob-url') as HTMLInputElement
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') detectEndpoint(container, onComplete)
  })
}

async function detectEndpoint(container: HTMLElement, onComplete: () => void): Promise<void> {
  const urlInput = container.querySelector('#ob-url') as HTMLInputElement
  const tokenInput = container.querySelector('#ob-token') as HTMLInputElement
  const statusEl = container.querySelector('#ob-status') as HTMLElement
  const resultsEl = container.querySelector('#ob-results') as HTMLElement
  const detectBtn = container.querySelector('#ob-detect') as HTMLButtonElement

  const url = urlInput.value.trim()
  if (!url) {
    showStatus(statusEl, 'Please enter a server URL', 'error')
    return
  }

  detectBtn.disabled = true
  showStatus(statusEl, 'Probing endpoint...', 'info')

  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.PROBE_ENDPOINT,
      url,
      authToken: tokenInput.value.trim() || undefined,
    }) as { ok: boolean; capabilities?: APICapabilities; error?: string }

    if (!res.ok || !res.capabilities) {
      showStatus(statusEl, `Could not connect: ${res.error || 'Server unreachable'}`, 'error')
      detectBtn.disabled = false
      return
    }

    const caps = res.capabilities
    renderDetectionResults(container, caps, onComplete)
    resultsEl.style.display = ''
    showStatus(statusEl, 'Connected successfully!', 'success')
  } catch (err) {
    showStatus(statusEl, `Error: ${err}`, 'error')
  } finally {
    detectBtn.disabled = false
  }
}

function renderDetectionResults(
  container: HTMLElement,
  caps: APICapabilities,
  onComplete: () => void
): void {
  const capsEl = container.querySelector('#ob-caps') as HTMLElement
  const modelSelect = container.querySelector('#ob-model') as HTMLSelectElement
  const visionCheck = container.querySelector('#ob-vision') as HTMLInputElement

  capsEl.innerHTML = `
    <div class="caps-grid">
      <div class="caps-item">
        <span class="caps-label">Server</span>
        <span class="caps-value">${esc(caps.serverType)}</span>
      </div>
      <div class="caps-item">
        <span class="caps-label">API Format</span>
        <span class="caps-value">${esc(caps.apiFormat)}</span>
      </div>
      <div class="caps-item">
        <span class="caps-label">Models</span>
        <span class="caps-value">${caps.availableModels.length}</span>
      </div>
      <div class="caps-item">
        <span class="caps-label">Vision</span>
        <span class="caps-value ${caps.supportsVision ? 'caps-yes' : 'caps-no'}">${caps.supportsVision ? 'Yes' : 'No'}</span>
      </div>
      <div class="caps-item">
        <span class="caps-label">Embeddings</span>
        <span class="caps-value ${caps.supportsEmbeddings ? 'caps-yes' : 'caps-no'}">${caps.supportsEmbeddings ? 'Yes' : 'No'}</span>
      </div>
      <div class="caps-item">
        <span class="caps-label">Streaming</span>
        <span class="caps-value caps-yes">Yes</span>
      </div>
    </div>
  `

  modelSelect.innerHTML = caps.availableModels.map(m =>
    `<option value="${esc(m.id)}" ${m.id === caps.defaultModel ? 'selected' : ''}>${esc(m.name)}${m.supportsVision ? ' (vision)' : ''}</option>`
  ).join('') || '<option value="">No models available</option>'

  visionCheck.checked = caps.supportsVision
  visionCheck.disabled = !caps.supportsVision

  container.querySelector('#ob-save')?.addEventListener('click', async () => {
    const selectedModel = modelSelect.value
    const visionEnabled = visionCheck.checked

    await chrome.runtime.sendMessage({
      type: MSG.SETTINGS_SET,
      partial: {
        lmStudioUrl: caps.baseUrl,
        lmStudioModel: selectedModel,
        authToken: caps.authToken || '',
        apiCapabilities: caps,
        visionEnabled,
        onboardingComplete: true,
        monitoringEnabled: true,
      },
    })

    onComplete()
  })
}

function showStatus(el: HTMLElement, text: string, type: 'info' | 'success' | 'error'): void {
  el.style.display = ''
  el.className = `onboarding-status status-${type}`
  el.textContent = text
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
