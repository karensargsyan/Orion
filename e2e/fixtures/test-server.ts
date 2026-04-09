/**
 * Static file server for test pages.
 * Serves the project root so _dev/test-page.html is accessible over HTTP.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export class TestServer {
  private server: http.Server | null = null
  port = 0
  private root: string

  constructor(root?: string) {
    this.root = root ?? path.resolve(__dirname, '../..')
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get testPageUrl(): string {
    return `${this.url}/_dev/test-page.html`
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url?.split('?')[0] ?? '/')
        const filePath = path.join(this.root, urlPath)

        // Security: prevent path traversal
        if (!filePath.startsWith(this.root)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }

        fs.stat(filePath, (err, stats) => {
          if (err || !stats.isFile()) {
            res.writeHead(404)
            res.end('Not found')
            return
          }

          const ext = path.extname(filePath)
          res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
          fs.createReadStream(filePath).pipe(res)
        })
      })

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' ? addr!.port : 0
        console.log(`[TestServer] Serving ${this.root} on port ${this.port}`)
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
