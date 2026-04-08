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
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: MINIMAP_JPEG_QUALITY })
    const viewport = await getTabViewport(tabId)
    const finalUrl = resize ? await resizeDataUrl(dataUrl, MAX_MINIMAP_WIDTH).catch(() => dataUrl) : dataUrl
    return { dataUrl: finalUrl, viewport }
  } catch {
    return null
  }
}

export async function captureHighQualityScreenshot(): Promise<string | null> {
  try {
    return await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 60 })
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
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 20 })
    const viewport = await getTabViewport(tabId)
    const finalUrl = await resizeDataUrl(dataUrl, 512).catch(() => dataUrl)
    return { dataUrl: finalUrl, viewport }
  } catch {
    return null
  }
}
