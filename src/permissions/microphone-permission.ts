import { MSG } from '../shared/constants'
import { persistMicGrantTimestamp } from '../shared/mic-permission-storage'

const statusEl = document.getElementById('status') as HTMLDivElement
const requestBtn = document.getElementById('btn-request') as HTMLButtonElement
const closeBtn = document.getElementById('btn-close') as HTMLButtonElement

void runInitialRequest()

requestBtn.addEventListener('click', () => {
  void requestMicrophoneAccess()
})

closeBtn.addEventListener('click', () => {
  window.close()
})

async function runInitialRequest(): Promise<void> {
  const state = await getPermissionState()
  if (state === 'granted') {
    setStatus('Microphone permission is already granted. You can return to the side panel.', 'success')
    await notifyResult(true)
    closeSoon()
    return
  }
  await requestMicrophoneAccess()
}

async function requestMicrophoneAccess(): Promise<void> {
  setStatus('Chrome/Brave should show a microphone prompt now. Please click Allow.', 'info')

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stopStream(stream)
    setStatus('Microphone permission granted. Returning to the side panel...', 'success')
    await notifyResult(true)
    closeSoon()
  } catch (err) {
    const message = normalizeError(err)
    setStatus(message, 'error')
    await notifyResult(false, message)
  }
}

async function getPermissionState(): Promise<PermissionState | 'unsupported'> {
  try {
    if (!navigator.permissions?.query) return 'unsupported'
    const result = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return result.state
  } catch {
    return 'unsupported'
  }
}

async function notifyResult(granted: boolean, error?: string): Promise<void> {
  if (granted) {
    await persistMicGrantTimestamp()
  }
  await chrome.runtime.sendMessage({
    type: MSG.MIC_PERMISSION_RESULT,
    granted,
    error,
  }).catch(() => {})
}

function setStatus(message: string, kind: 'info' | 'success' | 'error'): void {
  statusEl.textContent = message
  statusEl.className = `status${kind === 'info' ? '' : ` ${kind}`}`
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach(track => track.stop())
}

function closeSoon(): void {
  window.setTimeout(() => window.close(), 900)
}

function normalizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/permission dismissed/i.test(raw)) {
    return 'The browser dismissed the microphone prompt. Please click "Request Microphone" again and choose Allow.'
  }
  if (/denied|notallowederror|permission denied/i.test(raw)) {
    return 'Microphone access was denied. Allow it for this extension and try again.'
  }
  if (/notfounderror|requested device not found/i.test(raw)) {
    return 'No microphone device was found.'
  }
  return `Could not get microphone access: ${raw}`
}
