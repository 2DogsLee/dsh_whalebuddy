// Chromium/WebView2 对跨 SVG <use> 引用 <defs> 中的 <image> 渲染退化为白色占位矩形。
// 改成每个 svg 直接内联 <image>，不用 defs/use。
import { readFileSync, writeFileSync } from 'node:fs'

const b64 = readFileSync(new URL('../logo/_dsh_whale_b64.txt', import.meta.url), 'utf8').trim()
let html = readFileSync(new URL('../app/ui/index.html', import.meta.url), 'utf8')

const dataUri = `data:image/png;base64,${b64}`

let misses = 0
function rep(from, to) {
  console.error('rep called:', typeof from === 'string' ? from.slice(0, 60) : 'REGEX ' + from.source.slice(0, 60))
  if (typeof from === 'string') {
    if (!html.includes(from)) { console.error('MISS:', from.slice(0, 100)); misses++; return }
    const idx = html.indexOf(from)
    if (html.indexOf(from, idx + 1) !== -1) { console.error('NOT UNIQUE:', from.slice(0, 100)); misses++; return }
    html = html.replace(from, to)
  } else {
    // regex
    const re = new RegExp(from.source, from.flags.includes('g') ? from.flags : from.flags + 'g')
    const matches = html.match(re)
    if (!matches) { console.error('MISS (regex):', from.source.slice(0, 80)); misses++; return }
    if (matches.length > 1) { console.error('NOT UNIQUE (regex):', matches.length, from.source.slice(0, 80)); misses++; return }
    html = html.replace(re, to)
  }
}

// 1. 删掉 defs 里的 <image id="whaleImg" .../>
rep(
  /\s*<image id="whaleImg" href="data:image\/png;base64,[^"]*" width="240" height="320"\/>/,
  ''
)
// 保留空 defs + 隐藏 svg 空壳无害（后续可清理）

// 2. 主 whale svg：use → 内联 image
rep(
  `<svg class="whale" viewBox="0 0 30 40" aria-hidden="true">
            <use href="#whaleImg" width="30" height="40"/>
          </svg>`,
  `<svg class="whale" viewBox="0 0 30 40" aria-hidden="true">
            <image href="${dataUri}" x="0" y="0" width="30" height="40"/>
          </svg>`
)

// 3. b1、b2：use → 内联 image
rep(
  `<svg class="baby b1" viewBox="0 0 30 40"><use href="#whaleImg" width="30" height="40"/></svg>`,
  `<svg class="baby b1" viewBox="0 0 30 40"><image href="${dataUri}" x="0" y="0" width="30" height="40"/></svg>`
)
rep(
  `<svg class="baby b2" viewBox="0 0 30 40"><use href="#whaleImg" width="30" height="40"/></svg>`,
  `<svg class="baby b2" viewBox="0 0 30 40"><image href="${dataUri}" x="0" y="0" width="30" height="40"/></svg>`
)

if (misses) { console.error(`FAILED: ${misses} misses`); process.exit(1) }

writeFileSync(new URL('../app/ui/index.html', import.meta.url), html)
console.log('OK — file size:', html.length, 'bytes')
