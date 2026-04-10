import { MSG, DEFAULTS } from '../shared/constants'
import { isBraveBrowserAsync } from '../shared/browser-environment'
import { extensionSiteSettingsUrl, WEB_SPEECH_NETWORK_NOTE } from '../shared/google-web-speech-permissions'
import type { Settings, APICapabilities } from '../shared/types'
import * as speech from './speech-service'

export async function initSettings(container: HTMLElement): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET }) as { ok: boolean; settings: Settings }
  const s = res.ok ? res.settings : {} as Settings
  const provider = s.activeProvider || 'local'

  // Check if model is configured
  const needsSetup = !(
    (provider === 'local' && s.lmStudioUrl) ||
    (provider === 'gemini' && s.geminiApiKey) ||
    (provider === 'openai' && s.openaiApiKey) ||
    (provider === 'anthropic' && s.anthropicApiKey)
  )

  container.innerHTML = `
    <div class="settings-form">
      <h2>Settings</h2>

      ${needsSetup ? `
      <div class="setup-banner">
        <div class="setup-banner-icon">⚡</div>
        <div class="setup-banner-text">
          <strong>Set up your AI model to get started</strong>
          <p>Select a provider below and enter your server URL or API key. Without a model, Orion can't help you.</p>
        </div>
      </div>
      ` : ''}

      <section class="settings-section">
        <h3>AI Provider</h3>
        <div class="form-group">
          <label>Active Provider</label>
          <select id="active-provider">
            <option value="local" ${provider === 'local' ? 'selected' : ''}>Local (LM Studio / Ollama)</option>
            <option value="gemini" ${provider === 'gemini' ? 'selected' : ''}>Google Gemini</option>
            <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI</option>
            <option value="anthropic" ${provider === 'anthropic' ? 'selected' : ''}>Anthropic Claude</option>
          </select>
        </div>
      </section>

      <section class="settings-section provider-section" id="section-local" ${provider === 'local' ? '' : 'style="display:none"'}>
        <h3>Local AI Server</h3>
        ${renderConnectionInfo(s)}
        <div class="form-group">
          <label>Server URL</label>
          <div class="input-row-inline">
            <input type="text" id="lm-url" value="${esc(normalizeLocalUrl(s.lmStudioUrl ?? ''))}" placeholder="http://localhost:1234">
            <button id="btn-test-connection" class="btn-small btn-test-action">Test</button>
          </div>
          <p class="hint-text url-format-hint">Enter your server's base URL <strong>without</strong> <code>/v1</code> &mdash; Orion adds it automatically.<br>Examples: <code>http://localhost:1234</code> &middot; <code>http://localhost:11434</code> (Ollama)</p>
          <p id="connection-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>Auth Token <span class="optional-tag">optional</span></label>
          <input type="password" id="auth-token" value="${esc(s.authToken ?? '')}" placeholder="Leave empty if not required">
        </div>
        <div class="form-group">
          <label>Model</label>
          <div class="input-row-inline">
            <select id="lm-model">
              <option value="${esc(s.lmStudioModel ?? '')}">
                ${s.lmStudioModel ? esc(s.lmStudioModel) : '- Test connection first -'}
              </option>
            </select>
            <button id="btn-refresh-models" class="btn-small">Refresh</button>
          </div>
        </div>
        ${renderCapabilityBadges(s.apiCapabilities)}
        <div class="form-actions">
          <button id="btn-re-probe" class="btn-small">Re-detect Capabilities</button>
          <p id="probe-status" class="hint-text"></p>
        </div>
      </section>

      <section class="settings-section provider-section" id="section-gemini" ${provider === 'gemini' ? '' : 'style="display:none"'}>
        <h3>Google Gemini</h3>
        <div class="form-group">
          <label>API Key</label>
          <div class="input-row-inline">
            <input type="password" id="gemini-api-key" value="${esc(s.geminiApiKey ?? '')}" placeholder="AIza...">
            <button id="btn-test-gemini" class="btn-small btn-test-action">Test</button>
          </div>
          <p class="hint-text">Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a></p>
          <p id="gemini-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>Model</label>
          <div class="input-row-inline">
            <select id="gemini-model">
              ${renderGeminiModelOptions(s.geminiModel)}
            </select>
            <button id="btn-refresh-gemini-models" class="btn-small">Refresh</button>
          </div>
        </div>
      </section>

      <section class="settings-section provider-section" id="section-openai" ${provider === 'openai' ? '' : 'style="display:none"'}>
        <h3>OpenAI</h3>
        <div class="form-group">
          <label>API Key</label>
          <div class="input-row-inline">
            <input type="password" id="openai-api-key" value="${esc(s.openaiApiKey ?? '')}" placeholder="sk-...">
            <button id="btn-test-openai" class="btn-small btn-test-action">Test</button>
          </div>
          <p class="hint-text">Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a></p>
          <p id="openai-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>Model</label>
          <select id="openai-model">
            ${renderOpenAIModelOptions(s.openaiModel)}
          </select>
        </div>
      </section>

      <section class="settings-section provider-section" id="section-anthropic" ${provider === 'anthropic' ? '' : 'style="display:none"'}>
        <h3>Anthropic Claude</h3>
        <div class="form-group">
          <label>API Key</label>
          <div class="input-row-inline">
            <input type="password" id="anthropic-api-key" value="${esc(s.anthropicApiKey ?? '')}" placeholder="sk-ant-...">
            <button id="btn-test-anthropic" class="btn-small btn-test-action">Test</button>
          </div>
          <p class="hint-text">Get a key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a></p>
          <p id="anthropic-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>Model</label>
          <select id="anthropic-model">
            ${renderAnthropicModelOptions(s.anthropicModel)}
          </select>
        </div>
      </section>

      <section class="settings-section">
        <h3>General</h3>
        <div class="form-group">
          <label>Rate Limit (requests/minute)</label>
          <input type="number" id="rate-limit" value="${s.rateLimitRpm ?? 10}" min="1" max="60">
        </div>
        <div class="form-group">
          <label>Context Window (messages kept)</label>
          <input type="number" id="ctx-window" value="${s.maxContextMessages ?? 20}" min="2" max="50">
        </div>
        <div class="form-group">
          <label>Context Window (tokens, 0 = auto)</label>
          <input type="number" id="ctx-tokens" value="${s.contextWindowTokens ?? 0}" min="0" max="131072" step="1024">
          <small style="color:var(--text-dim);font-size:11px">Set to your model's context size (e.g. 4096, 8192, 32768). 0 = auto-detect.</small>
        </div>
        <div class="form-group form-group-toggle">
          <label>Lite Mode (simplified prompts for small local models &lt;20B)</label>
          <input type="checkbox" id="lite-mode" ${s.liteMode ? 'checked' : ''}>
          <small style="color:var(--text-dim);font-size:11px">Reduces system prompt from ~4500 to ~800 tokens. Fewer action types. Better for 7B-13B models.</small>
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
          <label>Tab safety border (heuristic threat detection)</label>
          <input type="checkbox" id="safety-border-enabled" ${s.safetyBorderEnabled ? 'checked' : ''}>
        </div>
        <p class="hint-text" style="margin-top:-8px;margin-bottom:10px">
          Scores each page for phishing/scam signals using local heuristics (suspicious TLDs, fake login forms, urgency phrases).
          Shows a green/orange/red border around the browser tab. No data is sent externally — analysis is fully local.
          Disabled by default; may produce false positives on legitimate sites.
        </p>
        <div class="form-group form-group-toggle">
          <label>Compose assistant (inline revised text while typing)</label>
          <input type="checkbox" id="compose-assistant-enabled" ${s.composeAssistantEnabled !== false ? 'checked' : ''}>
        </div>
        <div class="form-group form-group-toggle">
          <label>AI learning from your actions (periodic local model analysis)</label>
          <input type="checkbox" id="ai-action-learning-enabled" ${s.aiActionLearningEnabled !== false ? 'checked' : ''}>
        </div>
        <div class="form-group">
          <label>Automation mode</label>
          <select id="automation-preference">
            <option value="ask" ${(s.automationPreference ?? 'ask') === 'ask' ? 'selected' : ''}>Ask each time</option>
            <option value="auto" ${s.automationPreference === 'auto' ? 'selected' : ''}>Always auto (click for me)</option>
            <option value="guided" ${s.automationPreference === 'guided' ? 'selected' : ''}>Always guided (highlight for me)</option>
          </select>
        </div>
        <p class="hint-text" style="margin-top:-8px;margin-bottom:10px">
          Ask: prompts you to choose Guide or Auto for each task.
          Auto: AI clicks elements automatically.
          Guided: AI highlights what to click and you do it yourself.
        </p>
        <div class="form-group">
          <label>Learning mode snapshot interval (seconds)</label>
          <input type="number" id="learning-interval" value="${s.learningSnapshotIntervalSec ?? 3}" min="1" max="30">
        </div>
        <div class="form-group form-group-toggle">
          <label>Calendar detection</label>
          <input type="checkbox" id="calendar-detection" ${s.calendarDetectionEnabled ? 'checked' : ''}>
        </div>
      </section>

      <section class="settings-section">
        <h3>Speech Recognition</h3>
        <p class="hint-text" style="margin-bottom:10px">
          Used during Supervised Learning. <strong>Web Speech</strong> calls Google’s online recognizer (often blocked by Brave Shields, VPNs, or firewalls—you’ll see a “network” STT error).
          <strong>Local Whisper</strong> sends audio only to your machine (OpenAI-compatible API) and does not use that service.
        </p>
        <p id="stt-brave-notice" class="hint-text" style="display:none;margin-bottom:10px;padding:10px;border-radius:8px;background:rgba(255,165,0,0.12);border:1px solid rgba(200,120,0,0.35)">
          <strong>Brave:</strong> there is no separate Brave-only speech API for extensions—Web Speech still uses Google’s service (often blocked by Shields).
          <strong>Alternative that works in Brave:</strong> choose <strong>Local Whisper Server</strong> below and run a local OpenAI-compatible Whisper endpoint (e.g. whisper.cpp, Ollama, LM Studio).
          To keep using Web Speech instead, turn <strong>Shields down</strong> for this extension (Brave icon → Shields), or use Chrome where Web Speech usually connects without Shields blocking it.
        </p>
        <div id="stt-brave-web-speech-tools" class="form-group" style="display:none;margin-bottom:10px;padding:10px;border-radius:8px;background:rgba(80,120,255,0.08);border:1px solid rgba(80,100,200,0.25)">
          <label>Brave: Web Speech setup</label>
          <p class="hint-text" style="margin-bottom:8px">
            Extensions <strong>cannot</strong> disable Brave Shields programmatically—you must use the Brave toolbar. Host access for this extension is already broad; Shields can still block Web Speech inside the browser.
            Use the buttons below: Shields settings, a note on host permissions, or this extension’s site settings (microphone).
          </p>
          <div class="form-row" style="flex-wrap:wrap;gap:8px">
            <button type="button" id="btn-brave-shields-settings" class="btn-small">Open Brave Shields settings</button>
            <button type="button" id="btn-web-speech-network-note" class="btn-small">Host permission / Web Speech note</button>
            <button type="button" id="btn-extension-site-settings" class="btn-small">This extension — site settings</button>
          </div>
          <p id="brave-web-speech-tool-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>Microphone (this extension)</label>
          <p class="hint-text" style="margin-bottom:6px">
            Extensions cannot declare a Chrome permission that “allows Google Web Speech.” Grant the <strong>microphone</strong> here; Chrome remembers <strong>Allow</strong> until you revoke it under site settings.
            A <strong>network</strong> STT error means the <em>online</em> speech service is blocked—not missing mic permission—use <strong>Local Whisper</strong> below or fix Shields/VPN.
          </p>
          <p id="mic-permission-status-line" class="hint-text" style="margin-bottom:6px"></p>
          <div class="form-row" style="flex-wrap:wrap;gap:8px">
            <button type="button" id="btn-grant-mic" class="btn-small">Grant &amp; save microphone access</button>
            <button type="button" id="btn-open-mic-tab" class="btn-small">Open microphone permission page</button>
          </div>
          <p id="mic-grant-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>STT Provider</label>
          <select id="stt-provider">
            <option value="web-speech" ${(s.sttProvider ?? 'web-speech') === 'web-speech' ? 'selected' : ''}>Web Speech API (Chrome built-in)</option>
            <option value="whisper-local" ${s.sttProvider === 'whisper-local' ? 'selected' : ''}>Local Whisper Server</option>
          </select>
        </div>
        <div class="form-group" id="whisper-endpoint-group" ${(s.sttProvider ?? 'web-speech') === 'whisper-local' ? '' : 'style="display:none"'}>
          <label>Whisper Server URL</label>
          <input type="text" id="whisper-endpoint" value="${esc(s.whisperEndpoint ?? '')}" placeholder="http://localhost:8888">
          <p class="hint-text">OpenAI-compatible /v1/audio/transcriptions endpoint</p>
        </div>
      </section>

      <section class="settings-section">
        <h3>MemPalace</h3>
        <p class="hint-text" style="margin-bottom:10px">
          Long-term memory runs in Python on your machine (<a href="https://github.com/milla-jovovich/mempalace" target="_blank" rel="noopener">MemPalace</a>).
          Run <code>python3 bridge/mempalace_bridge.py</code> from the extension repo, then enable below.
        </p>
        <div class="form-group form-group-toggle">
          <label>Use MemPalace bridge (search + prompt)</label>
          <input type="checkbox" id="mempalace-enabled" ${s.mempalaceBridgeEnabled ? 'checked' : ''}>
        </div>
        <div class="form-group">
          <label>Bridge URL</label>
          <input type="text" id="mempalace-url" value="${esc(s.mempalaceBridgeUrl ?? DEFAULTS.MEMPALACE_BRIDGE_URL)}" placeholder="http://127.0.0.1:8765">
        </div>
        <div class="form-group">
          <label>Wing filter (optional)</label>
          <input type="text" id="mempalace-wing" value="${esc(s.mempalaceWing ?? '')}" placeholder="e.g. wing_project">
        </div>
        <div class="form-row">
          <button type="button" id="btn-mempalace-probe" class="btn-small">Test bridge</button>
          <button type="button" id="btn-mempalace-inbox" class="btn-small">Push session memory to palace</button>
        </div>
        <p id="mempalace-status" class="hint-text"></p>
      </section>

      <section class="settings-section">
        <h3>Security</h3>
        <div class="form-group">
          <label>Vault auto-lock timeout (minutes)</label>
          <input type="number" id="vault-lock-timeout" value="${s.vaultLockTimeoutMin ?? 15}" min="1" max="120">
          <small style="color:var(--text-dim);font-size:11px">Lock the vault after this many minutes of inactivity. Default: 15 min.</small>
        </div>
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
        <h3>Local Memory</h3>
        <p class="hint-text" style="margin-bottom:10px">
          Local memory stores lessons, errors, successes and domain knowledge in the browser (IndexedDB).
          Always available, no external server needed. Replaces MemPalace for most use cases.
        </p>
        <div class="form-group form-group-toggle">
          <label>Enable local memory</label>
          <input type="checkbox" id="local-memory-enabled" ${s.localMemoryEnabled !== false ? 'checked' : ''}>
        </div>
        <div class="form-group">
          <label>Max entries</label>
          <input type="number" id="local-memory-max" value="${s.localMemoryMaxEntries ?? 500}" min="50" max="5000" step="50">
          <small style="color:var(--text-dim);font-size:11px">Oldest/least-used entries are pruned automatically when limit is reached.</small>
        </div>
        <div class="form-row">
          <button id="btn-local-memory-stats" class="btn-small">Show Stats</button>
          <button id="btn-clear-local-memory" class="btn-small btn-danger">Clear Local Memory</button>
        </div>
        <p id="local-memory-status" class="hint-text"></p>
      </section>

      <section class="settings-section">
        <h3>Smart Auto-Collection</h3>
        <p class="hint-text" style="margin-bottom:10px">
          Monitors form inputs and extracts reusable personal data (name, email, phone, address, etc.)
          using AI analysis. Extracted data is stored encrypted in the Vault with an "Auto-collected" badge for your review.
        </p>
        <div class="form-group form-group-toggle">
          <label>Enable auto-collection</label>
          <input type="checkbox" id="auto-collect-enabled" ${s.autoCollectEnabled !== false ? 'checked' : ''}>
        </div>
        <div class="form-group">
          <label>Minimum fields before extraction</label>
          <input type="number" id="auto-collect-min-fields" value="${s.autoCollectMinFields ?? 3}" min="2" max="10">
          <small style="color:var(--text-dim);font-size:11px">Only extract when user fills this many fields on a page.</small>
        </div>
        <div class="form-group">
          <label>Exclude domains (comma-separated)</label>
          <input type="text" id="auto-collect-exclude" value="${esc((s.autoCollectExcludeDomains ?? []).join(', '))}" placeholder="e.g. google.com, facebook.com">
          <small style="color:var(--text-dim);font-size:11px">Domains where auto-collection is disabled.</small>
        </div>
      </section>

      <section class="settings-section">
        <h3>Total Recall</h3>
        <p class="hint-text" style="margin-bottom:10px">
          Records every form input (emails, usernames, passwords, addresses, etc.) so you can recall them later
          via the Memory tab AI search. Sensitive fields (passwords, card numbers) are stored encrypted.
        </p>
        <div class="form-group form-group-toggle">
          <label>Enable Total Recall</label>
          <input type="checkbox" id="input-journal-enabled" ${s.inputJournalEnabled !== false ? 'checked' : ''}>
        </div>
      </section>

      <section class="settings-section">
        <h3>Data</h3>
        <div class="form-row">
          <button id="btn-export-memory" class="btn-small">Export Memory</button>
          <button id="btn-clear-session-mem" class="btn-small btn-danger">Clear Session</button>
          <button id="btn-clear-all-mem" class="btn-small btn-danger">Clear All</button>
        </div>
      </section>

      <section class="settings-section">
        <h3>Telegram Bot</h3>
        <p class="hint-text" style="margin-bottom:10px">
          Connect Orion to a Telegram bot so you can chat with the AI from your phone.
          Create a bot via <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> and paste the token below.
        </p>
        <div class="form-group form-group-toggle">
          <label>Enable Telegram bot</label>
          <input type="checkbox" id="telegram-enabled" ${s.telegramBotEnabled ? 'checked' : ''}>
        </div>
        <div class="form-group">
          <label>Bot Token</label>
          <div class="input-row-inline">
            <input type="password" id="telegram-token" value="${esc(s.telegramBotToken ?? '')}" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11">
            <button id="btn-test-telegram" class="btn-small btn-test-action">Test</button>
          </div>
          <p id="telegram-status" class="hint-text"></p>
        </div>
        <div class="form-group">
          <label>Poll interval (seconds)</label>
          <input type="number" id="telegram-poll-interval" value="${s.telegramPollIntervalSec ?? 5}" min="2" max="60">
          <small style="color:var(--text-dim);font-size:11px">How often to check for new Telegram messages.</small>
        </div>
        <div class="form-group">
          <label>Allowed Chat IDs <span class="optional-tag">optional</span></label>
          <input type="text" id="telegram-chat-ids" value="${esc((s.telegramAllowedChatIds ?? []).join(', '))}" placeholder="Leave empty to allow all chats">
          <small style="color:var(--text-dim);font-size:11px">Comma-separated chat IDs. Empty = any chat can use the bot. Send /start to your bot to find your chat ID.</small>
        </div>
      </section>

      <section class="settings-section">
        <h3>About</h3>
        <p class="hint-text">
          <a href="#" id="btn-privacy-policy" style="color:var(--accent)">Privacy Policy</a>
        </p>
      </section>

      <div class="settings-footer">
        <button id="btn-save-settings" class="btn-primary">Save Settings</button>
        <p id="save-status" class="hint-text"></p>
      </div>
    </div>
  `

  wireSettingsEvents(container, s)
  wireProviderToggle(container)
  wireSTTProviderToggle(container)
  wireMicrophoneSettingsPanel(container)
  wireBraveWebSpeechTools(container)
  void showBraveSpeechUi(container)
  void refreshMicPermissionStatusLine(container)
}

async function showBraveSpeechUi(container: HTMLElement): Promise<void> {
  const notice = container.querySelector('#stt-brave-notice') as HTMLElement | null
  const tools = container.querySelector('#stt-brave-web-speech-tools') as HTMLElement | null
  if (!(await isBraveBrowserAsync())) return
  if (notice) notice.style.display = 'block'
  if (tools) tools.style.display = 'block'
}

function wireBraveWebSpeechTools(container: HTMLElement): void {
  const status = () => container.querySelector('#brave-web-speech-tool-status') as HTMLElement | null

  container.querySelector('#btn-brave-shields-settings')?.addEventListener('click', () => {
    void chrome.tabs.create({ url: 'brave://settings/shields', active: true })
    const el = status()
    if (el) {
      el.textContent = 'Set Shields down for this extension from the Brave toolbar on a tab, or adjust global defaults here.'
      el.style.color = ''
    }
  })

  container.querySelector('#btn-web-speech-network-note')?.addEventListener('click', () => {
    const el = status()
    if (el) {
      el.textContent = WEB_SPEECH_NETWORK_NOTE
      el.style.color = ''
    }
  })

  container.querySelector('#btn-extension-site-settings')?.addEventListener('click', () => {
    void chrome.tabs.create({ url: extensionSiteSettingsUrl(), active: true })
    const el = status()
    if (el) {
      el.textContent = 'Check microphone (and other permissions) for this extension.'
      el.style.color = ''
    }
  })
}

function wireMicrophoneSettingsPanel(container: HTMLElement): void {
  container.querySelector('#btn-grant-mic')?.addEventListener('click', async () => {
    const status = container.querySelector('#mic-grant-status') as HTMLElement
    status.textContent = 'Requesting microphone…'
    status.style.color = ''
    try {
      await speech.grantMicrophonePermissionInteractive()
      status.textContent =
        'Saved. Chrome will keep “Allow” for this extension until you change it in Settings → Privacy and security → Site settings → Microphone.'
      status.style.color = 'var(--color-success)'
      void refreshMicPermissionStatusLine(container)
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e)
      status.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-open-mic-tab')?.addEventListener('click', () => {
    const url = chrome.runtime.getURL('permissions/microphone-permission.html')
    void chrome.tabs.create({ url, active: true })
  })
}

async function refreshMicPermissionStatusLine(container: HTMLElement): Promise<void> {
  const el = container.querySelector('#mic-permission-status-line') as HTMLElement | null
  if (!el) return
  try {
    if (!navigator.permissions?.query) {
      el.textContent = 'Use the buttons above to allow the microphone (required for voice).'
      return
    }
    const r = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    const apply = (): void => {
      el.textContent = `Microphone permission for this extension page: ${r.state}.`
    }
    apply()
    r.onchange = apply
  } catch {
    el.textContent = 'Use the buttons above to allow the microphone for this extension.'
  }
}

function normalizeLocalUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
}

function renderConnectionInfo(s: Settings): string {
  const caps = s.apiCapabilities
  if (!caps) return '<div id="connection-info-bar" class="connection-info disconnected-bar"><span class="connection-badge disconnected">Not connected</span><span class="hint-text" id="provider-status">Click Test to check your server</span></div>'
  return `
    <div id="connection-info-bar" class="connection-info">
      <span class="connection-badge connected">Connected</span>
      <span class="hint-text" id="provider-status">${esc(caps.serverType)} &middot; ${caps.availableModels.length} model(s) &middot; ${caps.apiFormat}</span>
    </div>
  `
}

function renderCapabilityBadges(caps?: APICapabilities): string {
  if (!caps || caps.availableModels.length === 0) return '<div id="capability-badges" class="capability-badges"></div>'
  const badges: string[] = []
  if (caps.supportsVision) badges.push('<span class="cap-badge cap-yes" title="Model supports image input">&#x1f441; Vision</span>')
  else badges.push('<span class="cap-badge cap-no" title="Model does not support images">Vision</span>')
  if (caps.supportsReasoning) badges.push('<span class="cap-badge cap-yes" title="Model supports reasoning/thinking">&#x1f9e0; Reasoning</span>')
  if ((caps as unknown as Record<string, unknown>).contextWindowTokens) {
    const ctx = (caps as unknown as Record<string, number>).contextWindowTokens
    const label = ctx >= 1024 ? `${Math.round(ctx / 1024)}K` : `${ctx}`
    badges.push(`<span class="cap-badge cap-info" title="Context window">${label} ctx</span>`)
  }
  if (badges.length === 0) return '<div id="capability-badges" class="capability-badges"></div>'
  return `<div id="capability-badges" class="capability-badges">${badges.join('')}</div>`
}

/** Render model <option> elements, always including the saved selection even if not in the hardcoded list. */
function renderModelOptions(models: string[], selected?: string): string {
  // If saved model isn't in the list, prepend it so it stays selected
  const list = selected && !models.includes(selected)
    ? [selected, ...models]
    : models
  return list.map(m =>
    `<option value="${m}" ${m === selected ? 'selected' : ''}>${m}</option>`
  ).join('')
}

function renderGeminiModelOptions(selected?: string): string {
  return renderModelOptions([
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.5-pro-preview-03-25',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ], selected)
}

function renderOpenAIModelOptions(selected?: string): string {
  return renderModelOptions(['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini', 'o4-mini'], selected)
}

function renderAnthropicModelOptions(selected?: string): string {
  return renderModelOptions(['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'], selected)
}

function wireProviderToggle(container: HTMLElement): void {
  const select = container.querySelector('#active-provider') as HTMLSelectElement
  select.addEventListener('change', () => {
    const provider = select.value
    container.querySelectorAll<HTMLElement>('.provider-section').forEach(el => {
      el.style.display = 'none'
    })
    const target = container.querySelector(`#section-${provider}`) as HTMLElement
    if (target) target.style.display = ''
  })
}

function wireSTTProviderToggle(container: HTMLElement): void {
  const select = container.querySelector('#stt-provider') as HTMLSelectElement
  if (!select) return
  select.addEventListener('change', () => {
    const group = container.querySelector('#whisper-endpoint-group') as HTMLElement
    if (group) group.style.display = select.value === 'whisper-local' ? '' : 'none'
  })
}

function wireSettingsEvents(container: HTMLElement, s: Settings): void {
  container.querySelector('#btn-test-connection')?.addEventListener('click', async () => {
    const rawUrl = (container.querySelector('#lm-url') as HTMLInputElement).value.trim()
    const url = normalizeLocalUrl(rawUrl)
    // Auto-fix the input field if user entered /v1
    if (rawUrl !== url) (container.querySelector('#lm-url') as HTMLInputElement).value = url
    const token = (container.querySelector('#auth-token') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#connection-status') as HTMLElement
    const testBtn = container.querySelector('#btn-test-connection') as HTMLButtonElement
    statusEl.textContent = 'Testing...'
    statusEl.style.color = ''
    testBtn.disabled = true
    testBtn.textContent = 'Testing...'
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.MODELS_LIST, url, authToken: token }) as { ok: boolean; models: string[] }
      if (res.models?.length > 0) {
        statusEl.textContent = `Connected! ${res.models.length} model(s) available.`
        statusEl.style.color = 'var(--color-success)'
        // Auto-populate model dropdown
        const select = container.querySelector('#lm-model') as HTMLSelectElement
        select.innerHTML = res.models.map(m =>
          `<option value="${esc(m)}" ${m === s.lmStudioModel ? 'selected' : ''}>${esc(m)}</option>`
        ).join('')
        // Also probe capabilities and update the status bar
        const probe = await chrome.runtime.sendMessage({ type: MSG.PROBE_ENDPOINT, url, authToken: token || undefined }) as { ok: boolean; capabilities?: APICapabilities }
        if (probe.ok && probe.capabilities) {
          await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, partial: { apiCapabilities: probe.capabilities } })
          const probeEl = container.querySelector('#probe-status') as HTMLElement
          if (probeEl) {
            probeEl.textContent = `Detected: ${probe.capabilities.serverType}, ${probe.capabilities.availableModels.length} models, format: ${probe.capabilities.apiFormat}`
            probeEl.style.color = 'var(--color-success)'
          }
          // Update the header status
          const infoBar = container.querySelector('#connection-info-bar') as HTMLElement
          if (infoBar) {
            infoBar.className = 'connection-info'
            infoBar.innerHTML = `<span class="connection-badge connected">Connected</span><span class="hint-text" id="provider-status">${esc(probe.capabilities.serverType)} · ${res.models.length} model(s) · ${esc(probe.capabilities.apiFormat)}</span>`
          }
          // Update capability badges
          const badgesEl = container.querySelector('#capability-badges') as HTMLElement
          if (badgesEl) {
            badgesEl.outerHTML = renderCapabilityBadges(probe.capabilities)
          }
        }
      } else {
        statusEl.innerHTML = 'Could not connect. Make sure your server is running and the URL is correct.<br><small>Expected: <code>http://localhost:1234</code> (no <code>/v1</code> suffix)</small>'
        statusEl.style.color = 'var(--color-error)'
      }
    } catch (e) {
      statusEl.textContent = `Connection failed: ${e instanceof Error ? e.message : String(e)}`
      statusEl.style.color = 'var(--color-error)'
    } finally {
      testBtn.disabled = false
      testBtn.textContent = 'Test'
    }
  })

  container.querySelector('#btn-refresh-models')?.addEventListener('click', async () => {
    const url = normalizeLocalUrl((container.querySelector('#lm-url') as HTMLInputElement).value.trim())
    const token = (container.querySelector('#auth-token') as HTMLInputElement).value.trim()
    const res = await chrome.runtime.sendMessage({ type: MSG.MODELS_LIST, url, authToken: token }) as { ok: boolean; models: string[] }
    const select = container.querySelector('#lm-model') as HTMLSelectElement
    select.innerHTML = res.models.map(m =>
      `<option value="${esc(m)}" ${m === s.lmStudioModel ? 'selected' : ''}>${esc(m)}</option>`
    ).join('') || '<option value="">No models found</option>'
  })

  container.querySelector('#btn-re-probe')?.addEventListener('click', async () => {
    const url = normalizeLocalUrl((container.querySelector('#lm-url') as HTMLInputElement).value.trim())
    const token = (container.querySelector('#auth-token') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#probe-status') as HTMLElement
    statusEl.textContent = 'Probing...'
    statusEl.style.color = ''
    const res = await chrome.runtime.sendMessage({ type: MSG.PROBE_ENDPOINT, url, authToken: token || undefined }) as { ok: boolean; capabilities?: APICapabilities; error?: string }
    if (res.ok && res.capabilities) {
      statusEl.textContent = `Detected: ${res.capabilities.serverType}, ${res.capabilities.availableModels.length} models, format: ${res.capabilities.apiFormat}`
      statusEl.style.color = 'var(--color-success)'
      await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, partial: { apiCapabilities: res.capabilities } })
      // Update the header bar
      const infoBar = container.querySelector('#connection-info-bar') as HTMLElement
      if (infoBar) {
        infoBar.className = 'connection-info'
        infoBar.innerHTML = `<span class="connection-badge connected">Connected</span><span class="hint-text" id="provider-status">${esc(res.capabilities.serverType)} · ${res.capabilities.availableModels.length} model(s) · ${esc(res.capabilities.apiFormat)}</span>`
      }
      // Update capability badges
      const badgesEl = container.querySelector('#capability-badges') as HTMLElement
      if (badgesEl) {
        badgesEl.outerHTML = renderCapabilityBadges(res.capabilities)
      }
    } else {
      statusEl.textContent = `Failed: ${res.error || 'Unknown'}`
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-test-gemini')?.addEventListener('click', async () => {
    const apiKey = (container.querySelector('#gemini-api-key') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#gemini-status') as HTMLElement
    if (!apiKey) { statusEl.textContent = 'Enter an API key first.'; statusEl.style.color = 'var(--color-error)'; return }
    statusEl.textContent = 'Testing...'
    const res = await chrome.runtime.sendMessage({ type: MSG.GEMINI_MODELS, apiKey }) as { ok: boolean; models?: string[]; error?: string }
    if (res.ok && res.models && res.models.length > 0) {
      statusEl.textContent = `Connected! ${res.models.length} models available.`
      statusEl.style.color = 'var(--color-success)'
    } else {
      statusEl.textContent = res.error || 'Could not connect. Check your API key.'
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-refresh-gemini-models')?.addEventListener('click', async () => {
    const apiKey = (container.querySelector('#gemini-api-key') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#gemini-status') as HTMLElement
    if (!apiKey) { statusEl.textContent = 'Enter an API key first.'; statusEl.style.color = 'var(--color-error)'; return }
    statusEl.textContent = 'Loading models...'
    const res = await chrome.runtime.sendMessage({ type: MSG.GEMINI_MODELS, apiKey }) as { ok: boolean; models?: string[] }
    const select = container.querySelector('#gemini-model') as HTMLSelectElement
    if (res.ok && res.models && res.models.length > 0) {
      const current = select.value
      select.innerHTML = res.models.map(m =>
        `<option value="${esc(m)}" ${m === current ? 'selected' : ''}>${esc(m)}</option>`
      ).join('')
      statusEl.textContent = `${res.models.length} models loaded.`
      statusEl.style.color = 'var(--color-success)'
    } else {
      statusEl.textContent = 'No models found.'
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-test-openai')?.addEventListener('click', async () => {
    const apiKey = (container.querySelector('#openai-api-key') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#openai-status') as HTMLElement
    if (!apiKey) { statusEl.textContent = 'Enter an API key first.'; statusEl.style.color = 'var(--color-error)'; return }
    statusEl.textContent = 'Testing...'
    statusEl.style.color = ''
    try {
      const res = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': `Bearer ${apiKey}` } })
      if (res.ok) {
        const data = await res.json()
        const count = data?.data?.length ?? 0
        statusEl.textContent = `Connected! ${count} models available.`
        statusEl.style.color = 'var(--color-success)'
      } else {
        const text = await res.text()
        statusEl.textContent = `Error ${res.status}: ${text.slice(0, 100)}`
        statusEl.style.color = 'var(--color-error)'
      }
    } catch (e) {
      statusEl.textContent = `Connection failed: ${e instanceof Error ? e.message : String(e)}`
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-test-anthropic')?.addEventListener('click', async () => {
    const apiKey = (container.querySelector('#anthropic-api-key') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#anthropic-status') as HTMLElement
    if (!apiKey) { statusEl.textContent = 'Enter an API key first.'; statusEl.style.color = 'var(--color-error)'; return }
    statusEl.textContent = 'Testing...'
    statusEl.style.color = ''
    try {
      const model = (container.querySelector('#anthropic-model') as HTMLSelectElement).value || 'claude-3-5-haiku-20241022'
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      })
      if (res.ok) {
        statusEl.textContent = 'Connected! API key is valid.'
        statusEl.style.color = 'var(--color-success)'
      } else {
        const text = await res.text()
        statusEl.textContent = `Error ${res.status}: ${text.slice(0, 100)}`
        statusEl.style.color = 'var(--color-error)'
      }
    } catch (e) {
      statusEl.textContent = `Connection failed: ${e instanceof Error ? e.message : String(e)}`
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-save-settings')?.addEventListener('click', async () => {
    const rawLocalUrl = (container.querySelector('#lm-url') as HTMLInputElement).value.trim()
    const partial: Partial<Settings> = {
      activeProvider: (container.querySelector('#active-provider') as HTMLSelectElement).value as Settings['activeProvider'],
      lmStudioUrl: normalizeLocalUrl(rawLocalUrl),
      lmStudioModel: (container.querySelector('#lm-model') as HTMLSelectElement).value,
      authToken: (container.querySelector('#auth-token') as HTMLInputElement).value.trim(),
      rateLimitRpm: Number((container.querySelector('#rate-limit') as HTMLInputElement).value),
      maxContextMessages: Number((container.querySelector('#ctx-window') as HTMLInputElement).value),
      contextWindowTokens: Number((container.querySelector('#ctx-tokens') as HTMLInputElement).value),
      liteMode: (container.querySelector('#lite-mode') as HTMLInputElement).checked,
      geminiApiKey: (container.querySelector('#gemini-api-key') as HTMLInputElement).value.trim(),
      geminiModel: (container.querySelector('#gemini-model') as HTMLSelectElement).value,
      openaiApiKey: (container.querySelector('#openai-api-key') as HTMLInputElement).value.trim(),
      openaiModel: (container.querySelector('#openai-model') as HTMLSelectElement).value,
      anthropicApiKey: (container.querySelector('#anthropic-api-key') as HTMLInputElement).value.trim(),
      anthropicModel: (container.querySelector('#anthropic-model') as HTMLSelectElement).value,
      monitoringEnabled: (container.querySelector('#monitoring-enabled') as HTMLInputElement).checked,
      visionEnabled: (container.querySelector('#vision-enabled') as HTMLInputElement).checked,
      screenshotIntervalSec: Number((container.querySelector('#screenshot-interval') as HTMLInputElement).value),
      textRewriteEnabled: (container.querySelector('#text-rewrite-enabled') as HTMLInputElement).checked,
      safetyBorderEnabled: (container.querySelector('#safety-border-enabled') as HTMLInputElement).checked,
      composeAssistantEnabled: (container.querySelector('#compose-assistant-enabled') as HTMLInputElement).checked,
      aiActionLearningEnabled: (container.querySelector('#ai-action-learning-enabled') as HTMLInputElement).checked,
      automationPreference: (container.querySelector('#automation-preference') as HTMLSelectElement).value as 'ask' | 'auto' | 'guided',
      learningSnapshotIntervalSec: Number((container.querySelector('#learning-interval') as HTMLInputElement).value),
      calendarDetectionEnabled: (container.querySelector('#calendar-detection') as HTMLInputElement).checked,
      sttProvider: (container.querySelector('#stt-provider') as HTMLSelectElement).value as Settings['sttProvider'],
      whisperEndpoint: (container.querySelector('#whisper-endpoint') as HTMLInputElement).value.trim(),
      mempalaceBridgeEnabled: (container.querySelector('#mempalace-enabled') as HTMLInputElement).checked,
      mempalaceBridgeUrl: (container.querySelector('#mempalace-url') as HTMLInputElement).value.trim(),
      mempalaceWing: (container.querySelector('#mempalace-wing') as HTMLInputElement).value.trim() || undefined,
      localMemoryEnabled: (container.querySelector('#local-memory-enabled') as HTMLInputElement).checked,
      localMemoryMaxEntries: Number((container.querySelector('#local-memory-max') as HTMLInputElement).value),
      inputJournalEnabled: (container.querySelector('#input-journal-enabled') as HTMLInputElement).checked,
      autoCollectEnabled: (container.querySelector('#auto-collect-enabled') as HTMLInputElement).checked,
      autoCollectMinFields: Number((container.querySelector('#auto-collect-min-fields') as HTMLInputElement).value),
      autoCollectExcludeDomains: (container.querySelector('#auto-collect-exclude') as HTMLInputElement).value
        .split(',').map(d => d.trim()).filter(Boolean),
      telegramBotEnabled: (container.querySelector('#telegram-enabled') as HTMLInputElement).checked,
      telegramBotToken: (container.querySelector('#telegram-token') as HTMLInputElement).value.trim() || undefined,
      telegramPollIntervalSec: Number((container.querySelector('#telegram-poll-interval') as HTMLInputElement).value),
      telegramAllowedChatIds: (container.querySelector('#telegram-chat-ids') as HTMLInputElement).value
        .split(',').map(s => s.trim()).filter(Boolean),
      vaultLockTimeoutMin: Number((container.querySelector('#vault-lock-timeout') as HTMLInputElement).value),
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
      a.download = `orion-memory-${new Date().toISOString().slice(0, 10)}.json`
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

  container.querySelector('#btn-mempalace-probe')?.addEventListener('click', async () => {
    const url = (container.querySelector('#mempalace-url') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#mempalace-status') as HTMLElement
    statusEl.textContent = 'Testing…'
    statusEl.style.color = ''
    const res = await chrome.runtime.sendMessage({ type: MSG.MEMPALACE_PROBE, url }) as {
      ok: boolean
      mempalaceInstalled?: boolean
      palacePath?: string
      error?: string
    }
    if (res.ok) {
      const mp = res.mempalaceInstalled ? 'mempalace package OK' : 'bridge up; pip install mempalace if search fails'
      statusEl.textContent = `${mp}${res.palacePath ? ` · ${res.palacePath}` : ''}`
      statusEl.style.color = 'var(--color-success)'
    } else {
      statusEl.textContent = res.error || 'Unreachable. Is the bridge running?'
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-mempalace-inbox')?.addEventListener('click', async () => {
    const url = (container.querySelector('#mempalace-url') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#mempalace-status') as HTMLElement
    if (!url) {
      statusEl.textContent = 'Set bridge URL first.'
      statusEl.style.color = 'var(--color-error)'
      return
    }
    statusEl.textContent = 'Pushing to palace…'
    const res = await chrome.runtime.sendMessage({ type: MSG.MEMPALACE_PUSH_INBOX, url }) as {
      ok: boolean
      stored?: number
      error?: string
    }
    if (res.ok) {
      statusEl.textContent = `Stored ${res.stored ?? 0} entries in MemPalace.`
      statusEl.style.color = 'var(--color-success)'
    } else {
      statusEl.textContent = res.error || 'Failed'
      statusEl.style.color = 'var(--color-error)'
    }
  })

  // ── Local Memory buttons ──────────────────────────────────────────────────
  container.querySelector('#btn-local-memory-stats')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#local-memory-status') as HTMLElement
    statusEl.textContent = 'Loading...'
    const res = await chrome.runtime.sendMessage({ type: 'LOCAL_MEMORY_STATS' }) as {
      ok: boolean; total?: number; byCategory?: Record<string, number>
    }
    if (res.ok) {
      const cats = res.byCategory ? Object.entries(res.byCategory).map(([k, v]) => `${k}: ${v}`).join(', ') : 'none'
      statusEl.textContent = `${res.total ?? 0} entries (${cats})`
      statusEl.style.color = 'var(--color-success)'
    } else {
      statusEl.textContent = 'Could not load stats'
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#btn-clear-local-memory')?.addEventListener('click', async () => {
    if (!confirm('Clear all local memory entries? This cannot be undone.')) return
    const statusEl = container.querySelector('#local-memory-status') as HTMLElement
    await chrome.runtime.sendMessage({ type: 'LOCAL_MEMORY_CLEAR' })
    statusEl.textContent = 'Local memory cleared.'
    statusEl.style.color = 'var(--color-success)'
  })

  // ── Telegram bot buttons ───────────────────────────────────────────────────
  container.querySelector('#btn-test-telegram')?.addEventListener('click', async () => {
    const token = (container.querySelector('#telegram-token') as HTMLInputElement).value.trim()
    const statusEl = container.querySelector('#telegram-status') as HTMLElement
    if (!token) { statusEl.textContent = 'Enter a bot token first.'; statusEl.style.color = 'var(--color-error)'; return }
    statusEl.textContent = 'Testing...'
    statusEl.style.color = ''
    const res = await chrome.runtime.sendMessage({ type: 'TELEGRAM_TEST', token }) as {
      ok: boolean; botName?: string; error?: string
    }
    if (res.ok) {
      statusEl.textContent = `Connected! Bot: ${res.botName}`
      statusEl.style.color = 'var(--color-success)'
    } else {
      statusEl.textContent = res.error || 'Invalid token'
      statusEl.style.color = 'var(--color-error)'
    }
  })

  container.querySelector('#telegram-enabled')?.addEventListener('change', async () => {
    const enabled = (container.querySelector('#telegram-enabled') as HTMLInputElement).checked
    await chrome.runtime.sendMessage({ type: 'TELEGRAM_TOGGLE', enabled })
  })

  // ── Privacy Policy link ───────────────────────────────────────────────────
  container.querySelector('#btn-privacy-policy')?.addEventListener('click', (e) => {
    e.preventDefault()
    void chrome.tabs.create({ url: chrome.runtime.getURL('privacy-policy.html'), active: true })
  })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
