import type { STTProvider } from '../shared/types'
import { MSG, PORT_STT_RELAY } from '../shared/constants'
import { getWebSpeechNetworkBlockedMessage } from '../shared/browser-environment'
import {
  clearMicGrantStorage,
  hasAnyStoredMicGrant,
  persistMicGrantTimestamp,
} from '../shared/mic-permission-storage'

export type TranscriptCallback = (text: string, isFinal: boolean) => void
export type CommandCallback = (command: string) => void
export type ErrorCallback = (error: string) => void

interface SpeechServiceState {
  listening: boolean
  provider: STTProvider
  whisperEndpoint: string
  onTranscript: TranscriptCallback | null
  onCommand: CommandCallback | null
  onError: ErrorCallback | null
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

const state: SpeechServiceState = {
  listening: false,
  provider: 'web-speech',
  whisperEndpoint: '',
  onTranscript: null,
  onCommand: null,
  onError: null,
}

let relayPort: chrome.runtime.Port | null = null
let lastSttDedupeKey = ''
let lastSttErrorAt = 0
const STT_ERROR_DEDUPE_MS = 20_000

/** Same user-facing issue can arrive as `network`, `network:…`, or twice from the relay — dedupe by kind. */
function sttErrorDedupeKey(raw: string, formatted: string): string {
  const r = raw.trim()
  if (r === 'network' || r.startsWith('network:')) return 'stt:webspeech-network'
  if (formatted.includes('online recognition service') && formatted.includes('blocked the connection')) {
    return 'stt:webspeech-network'
  }
  return formatted
}
let whisperRecorder: WhisperRecorder | null = null
let visibleRecognition: BrowserSpeechRecognition | null = null
let usingVisibleWebSpeech = false
let microphonePermissionPrimed = false
let permissionRequestPromise: Promise<void> | null = null

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>) => {
  if (msg.type === MSG.MIC_PERMISSION_RESULT) {
    if (msg.granted === true) {
      void persistMicGrantTimestamp()
      microphonePermissionPrimed = true
      permissionWaiter.resolve?.()
    } else {
      permissionWaiter.reject?.(new Error(String(msg.error ?? 'Microphone permission was not granted')))
    }
    permissionWaiter = {}
  }
})

let permissionWaiter: {
  resolve?: () => void
  reject?: (error: Error) => void
} = {}

// ─── Public API ──────────────────────────────────────────────────────────────

export function configure(provider: STTProvider, whisperEndpoint?: string): void {
  state.provider = provider
  state.whisperEndpoint = whisperEndpoint ?? ''
}

export function onTranscript(cb: TranscriptCallback): void {
  state.onTranscript = cb
}

export function onCommand(cb: CommandCallback): void {
  state.onCommand = cb
}

export function onError(cb: ErrorCallback): void {
  state.onError = cb
}

export function isListening(): boolean {
  return state.listening
}

export async function primeMicrophonePermission(): Promise<void> {
  if (microphonePermissionPrimed) return

  const currentState = await queryMicrophonePermissionState()
  if (currentState === 'granted') {
    microphonePermissionPrimed = true
    return
  }

  if (await hasAnyStoredMicGrant()) {
    if (currentState === 'denied') {
      await clearMicGrantStorage()
    } else {
      microphonePermissionPrimed = true
      return
    }
  }

  if (!permissionRequestPromise) {
    permissionRequestPromise = openPermissionTabAndWait()
      .finally(() => { permissionRequestPromise = null })
  }

  await permissionRequestPromise
}

export async function startListening(): Promise<void> {
  if (state.listening) return

  try {
    if (state.provider === 'whisper-local') {
      const stream = await acquireMicrophoneStream()
      await startWhisperListening(stream)
    } else {
      await primeMicrophonePermission()
      if (isVisibleWebSpeechAvailable()) {
        startVisibleWebSpeech()
      } else {
        await startWebSpeechViaOffscreen()
      }
    }
    state.listening = true
  } catch (err) {
    const msg = normalizeMicrophoneError(err)
    state.onError?.(`Failed to start STT: ${msg}`)
    throw new Error(msg)
  }
}

export function stopListening(): void {
  if (!state.listening) return

  if (state.provider === 'whisper-local') {
    stopWhisperListening()
  } else {
    if (usingVisibleWebSpeech) {
      stopVisibleWebSpeech()
    } else {
      stopWebSpeechViaOffscreen()
    }
  }

  state.listening = false
}

// ─── Web Speech via Offscreen Document ───────────────────────────────────────

function isVisibleWebSpeechAvailable(): boolean {
  const scope = window as unknown as Record<string, unknown>
  return Boolean(scope.SpeechRecognition ?? scope.webkitSpeechRecognition)
}

function createVisibleRecognition(): BrowserSpeechRecognition | null {
  const scope = window as unknown as Record<string, unknown>
  const Ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition
  if (!Ctor) return null
  return new (Ctor as { new(): BrowserSpeechRecognition })()
}

function startVisibleWebSpeech(): void {
  visibleRecognition = createVisibleRecognition()
  if (!visibleRecognition) {
    throw new Error('Web Speech API is not available in this panel')
  }

  usingVisibleWebSpeech = true
  let pendingTranscript = ''

  visibleRecognition.continuous = true
  visibleRecognition.interimResults = true
  visibleRecognition.lang = 'en-US'

  visibleRecognition.onresult = (event) => {
    let interimText = ''
    let finalText = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const transcript = result[0].transcript
      if (result.isFinal) {
        finalText += transcript
      } else {
        interimText += transcript
      }
    }

    if (interimText) state.onTranscript?.(interimText, false)

    if (finalText) {
      pendingTranscript += finalText
      state.onTranscript?.(finalText, true)

      if (isDoneCommand(finalText)) {
        const command = pendingTranscript.replace(/\bdone\b[\s.!]*$/i, '').trim()
        if (command) state.onCommand?.(command)
        pendingTranscript = ''
      }
    }
  }

  visibleRecognition.onerror = (event) => {
    const message = event.error ?? 'unknown'
    if (message === 'no-speech' || message === 'aborted') return
    emitFormattedSttError(String(message))
  }

  visibleRecognition.onend = () => {
    if (state.listening && usingVisibleWebSpeech) {
      try { visibleRecognition?.start() } catch { /* already running */ }
    }
  }

  visibleRecognition.start()
}

function stopVisibleWebSpeech(): void {
  usingVisibleWebSpeech = false
  try { visibleRecognition?.stop() } catch { /* not running */ }
  visibleRecognition = null
}

function connectRelayPort(): void {
  if (relayPort) return

  relayPort = chrome.runtime.connect({ name: PORT_STT_RELAY })

  relayPort.onMessage.addListener((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case MSG.STT_TRANSCRIPT_RELAY:
        state.onTranscript?.(msg.text as string, msg.isFinal as boolean)
        break
      case MSG.STT_COMMAND_RELAY:
        state.onCommand?.(msg.command as string)
        break
      case MSG.STT_ERROR_RELAY:
        emitFormattedSttError(String(msg.error))
        break
      case MSG.STT_STATUS_RELAY:
        if (msg.listening === false && state.listening) {
          state.listening = false
        }
        break
    }
  })

  relayPort.onDisconnect.addListener(() => { relayPort = null })
}

async function startWebSpeechViaOffscreen(): Promise<void> {
  connectRelayPort()

  const result = await chrome.runtime.sendMessage({
    type: MSG.STT_START_VIA_OFFSCREEN,
    lang: 'en-US',
  }) as { ok?: boolean; error?: string }

  if (result && !result.ok) {
    throw new Error(result.error ?? 'Failed to start offscreen STT')
  }
}

function stopWebSpeechViaOffscreen(): void {
  chrome.runtime.sendMessage({ type: MSG.STT_STOP_VIA_OFFSCREEN }).catch(() => {})
  try { relayPort?.disconnect() } catch { /* already disconnected */ }
  relayPort = null
}

// ─── Local Whisper Backend ───────────────────────────────────────────────────

class WhisperRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private intervalId: ReturnType<typeof setInterval> | null = null
  private active = false
  private pendingTranscript = ''

  async start(endpoint: string, stream: MediaStream): Promise<void> {
    this.active = true
    this.stream = stream
    this.startRecordingCycle(endpoint)
  }

  stop(): void {
    this.active = false
    if (this.intervalId) clearInterval(this.intervalId)
    this.intervalId = null
    this.recorder?.stop()
    this.recorder = null
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    this.chunks = []
    this.pendingTranscript = ''
  }

  private startRecordingCycle(endpoint: string): void {
    this.recordChunk(endpoint)
    this.intervalId = setInterval(() => this.recordChunk(endpoint), 4000)
  }

  private recordChunk(endpoint: string): void {
    if (!this.active || !this.stream) return

    this.recorder?.stop()
    this.chunks = []

    this.recorder = new MediaRecorder(this.stream, { mimeType: getSupportedMimeType() })
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.onstop = () => {
      if (this.chunks.length > 0 && this.active) {
        const blob = new Blob(this.chunks, { type: this.chunks[0].type })
        this.transcribeChunk(blob, endpoint).catch(console.warn)
      }
    }

    this.recorder.start()
    setTimeout(() => {
      if (this.recorder?.state === 'recording') this.recorder.stop()
    }, 3500)
  }

  private async transcribeChunk(audioBlob: Blob, endpoint: string): Promise<void> {
    const formData = new FormData()
    formData.append('file', audioBlob, 'recording.webm')
    formData.append('model', 'whisper-1')
    formData.append('response_format', 'json')

    try {
      const response = await fetch(`${endpoint}/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) return

      const result = await response.json() as { text?: string }
      const text = result.text?.trim()
      if (!text) return

      this.pendingTranscript += text
      state.onTranscript?.(text, true)

      if (isDoneCommand(text)) {
        const command = this.pendingTranscript.replace(/\bdone\b[\s.!]*$/i, '').trim()
        if (command) state.onCommand?.(command)
        this.pendingTranscript = ''
      }
    } catch (err) {
      console.warn('[SpeechService] Whisper transcription failed:', err)
    }
  }
}

async function startWhisperListening(stream: MediaStream): Promise<void> {
  if (!state.whisperEndpoint) {
    throw new Error('No whisper endpoint configured — set it in Settings > Speech Recognition')
  }
  whisperRecorder = new WhisperRecorder()
  await whisperRecorder.start(state.whisperEndpoint, stream)
}

function stopWhisperListening(): void {
  whisperRecorder?.stop()
  whisperRecorder = null
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function isDoneCommand(text: string): boolean {
  return /\bdone\b[\s.!]*$/i.test(text.trim().toLowerCase())
}

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return 'audio/webm'
}

async function requestVisibleMicrophoneAccess(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser context does not support microphone access')
  }
  return navigator.mediaDevices.getUserMedia({ audio: true })
}

async function queryMicrophonePermissionState(): Promise<PermissionState | 'unsupported'> {
  try {
    if (!navigator.permissions?.query) return 'unsupported'
    const result = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return result.state
  } catch {
    return 'unsupported'
  }
}

async function openPermissionTabAndWait(): Promise<void> {
  const url = chrome.runtime.getURL('permissions/microphone-permission.html')

  return new Promise<void>((resolve, reject) => {
    let pollId: ReturnType<typeof setInterval> | undefined

    const timeoutId = window.setTimeout(() => {
      permissionWaiter = {}
      if (pollId !== undefined) window.clearInterval(pollId)
      reject(new Error('Microphone permission window timed out. Allow the microphone there, then click Learn again.'))
    }, 90_000)

    const safeResolve = (): void => {
      window.clearTimeout(timeoutId)
      if (pollId !== undefined) window.clearInterval(pollId)
      resolve()
    }

    const safeReject = (error: Error): void => {
      window.clearTimeout(timeoutId)
      if (pollId !== undefined) window.clearInterval(pollId)
      reject(error)
    }

    permissionWaiter = {
      resolve: () => {
        safeResolve()
      },
      reject: safeReject,
    }

    pollId = window.setInterval(() => {
      void hasAnyStoredMicGrant().then((ok) => {
        if (!ok) return
        microphonePermissionPrimed = true
        permissionWaiter.resolve?.()
        permissionWaiter = {}
      })
    }, 400)

    void chrome.tabs.create({ url, active: true })
  })
}

async function acquireMicrophoneStream(): Promise<MediaStream> {
  await primeMicrophonePermission()
  // Let the permission tab close / focus return before getUserMedia in this document (avoids dead streams).
  await new Promise<void>((r) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        r()
      })
    })
  })
  const stream = await requestVisibleMicrophoneAccess()
  microphonePermissionPrimed = true
  await persistMicGrantTimestamp()
  return stream
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach(track => track.stop())
}

/**
 * Use from Settings (button click): request mic for this extension, persist grant, release tracks.
 * Chrome remembers allow/deny like a normal site. Does not start STT.
 */
export async function grantMicrophonePermissionInteractive(): Promise<void> {
  try {
    const stream = await acquireMicrophoneStream()
    stopStream(stream)
  } catch (err) {
    throw new Error(normalizeMicrophoneError(err))
  }
}

function normalizeMicrophoneError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/permission dismissed/i.test(raw)) {
    return (
      'Microphone prompt was dismissed without Allow. Open chrome://extensions → this extension → Details, '
      + 'enable Microphone (or click the permission tab the extension opened), then try again.'
    )
  }
  if (/notallowederror|permission denied|denied/i.test(raw)) {
    return 'Microphone access was denied. Allow microphone access for the extension in the permission tab and try again.'
  }
  if (/notfounderror|requested device not found/i.test(raw)) {
    return 'No microphone device was found.'
  }
  return raw
}

function formatWebSpeechErrorMessage(raw: string): string {
  const s = raw.trim()
  if (s === 'network') return getWebSpeechNetworkBlockedMessage()
  if (s.startsWith('network:')) {
    const rest = s.slice('network:'.length).trim()
    return rest || getWebSpeechNetworkBlockedMessage()
  }
  return s
}

function emitFormattedSttError(raw: string): void {
  const formatted = formatWebSpeechErrorMessage(raw.trim())
  const key = sttErrorDedupeKey(raw, formatted)
  const now = Date.now()
  if (key === lastSttDedupeKey && now - lastSttErrorAt < STT_ERROR_DEDUPE_MS) return
  lastSttDedupeKey = key
  lastSttErrorAt = now
  console.warn('[SpeechService] STT error:', raw)
  state.onError?.(formatted)
}
