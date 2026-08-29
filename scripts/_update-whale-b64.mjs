// 用新的（透明背景）base64 替换 index.html 中 :root --dsh-whale 的旧 base64。
// 鲁棒实现：定位 "data:image/png;base64," 到下一个引号之间。
import { readFileSync, writeFileSync } from 'node:fs'

const b64New = readFileSync(new URL('../logo/_dsh_whale_b64.txt', import.meta.url), 'utf8').trim()
let html = readFileSync(new URL('../app/ui/index.html', import.meta.url), 'utf8')

const marker = 'data:image/png;base64,'
const start = html.indexOf(marker)
if (start === -1) { console.error('marker not found'); process.exit(1) }
const b64Start = start + marker.length
const end = html.indexOf('"', b64Start)
if (end === -1) { console.error('closing quote not found'); process.exit(1) }

const oldLen = end - b64Start
console.log('old b64 length:', oldLen)
console.log('new b64 length:', b64New.length)
if (oldLen === b64New.length && html.slice(b64Start, end) === b64New) {
  console.log('already up to date')
  process.exit(0)
}

html = html.slice(0, b64Start) + b64New + html.slice(end)
writeFileSync(new URL('../app/ui/index.html', import.meta.url), html)
console.log('OK, new file size:', html.length)
