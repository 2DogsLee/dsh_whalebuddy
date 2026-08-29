// dsh-pet proto 静态服务器：托管本目录文件
// 端口发现从 proto 页改为手动 ?port= 方式（避免跨源扫描的坑）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT || 8765)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`)
  const path = url.pathname === '/' ? '/index.html' : url.pathname

  if (path.includes('..')) { res.writeHead(403); res.end('forbidden'); return }
  try {
    const full = resolve(ROOT + path)
    const data = await readFile(full)
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(data)
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('404 not found: ' + path)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://127.0.0.1:${PORT}/  (cwd: ${ROOT})`)
})