/**
 * Mock AI Server — intercepts fetch calls from the extension's service worker.
 * Queue-based: tests push expected responses, server dequeues per request.
 */
import * as http from 'http'
import { buildOpenAISSE, buildOpenAIJSON, buildModelList } from '../helpers/sse'

export interface MockRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: any
  timestamp: number
}

interface QueuedResponse {
  /** The text the AI should "say" */
  text: string
  /** If true, return as streaming SSE; if false, return as JSON */
  stream?: boolean
  /** HTTP status code (default 200) */
  status?: number
  /** Delay before responding in ms */
  delay?: number
  /** Raw body override (for error simulation) */
  rawBody?: string
}

export class AIMockServer {
  private server: http.Server | null = null
  private responseQueue: QueuedResponse[] = []
  private requestLog: MockRequest[] = []
  port = 0

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get requests(): MockRequest[] {
    return [...this.requestLog]
  }

  /** Get only chat completion requests (excludes model list, probe, etc.) */
  get chatRequests(): MockRequest[] {
    return this.requestLog.filter(r => r.url.includes('/chat/completions') || r.url.includes('/v1/messages'))
  }

  /** Push a response onto the queue. First queued = first served. */
  enqueue(text: string, opts?: Partial<Omit<QueuedResponse, 'text'>>): void {
    this.responseQueue.push({ text, stream: true, ...opts })
  }

  /** Push an error response */
  enqueueError(status: number, message: string): void {
    this.responseQueue.push({
      text: '',
      status,
      rawBody: JSON.stringify({ error: { message, type: 'api_error' } }),
    })
  }

  /** Clear the queue and request log */
  reset(): void {
    this.responseQueue = []
    this.requestLog = []
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        // Collect body
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const bodyStr = Buffer.concat(chunks).toString()
        let body: any = {}
        try { body = JSON.parse(bodyStr) } catch { /* non-JSON */ }

        // Log request
        this.requestLog.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers as Record<string, string>,
          body,
          timestamp: Date.now(),
        })

        // CORS headers (extension fetches from localhost)
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
          res.end(buildModelList())
          return
        }

        // Chat completions / messages endpoint
        if (req.url?.includes('/chat/completions') || req.url?.includes('/v1/messages')) {
          const queued = this.responseQueue.shift()

          if (!queued) {
            // No queued response — return a default "done" response
            const isStream = body.stream === true
            if (isStream) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
              res.write(buildOpenAISSE('I have completed this task. {"is_complete": true}'))
              res.end()
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(buildOpenAIJSON('Task complete. {"is_complete": true}'))
            }
            return
          }

          // Error response
          if (queued.status && queued.status >= 400) {
            if (queued.delay) await sleep(queued.delay)
            res.writeHead(queued.status, { 'Content-Type': 'application/json' })
            res.end(queued.rawBody ?? JSON.stringify({ error: { message: queued.text } }))
            return
          }

          // Delay
          if (queued.delay) await sleep(queued.delay)

          const isStream = body.stream === true && queued.stream !== false
          if (isStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            })
            // Write SSE chunks with small delays for realism
            const sse = buildOpenAISSE(queued.text)
            const lines = sse.split('\n\n').filter(Boolean)
            for (const line of lines) {
              res.write(line + '\n\n')
              await sleep(5) // tiny delay between tokens
            }
            res.end()
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(buildOpenAIJSON(queued.text))
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
        console.log(`[MockAI] Server listening on port ${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // Close all open connections so server.close() doesn't hang
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections()
        }
        this.server.close(() => resolve())
        // Safety timeout — don't block teardown forever
        setTimeout(() => resolve(), 2000)
      } else {
        resolve()
      }
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
