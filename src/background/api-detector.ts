/**
 * API Detector — probes a user-provided endpoint to discover which APIs
 * and capabilities are available (OpenAI, Anthropic, vision, embeddings).
 *
 * Supports LM Studio, Ollama, vLLM, text-generation-webui, and any
 * OpenAI- or Anthropic-compatible server.
 */

export interface APICapabilities {
  baseUrl: string                 // normalized (no trailing slash)
  authToken?: string
  apiFormat: 'openai' | 'anthropic' | 'both'
  supportsVision: boolean
  supportsEmbeddings: boolean
  supportsStreaming: boolean
  availableModels: ModelInfo[]
  defaultModel: string
  serverType: string              // e.g. "LM Studio", "Ollama", "Unknown"
  probedAt: number
}

export interface ModelInfo {
  id: string
  name: string
  supportsVision: boolean
  contextLength?: number
}

interface ProbeResult {
  openaiModels: boolean
  openaiChat: boolean
  anthropicMessages: boolean
  embeddings: boolean
  models: ModelInfo[]
  serverType: string
}

// ─── Probing ──────────────────────────────────────────────────────────────────

export async function probeEndpoint(
  rawUrl: string,
  authToken?: string
): Promise<APICapabilities> {
  const baseUrl = normalizeUrl(rawUrl)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
    headers['x-api-key'] = authToken // Anthropic style
  }

  const result: ProbeResult = {
    openaiModels: false,
    openaiChat: false,
    anthropicMessages: false,
    embeddings: false,
    models: [],
    serverType: 'Unknown',
  }

  // Probe in parallel for speed
  const [modelsResult, chatResult, anthropicResult, embeddingsResult] = await Promise.allSettled([
    probeOpenAIModels(baseUrl, headers),
    probeOpenAIChat(baseUrl, headers),
    probeAnthropicMessages(baseUrl, headers),
    probeEmbeddings(baseUrl, headers),
  ])

  // Process models
  if (modelsResult.status === 'fulfilled' && modelsResult.value) {
    result.openaiModels = true
    result.models = modelsResult.value.models
    result.serverType = modelsResult.value.serverType
  }

  // Process chat completions
  if (chatResult.status === 'fulfilled' && chatResult.value) {
    result.openaiChat = true
  }

  // Process Anthropic messages
  if (anthropicResult.status === 'fulfilled' && anthropicResult.value) {
    result.anthropicMessages = true
  }

  // Process embeddings
  if (embeddingsResult.status === 'fulfilled' && embeddingsResult.value) {
    result.embeddings = true
  }

  // Detect vision support from model names/IDs
  const visionKeywords = [
    'vision', 'llava', 'bakllava', 'cogvlm', 'qwen-vl', 'qwen2-vl',
    'minicpm-v', 'internvl', 'phi-3-vision', 'gemma-3', 'pixtral',
    'gpt-4o', 'gpt-4-turbo', 'claude-3', 'molmo', 'obsidian',
  ]
  for (const m of result.models) {
    const lower = m.id.toLowerCase()
    if (visionKeywords.some(kw => lower.includes(kw))) {
      m.supportsVision = true
    }
  }

  const hasVisionModel = result.models.some(m => m.supportsVision)

  // Determine API format
  let apiFormat: APICapabilities['apiFormat'] = 'openai'
  if (result.anthropicMessages && result.openaiChat) apiFormat = 'both'
  else if (result.anthropicMessages && !result.openaiChat) apiFormat = 'anthropic'

  // Pick default model
  const defaultModel = pickDefaultModel(result.models)

  return {
    baseUrl,
    authToken,
    apiFormat,
    supportsVision: hasVisionModel,
    supportsEmbeddings: result.embeddings,
    supportsStreaming: true, // assume yes, nearly all servers support it
    availableModels: result.models,
    defaultModel,
    serverType: result.serverType,
    probedAt: Date.now(),
  }
}

// ─── Individual probes ────────────────────────────────────────────────────────

async function probeOpenAIModels(
  baseUrl: string,
  headers: Record<string, string>
): Promise<{ models: ModelInfo[]; serverType: string } | null> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { headers }, 5000)
    if (!res.ok) return null

    const json = await res.json() as {
      data?: Array<{ id: string; object?: string; owned_by?: string; meta?: Record<string, unknown> }>
    }
    if (!json.data || !Array.isArray(json.data)) return null

    // Detect server type from response patterns
    let serverType = 'Unknown'
    const firstModel = json.data[0]
    if (firstModel?.owned_by === 'lmstudio-community' || firstModel?.owned_by?.includes('lmstudio')) {
      serverType = 'LM Studio'
    } else if (firstModel?.owned_by === 'ollama' || firstModel?.owned_by?.includes('library')) {
      serverType = 'Ollama'
    } else if (firstModel?.object === 'model') {
      serverType = 'OpenAI-Compatible'
    }

    const models: ModelInfo[] = json.data.map(m => ({
      id: m.id,
      name: m.id.split('/').pop() ?? m.id,
      supportsVision: false, // will be updated by keyword check
    }))

    return { models, serverType }
  } catch {
    return null
  }
}

async function probeOpenAIChat(
  baseUrl: string,
  headers: Record<string, string>
): Promise<boolean> {
  try {
    // Send a minimal request to see if the endpoint accepts it
    const res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
        stream: false,
      }),
    }, 8000)

    // 200 = works, 404 = endpoint doesn't exist, 4xx = exists but bad request (which means it exists!)
    return res.status !== 404 && res.status !== 405
  } catch {
    return false
  }
}

async function probeAnthropicMessages(
  baseUrl: string,
  headers: Record<string, string>
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      }),
    }, 8000)

    return res.status !== 404 && res.status !== 405
  } catch {
    return false
  }
}

async function probeEmbeddings(
  baseUrl: string,
  headers: Record<string, string>
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'test', input: 'test' }),
    }, 5000)

    return res.status !== 404 && res.status !== 405
  } catch {
    return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(raw: string): string {
  let url = raw.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`
  }
  // Remove trailing /v1, /v1/, trailing slashes
  url = url.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  return url
}

function pickDefaultModel(models: ModelInfo[]): string {
  if (models.length === 0) return ''
  // Prefer vision models, then largest/first
  const vision = models.find(m => m.supportsVision)
  if (vision) return vision.id
  return models[0].id
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 5000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Quick connectivity check — just hits /v1/models. */
export async function quickHealthCheck(baseUrl: string, authToken?: string): Promise<boolean> {
  const headers: Record<string, string> = {}
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`
  try {
    const res = await fetchWithTimeout(`${normalizeUrl(baseUrl)}/v1/models`, { headers }, 3000)
    return res.ok
  } catch {
    return false
  }
}
