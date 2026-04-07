const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 3000
const ROOT = path.join(__dirname, 'dist')

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0]
  if (urlPath === '/') urlPath = '/sidepanel/sidepanel.html'

  const filePath = path.join(ROOT, urlPath)

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end(`Not found: ${urlPath}`)
      return
    }
    const ext = path.extname(filePath)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(data)
  })
}).listen(PORT, () => {
  console.log(`LocalAI preview → http://localhost:${PORT}`)
  console.log(`  Sidepanel: http://localhost:${PORT}/sidepanel/sidepanel.html`)
  console.log(`  Test page: http://localhost:${PORT}/_dev/test-page.html`)
})
