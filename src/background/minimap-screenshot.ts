/**
 * Mini-map screenshot — captures a low-res JPEG with viewport metadata.
 * Optionally resizes via OffscreenCanvas to reduce vision-model token cost.
 */

const MINIMAP_JPEG_QUALITY = 30
const MAX_MINIMAP_WIDTH = 768

export interface MiniMapResult {
  dataUrl: string
  viewport: { width: number; height: number; devicePixelRatio: number }
}

async function getTabViewport(tabId: number): Promise<{ width: number; height: number; devicePixelRatio: number }> {
  try {
    const tab = await chrome.tabs.get(tabId)
    const win = tab.windowId ? await chrome.windows.get(tab.windowId) : null
    return {
      width: win?.width ?? 1280,
      height: win?.height ?? 720,
      devicePixelRatio: globalThis.devicePixelRatio ?? 1,
    }
  } catch {
    return { width: 1280, height: 720, devicePixelRatio: 1 }
  }
}

async function resizeDataUrl(dataUrl: string, maxWidth: number): Promise<string> {
  if (typeof OffscreenCanvas === 'undefined') return dataUrl

  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const bitmap = await createImageBitmap(blob)

  if (bitmap.width <= maxWidth) {
    bitmap.close()
    return dataUrl
  }

  const scale = maxWidth / bitmap.width
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: MINIMAP_JPEG_QUALITY / 100 })
  return blobToDataUrl(resizedBlob)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function captureMiniMap(tabId: number, resize = true): Promise<MiniMapResult | null> {
  try {
    const dataUrl = await captureWithTimeout(tabId, MINIMAP_JPEG_QUALITY)
    if (!dataUrl) return null
    const viewport = await getTabViewport(tabId)
    const finalUrl = resize ? await resizeDataUrl(dataUrl, MAX_MINIMAP_WIDTH).catch(() => dataUrl) : dataUrl
    return { dataUrl: finalUrl, viewport }
  } catch {
    return null
  }
}

export async function captureHighQualityScreenshot(tabId?: number): Promise<string | null> {
  try {
    return await captureWithTimeout(tabId, 60)
  } catch {
    return null
  }
}

/**
 * Ultra-fast low-quality screenshot for automation verification.
 * Quality 20, max 512px width — small enough for fast AI processing.
 */
export async function captureAutomationScreenshot(tabId: number): Promise<MiniMapResult | null> {
  try {
    const dataUrl = await captureWithTimeout(tabId, 20)
    if (!dataUrl) return null
    const viewport = await getTabViewport(tabId)
    const finalUrl = await resizeDataUrl(dataUrl, 512).catch(() => dataUrl)
    return { dataUrl: finalUrl, viewport }
  } catch {
    return null
  }
}

/**
 * Capture screenshot with timeout and CDP fallback.
 * chrome.tabs.captureVisibleTab can fail on restricted pages (chrome://, devtools, etc.)
 * or hang on slow pages. This adds a 5s timeout and falls back to CDP if available.
 */
async function captureWithTimeout(tabId: number | undefined, quality: number, timeoutMs = 5000): Promise<string | null> {
  // First try the standard Chrome API with a timeout
  try {
    const dataUrl = await Promise.race([
      chrome.tabs.captureVisibleTab({ format: 'jpeg', quality }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    if (dataUrl) return dataUrl
  } catch { /* standard capture failed — try CDP fallback */ }

  // CDP fallback: works on more page types and is more reliable
  if (tabId && tabId > 0) {
    try {
      const targets = await chrome.debugger.getTargets()
      const attached = targets.some(t => t.tabId === tabId && t.attached)
      if (attached) {
        const result = await chrome.debugger.sendCommand(
          { tabId },
          'Page.captureScreenshot',
          { format: 'jpeg', quality }
        ) as { data?: string }
        if (result?.data) {
          return `data:image/jpeg;base64,${result.data}`
        }
      }
    } catch { /* CDP not available */ }
  }

  return null
}
