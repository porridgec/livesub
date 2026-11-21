#!/usr/bin/env node
// 本地静态服务器（serves test/），dev-e2e.mjs 复用；直接运行亦可手动验证：
//   node scripts/dev-serve.mjs &  curl -sI http://127.0.0.1:8123/
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const PORT = Number(process.env.PORT || 8123)

const MIME = {
  html: 'text/html; charset=utf-8',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  js: 'text/javascript',
  css: 'text/css',
  ico: 'image/x-icon',
}

export function startServer(port = PORT) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let p = join(ROOT, 'test', pathname)
    let data = null
    try {
      data = readFileSync(p)
    } catch {
      // 目录请求回退 index.html
      try {
        p = join(p, 'index.html')
        data = readFileSync(p)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('404')
        return
      }
    }
    const ext = p.includes('.') ? p.split('.').pop().toLowerCase() : 'html'
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': data.length,
    })
    res.end(data)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer()
  console.log(`serving test/ at http://127.0.0.1:${PORT}/`)
}
