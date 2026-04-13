export type AttachmentKind = 'text' | 'image' | 'pdf' | 'binary'

interface PdfJsModule {
  getDocument: (src: Record<string, unknown>) => {
    promise: Promise<{
      numPages: number
      getPage: (pageNumber: number) => Promise<{
        getTextContent: () => Promise<{
          items: Array<{ str?: string }>
        }>
      }>
      destroy?: () => Promise<void> | void
    }>
    destroy?: () => Promise<void> | void
  }
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'svg',
  'log', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'rb', 'php', 'java', 'kt', 'go', 'rs', 'swift',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'graphql', 'gql',
  'css', 'scss', 'sass', 'less',
  'vue', 'svelte', 'astro',
  'dockerfile', 'makefile',
])

const TEXT_ATTACHMENT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|x-typescript)|.*\+(json|xml)$)/i
const CSV_LIKE_MIME_RE = /(csv|yaml|toml|sql|graphql)/i

const DEFAULT_FILE_ANALYSIS_PROMPT = 'Analyze this attached file and tell me what matters.'
const DEFAULT_IMAGE_ANALYSIS_PROMPT = 'Describe this attached image and extract the important details.'
const MAX_INLINE_ATTACHMENT_CHARS = 50_000
const MAX_PDF_PAGES = 20

let pdfJsModulesPromise: Promise<PdfJsModule> | null = null

export const ATTACHMENT_FILE_INPUT_ACCEPT = [
  'image/*',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml',
  '.html', '.htm', '.svg', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.php', '.java', '.kt', '.go', '.rs', '.swift',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.gql',
  '.css', '.scss', '.sass', '.less',
  '.vue', '.svelte', '.astro',
  '.pdf',
].join(',')

export interface OutgoingChatText {
  requestText: string
  displayText: string
  usedAutoPrompt: boolean
}

export interface PdfExtractionResult {
  text: string
  pageCount: number
  truncated: boolean
}

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulesPromise) {
    pdfJsModulesPromise = (async () => {
      const [pdfjs, workerModule] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
      ])
      ;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker ||= workerModule
      return pdfjs as unknown as PdfJsModule
    })()
  }

  return pdfJsModulesPromise
}

export async function extractPdfText(file: File): Promise<PdfExtractionResult> {
  const pdfjs = await loadPdfJs()
  const arrayBuffer = await file.arrayBuffer()
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(arrayBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    stopAtErrors: false,
  })

  try {
    const pdf = await loadingTask.promise
    const pageLimit = Math.min(pdf.numPages, MAX_PDF_PAGES)
    const textChunks: string[] = []
    let totalLength = 0
    let truncated = pdf.numPages > pageLimit

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const pageText = textContent.items
        .map(item => item.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (!pageText) continue

      const prefixed = `[Page ${pageNumber}] ${pageText}`
      if (totalLength + prefixed.length > MAX_INLINE_ATTACHMENT_CHARS) {
        const remaining = Math.max(0, MAX_INLINE_ATTACHMENT_CHARS - totalLength)
        if (remaining > 0) textChunks.push(prefixed.slice(0, remaining))
        truncated = true
        break
      }

      textChunks.push(prefixed)
      totalLength += prefixed.length + 2
    }

    const text = textChunks.join('\n\n').trim()
    if (!text) {
      throw new Error('PDF text extraction returned no readable text')
    }

    return {
      text,
      pageCount: pdf.numPages,
      truncated,
    }
  } finally {
    await loadingTask.destroy?.()
  }
}

export function inferAttachmentKind(fileName: string, mimeType: string): AttachmentKind {
  const normalizedMime = mimeType.trim().toLowerCase()
  const normalizedName = fileName.trim().toLowerCase()
  const ext = normalizedName.split('.').pop() ?? ''

  if (normalizedMime.startsWith('image/')) return 'image'
  if (normalizedMime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (TEXT_ATTACHMENT_MIME_RE.test(normalizedMime) || CSV_LIKE_MIME_RE.test(normalizedMime)) return 'text'
  if (TEXT_ATTACHMENT_EXTENSIONS.has(ext) || normalizedName === 'dockerfile' || normalizedName === 'makefile') return 'text'

  return 'binary'
}

export function buildAttachmentPlaceholder(fileName: string, mimeType: string, sizeBytes: number, kind: 'pdf' | 'binary'): string {
  if (kind === 'pdf') {
    return `[PDF attachment: ${fileName}]
MIME type: ${mimeType || 'application/pdf'}
Size: ${sizeBytes} bytes
Full PDF text extraction is not available inside Orion yet.
Analyze this attachment using its metadata only and tell the user to open the PDF in a tab or paste the relevant text for deeper analysis.`
  }

  return `[Binary attachment: ${fileName}]
MIME type: ${mimeType || 'application/octet-stream'}
Size: ${sizeBytes} bytes
Binary content is not inline-readable in Orion.
Analyze based on metadata only and tell the user to upload a text extract, code file, screenshot, or copied content if they need deeper analysis.`
}

export function buildOutgoingChatText(params: {
  text: string
  fileName?: string | null
  fileContext?: string | null
  hasImage?: boolean
}): OutgoingChatText {
  const rawText = params.text.trim()
  const hasTextAttachment = !!params.fileName && !!params.fileContext
  const displayText = rawText
    || (hasTextAttachment ? DEFAULT_FILE_ANALYSIS_PROMPT : (params.hasImage ? DEFAULT_IMAGE_ANALYSIS_PROMPT : ''))

  if (!displayText) {
    return {
      requestText: '',
      displayText: '',
      usedAutoPrompt: false,
    }
  }

  if (!hasTextAttachment) {
    return {
      requestText: displayText,
      displayText,
      usedAutoPrompt: !rawText && !!params.hasImage,
    }
  }

  const filePrefix = `[Attached file: ${params.fileName}]\n\`\`\`\n${params.fileContext!.slice(0, 20_000)}\n\`\`\`\n\n`
  return {
    requestText: `${filePrefix}${displayText}`.trim(),
    displayText,
    usedAutoPrompt: !rawText,
  }
}
