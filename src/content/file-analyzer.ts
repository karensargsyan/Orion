/**
 * Safe analysis of in-page file links and blob URLs (attachments).
 * Enforces size and MIME limits; never executes binaries.
 */

export interface FileAnalysisResult {
  ok: boolean
  mime?: string
  sizeBytes?: number
  textExcerpt?: string
  dataUrlForVision?: string
  error?: string
  warning?: string
}

const MAX_TEXT_BYTES = 512 * 1024
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_TEXT_CHARS = 120_000

const BLOCKED_MIME_PREFIXES = [
  'application/x-msdownload',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'application/x-csh',
]

const TEXT_MIME = /^text\/|application\/(json|xml|javascript|x-javascript)|\+xml$|csv/

export async function analyzeFileFromUrl(href: string): Promise<FileAnalysisResult> {
  try {
    const u = new URL(href, location.href)
    if (u.protocol !== 'blob:' && u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'data:') {
      return { ok: false, error: 'Unsupported URL scheme for file analysis' }
    }

    const res = await fetch(href, { credentials: 'include' })
    if (!res.ok) return { ok: false, error: `Fetch failed: ${res.status}` }

    const blob = await res.blob()
    const mime = blob.type || 'application/octet-stream'
    const sizeBytes = blob.size

    for (const p of BLOCKED_MIME_PREFIXES) {
      if (mime.startsWith(p)) {
        return { ok: false, error: 'Blocked file type for security', mime, sizeBytes }
      }
    }

    if (sizeBytes > MAX_IMAGE_BYTES && mime.startsWith('image/')) {
      return { ok: false, error: 'Image too large for analysis', mime, sizeBytes, warning: `Max ${MAX_IMAGE_BYTES} bytes` }
    }

    if (mime.startsWith('image/') && sizeBytes <= MAX_IMAGE_BYTES) {
      const dataUrl = await blobToDataUrl(blob)
      return { ok: true, mime, sizeBytes, dataUrlForVision: dataUrl, textExcerpt: `[Image ${mime}, ${sizeBytes} bytes — attached for vision]` }
    }

    if (TEXT_MIME.test(mime) || mime === 'application/octet-stream') {
      if (sizeBytes > MAX_TEXT_BYTES) {
        return {
          ok: false,
          error: 'Text file too large',
          mime,
          sizeBytes,
          warning: `Max ${MAX_TEXT_BYTES} bytes for text extraction`,
        }
      }
      const text = await blob.text()
      return {
        ok: true,
        mime,
        sizeBytes,
        textExcerpt: text.slice(0, MAX_TEXT_CHARS),
        warning: text.length > MAX_TEXT_CHARS ? 'Truncated to max length' : undefined,
      }
    }

    if (mime === 'application/pdf') {
      return {
        ok: true,
        mime,
        sizeBytes,
        textExcerpt: `[PDF attachment ${sizeBytes} bytes — full text extraction not available in extension; open in tab or copy text if needed]`,
        warning: 'PDF: use page text or external viewer for full content',
      }
    }

    return {
      ok: true,
      mime,
      sizeBytes,
      textExcerpt: `[Binary or unsupported type ${mime}, ${sizeBytes} bytes — not extracted]`,
      warning: 'Non-text type; only metadata summarized',
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export function findAttachmentLinks(): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = []
  document.querySelectorAll<HTMLAnchorElement>('a[href*="attachment"], a[download], a[href^="blob:"]').forEach(a => {
    const href = a.href
    if (!href) return
    out.push({ href, text: (a.textContent?.trim() || a.download || 'file').slice(0, 120) })
  })
  return out.slice(0, 30)
}
