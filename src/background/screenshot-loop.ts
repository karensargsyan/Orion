import { tabState } from './tab-state'
import { recordPageVisit } from './visual-sitemap'

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
    // Feed screenshot to visual sitemap
    const snap = tabState.get(tabId)
    if (snap?.url) {
      try {
        const domain = new URL(snap.url).hostname
        recordPageVisit(domain, snap.url, snap, dataUrl).catch(() => {})
      } catch { /* invalid URL */ }
    }
    return dataUrl
  } catch {
    return null
  }
}

export async function captureForTab(tabId: number): Promise<string | null> {
  return captureScreenshot(tabId)
}
