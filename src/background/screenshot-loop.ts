import { tabState } from './tab-state'

let intervalId: ReturnType<typeof setInterval> | null = null

export function startScreenshotLoop(intervalSec: number): void {
  stopScreenshotLoop()
  if (intervalSec <= 0) return

  intervalId = setInterval(async () => {
    await captureActiveTab()
  }, intervalSec * 1000)
}

export function stopScreenshotLoop(): void {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

async function captureActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || tab.url?.startsWith('chrome://')) return
    await captureScreenshot(tab.id)
  } catch { /* no active capturable tab */ }
}

export async function captureScreenshot(tabId: number): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 50 })
    tabState.setScreenshot(tabId, dataUrl)
    return dataUrl
  } catch {
    return null
  }
}
