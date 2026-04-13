/**
 * Real AI Provider — connects to Gemini or LM Studio for real AI testing
 * Usage: USE_REAL_AI=true PROVIDER=gemini npm test
 */
import * as http from 'http'

export type AIProvider = 'gemini' | 'local' | 'openai'

export interface RealAIConfig {
  provider: AIProvider
  geminiApiKey?: string
  lmStudioUrl?: string
  lmStudioModel?: string
  openaiApiKey?: string
  openaiModel?: string
}

export class RealAIProvider {
  private server: http.Server | null = null
  private config: RealAIConfig
  port = 0

  constructor(config: RealAIConfig) {
    this.config = config
    this.validateConfig()
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private validateConfig(): void {
    if (this.config.provider === 'gemini' && !this.config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required when PROVIDER=gemini. Set it in .env file.')
    }
    if (this.config.provider === 'local' && !this.config.lmStudioUrl) {
      throw new Error('LM_STUDIO_URL is required when PROVIDER=local. Set it in .env file.')
    }
    if (this.config.provider === 'openai' && !this.config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required when PROVIDER=openai. Set it in .env file.')
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Collect body
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const bodyStr = Buffer.concat(chunks).toString()
        let body: any = {}
        try { body = JSON.parse(bodyStr) } catch { /* non-JSON */ }

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')
        res.setHeader('Access-Control-Allow-Methods', '*')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        // Model list endpoint
        if (req.url?.includes('/v1/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            object: 'list',
            data: [{ id: 'test-model', object: 'model', owned_by: 'user' }]
          }))
          return
        }

        // Chat completions endpoint — proxy to real AI
        if (req.url?.includes('/chat/completions') || req.url?.includes('/v1/messages')) {
          try {
            const response = await this.proxyToRealAI(body)
            const isStream = body.stream === true

            if (isStream) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
              })
              // Stream the response
              for await (const chunk of response) {
                res.write(chunk)
              }
              res.end()
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(response))
            }
          } catch (error: any) {
            console.error('[RealAI] Error:', error.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: error.message } }))
          }
          return
        }

        // Default: 404
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      })

      // Listen on a random available port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' ? addr!.port : 0
        console.log(`[RealAI] Provider: ${this.config.provider}, Port: ${this.port}`)
        resolve()
      })

      this.server.on('error', reject)
    })
  }

  private async proxyToRealAI(body: any): Promise<any> {
    if (this.config.provider === 'gemini') {
      return this.callGemini(body)
    } else if (this.config.provider === 'local') {
      return this.callLMStudio(body)
    } else if (this.config.provider === 'openai') {
      return this.callOpenAI(body)
    }
    throw new Error(`Unknown provider: ${this.config.provider}`)
  }

  private async callGemini(body: any): Promise<any> {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    const genAI = new GoogleGenerativeAI(this.config.geminiApiKey!)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' })

    // Convert OpenAI-style messages to Gemini format
    const messages = body.messages || []
    const systemMessage = messages.find((m: any) => m.role === 'system')
    const userMessages = messages.filter((m: any) => m.role !== 'system')

    const prompt = userMessages.map((m: any) => `${m.role}: ${m.content}`).join('\n\n')

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: systemMessage?.content,
    })

    const text = result.response.text()

    // Return in OpenAI format
    if (body.stream) {
      // Stream format
      return this.streamSSE(text)
    } else {
      return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Date.now(),
        model: 'gemini-2.0-flash-exp',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop'
        }]
      }
    }
  }

  private async callLMStudio(body: any): Promise<any> {
    const url = `${this.config.lmStudioUrl}/v1/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, model: this.config.lmStudioModel })
    })

    if (!response.ok) {
      throw new Error(`LM Studio error: ${response.status} ${response.statusText}`)
    }

    if (body.stream) {
      // Return async generator for SSE
      return this.streamResponse(response)
    } else {
      return response.json()
    }
  }

  private async callOpenAI(body: any): Promise<any> {
    const url = 'https://api.openai.com/v1/chat/completions'
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.openaiApiKey}`
      },
      body: JSON.stringify({ ...body, model: this.config.openaiModel || 'gpt-4o-mini' })
    })

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status} ${response.statusText}`)
    }

    if (body.stream) {
      return this.streamResponse(response)
    } else {
      return response.json()
    }
  }

  private async *streamResponse(response: Response): AsyncGenerator<string> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
  }

  private async *streamSSE(text: string): AsyncGenerator<string> {
    // Split text into tokens for streaming effect
    const tokens = text.split(' ')
    for (const token of tokens) {
      yield `data: ${JSON.stringify({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'test',
        choices: [{
          index: 0,
          delta: { content: token + ' ' },
          finish_reason: null
        }]
      })}\n\n`
      await new Promise(r => setTimeout(r, 10))
    }
    yield 'data: [DONE]\n\n'
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections()
        }
        this.server.close(() => resolve())
        setTimeout(() => resolve(), 2000)
      } else {
        resolve()
      }
    })
  }
}
