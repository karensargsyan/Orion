/* eslint-disable @typescript-eslint/no-explicit-any */

import { getWebSpeechNetworkBlockedMessage } from '../shared/browser-environment'

interface OffscreenSpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

const MSG_STT_START = 'STT_OFFSCREEN_START'
const MSG_STT_STOP = 'STT_OFFSCREEN_STOP'
const MSG_STT_TRANSCRIPT = 'STT_TRANSCRIPT_RELAY'
const MSG_STT_COMMAND = 'STT_COMMAND_RELAY'
const MSG_STT_ERROR = 'STT_ERROR_RELAY'
const MSG_STT_STATUS = 'STT_STATUS_RELAY'
const MSG_STT_READY = 'STT_OFFSCREEN_READY'

let recognition: OffscreenSpeechRecognition | null = null
let pendingTranscript = ''
let active = false
/** One automatic retry after first `network` error per STT session. */
let networkRetryCount = 0
/** While true, `onend` must not call `start()` (avoids fighting the scheduled retry). */
let pendingNetworkRetry = false

function networkErrorPayload(): string {
  return `network: ${getWebSpeechNetworkBlockedMessage()}`
}

function createRecognition(): OffscreenSpeechRecognition | null {
  const w = globalThis as Record<string, unknown>
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) return null
  return new (Ctor as { new(): OffscreenSpeechRecognition })()
}

function notifyNetworkFatal(): void {
  if (!active) return
  active = false
  pendingNetworkRetry = false
  chrome.runtime.sendMessage({ type: MSG_STT_ERROR, error: networkErrorPayload() }).catch(() => {})
  chrome.runtime.sendMessage({ type: MSG_STT_STATUS, listening: false }).catch(() => {})
  try {
    recognition?.stop()
  } catch { /* not running */ }
  recognition = null
}

function startSTT(lang: string): void {
  if (active) return

  networkRetryCount = 0
  pendingNetworkRetry = false
  recognition = createRecognition()
  if (!recognition) {
    chrome.runtime.sendMessage({
      type: MSG_STT_ERROR,
      error: 'SpeechRecognition API not available in offscreen document',
    }).catch(() => {})
    return
  }

  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = lang || 'en-US'
  pendingTranscript = ''
  active = true

  recognition.onresult = (event) => {
    let interim = ''
    let final = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i]
      const text = res[0].transcript
      if (res.isFinal) {
        final += text
      } else {
        interim += text
      }
    }

    if (interim) {
      chrome.runtime.sendMessage({ type: MSG_STT_TRANSCRIPT, text: interim, isFinal: false }).catch(() => {})
    }

    if (final) {
      pendingTranscript += final
      chrome.runtime.sendMessage({ type: MSG_STT_TRANSCRIPT, text: final, isFinal: true }).catch(() => {})

      if (isDoneCommand(final)) {
        const command = pendingTranscript.replace(/\bdone\b[\s.!]*$/i, '').trim()
        if (command) {
          chrome.runtime.sendMessage({ type: MSG_STT_COMMAND, command }).catch(() => {})
        }
        pendingTranscript = ''
      }
    }
  }

  recognition.onerror = (event) => {
    const errType = event.error ?? 'unknown'
    if (errType === 'no-speech' || errType === 'aborted') return

    if (errType === 'network') {
      if (networkRetryCount < 1) {
        networkRetryCount += 1
        pendingNetworkRetry = true
        window.setTimeout(() => {
          pendingNetworkRetry = false
          if (!active || !recognition) return
          try {
            recognition.start()
          } catch {
            notifyNetworkFatal()
          }
        }, 1500)
        return
      }
      notifyNetworkFatal()
      return
    }

    const payload = errType
    chrome.runtime.sendMessage({ type: MSG_STT_ERROR, error: payload }).catch(() => {})
  }

  recognition.onend = () => {
    if (!active) return
    if (pendingNetworkRetry) return
    try {
      recognition?.start()
    } catch { /* restart handled */ }
  }

  try {
    recognition.start()
    chrome.runtime.sendMessage({ type: MSG_STT_STATUS, listening: true }).catch(() => {})
  } catch (err) {
    chrome.runtime.sendMessage({
      type: MSG_STT_ERROR,
      error: `Failed to start recognition: ${String(err)}`,
    }).catch(() => {})
    active = false
  }
}

function stopSTT(): void {
  active = false
  pendingNetworkRetry = false
  pendingTranscript = ''
  try {
    recognition?.stop()
  } catch { /* not started */ }
  recognition = null
  chrome.runtime.sendMessage({ type: MSG_STT_STATUS, listening: false }).catch(() => {})
}

function isDoneCommand(text: string): boolean {
  return /\bdone\b[\s.!]*$/i.test(text.trim().toLowerCase())
}

chrome.runtime.onMessage.addListener((msg: { type: string; lang?: string }, _sender, sendResponse) => {
  switch (msg.type) {
    case MSG_STT_START:
      startSTT(msg.lang ?? 'en-US')
      sendResponse({ ok: true })
      break
    case MSG_STT_STOP:
      stopSTT()
      sendResponse({ ok: true })
      break
  }
  return false
})

chrome.runtime.sendMessage({ type: MSG_STT_READY }).catch(() => {})
