import type { ChatMessage, Settings } from '../shared/types'
import { MSG } from '../shared/constants'
import type { StreamPort } from './ai-client'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

function buildGeminiContents(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[]
): { contents: GeminiContent[]; systemInstruction?: { parts: GeminiPart[] } } {
  let systemInstruction: { parts: GeminiPart[] } | undefined
  const contents: GeminiContent[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      if (!systemInstruction) systemInstruction = { parts: [] }
      systemInstruction.parts.push({ text: m.content })
      continue
    }

    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = [{ text: m.content }]

    if (m.imageData && m.role === 'user') {
      const match = m.imageData.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        const [, mimeType, base64] = match
        // Validate base64: must be reasonable length, correct padding, valid chars
        const isValidBase64 = base64.length > 100 &&
          base64.length < 10_000_000 && // ~7.5MB max raw
          base64.length % 4 === 0
        if (isValidBase64) {
          parts.push({ inlineData: { mimeType, data: base64 } })
        } else {
          console.warn(`[Gemini] Skipping malformed image: length=${base64.length}, padding=${base64.length % 4}`)
        }
      }
    }

    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts.push(...parts)
    } else {
      contents.push({ role, parts })
    }
  }

  return { contents, systemInstruction }
}

export async function streamGemini(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  settings: Settings,
  port: StreamPort,
  controller: AbortController
): Promise<string> {
  const apiKey = settings.geminiApiKey
  if (!apiKey) {
    port.postMessage({ type: MSG.STREAM_ERROR, error: 'Gemini API key not set. Go to Settings to add it.' })
    return ''
  }

  const model = settings.geminiModel || 'gemini-2.0-flash'
  const { contents, systemInstruction } = buildGeminiContents(messages)

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  }
  if (systemInstruction) body.systemInstruction = systemInstruction

  const url = `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  if (!response.ok) {
    const text = await response.text()
    port.postMessage({ type: MSG.STREAM_ERROR, error: `Gemini error ${response.status}: ${text.slice(0, 300)}` })
    return ''
  }

  return parseGeminiSSE(response, port)
}

async function parseGeminiSSE(response: Response, port: StreamPort): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      fullText = processSSELine(line, fullText, port)
    }
  }

  if (buffer.trim()) {
    fullText = processSSELine(buffer, fullText, port)
  }

  port.postMessage({ type: MSG.STREAM_END, fullText })
  return fullText
}

function processSSELine(line: string, fullText: string, port: StreamPort): string {
  if (!line.startsWith('data: ')) return fullText
  const data = line.slice(6).trim()
  if (!data || data === '[DONE]') return fullText

  try {
    const parsed = JSON.parse(data) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = parsed.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
    if (text) {
      port.postMessage({ type: MSG.STREAM_CHUNK, chunk: text })
      return fullText + text
    }
  } catch { /* skip malformed SSE */ }
  return fullText
}

export async function callGemini(
  messages: Pick<ChatMessage, 'role' | 'content' | 'imageData'>[],
  settings: Settings,
  maxTokens = 2048,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = settings.geminiApiKey
  if (!apiKey) return ''

  const model = settings.geminiModel || 'gemini-2.0-flash'
  const { contents, systemInstruction } = buildGeminiContents(messages)

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: maxTokens,
    },
  }
  if (systemInstruction) body.systemInstruction = systemInstruction

  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      try {
        const errBody = await response.text()
        console.warn(`[LocalAI] callGemini error ${response.status}: ${errBody.slice(0, 300)}`)
      } catch {
        console.warn(`[LocalAI] callGemini error: ${response.status} ${response.statusText}`)
      }
      return ''
    }

    const json = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const result = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
    if (!result) console.warn(`[LocalAI] callGemini returned empty content. Candidates: ${JSON.stringify(json.candidates?.length ?? 0)}`)
    return result
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return ''
    console.warn(`[LocalAI] callGemini network error:`, err)
    return ''
  }
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const url = `${GEMINI_BASE}/models?key=${apiKey}`
    const response = await fetch(url)
    if (!response.ok) return []

    const json = await response.json() as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>
    }

    return (json.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
  } catch {
    return []
  }
}
