// 从 index.html 提取 --dsh-whale 的 base64，解码验证是透明背景 PNG
import { readFileSync } from 'node:fs'
const html = readFileSync('app/ui/index.html', 'utf8')
const marker = 'data:image/png;base64,'
const start = html.indexOf(marker) + marker.length
const end = html.indexOf('"', start)
const b64 = html.slice(start, end)
console.log('b64 length:', b64.length)

// 解码并检查 PNG 头 + 采样 alpha（简单：解析 IHDR colorType）
const buf = Buffer.from(b64, 'base64')
console.log('PNG signature ok:', buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a')
console.log('width:', buf.readUInt32BE(16), 'height:', buf.readUInt32BE(20), 'colorType:', buf[25])
// colorType 6 = RGBA（有透明通道）
console.log('has alpha (colorType 6):', buf[25] === 6)
