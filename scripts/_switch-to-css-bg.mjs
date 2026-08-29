// 用 CSS background-image 替代 SVG <image>，消除 WebView2 SVG image 渲染白色背景的问题。
// 把 base64 提到 :root 的 CSS 变量，3 个元素共用（base64 只写一次）。
import { readFileSync, writeFileSync } from 'node:fs'

const b64 = readFileSync(new URL('../logo/_dsh_whale_b64.txt', import.meta.url), 'utf8').trim()
let html = readFileSync(new URL('../app/ui/index.html', import.meta.url), 'utf8')

let misses = 0
function rep(from, to) {
  if (typeof from === 'string') {
    if (!html.includes(from)) { console.error('MISS:', from.slice(0, 100)); misses++; return }
    const idx = html.indexOf(from)
    if (html.indexOf(from, idx + 1) !== -1) { console.error('NOT UNIQUE:', from.slice(0, 100)); misses++; return }
    html = html.replace(from, to)
  } else {
    const re = new RegExp(from.source, from.flags.includes('g') ? from.flags : from.flags + 'g')
    const matches = html.match(re)
    if (!matches) { console.error('MISS (regex):', from.source.slice(0, 80)); misses++; return }
    if (matches.length > 1) { console.error('NOT UNIQUE (regex):', matches.length, from.source.slice(0, 80)); misses++; return }
    html = html.replace(re, to)
  }
}

// 1. 把 3 个 svg（whale、b1、b2）的整段（含内联 image）替换成空 div
// 主 whale svg（多行）
rep(
  `<svg class="whale" viewBox="0 0 30 40" aria-hidden="true">
            <image href="data:image/png;base64,${b64}" x="0" y="0" width="30" height="40"/>
          </svg>`,
  `<div class="whale" aria-hidden="true"></div>`
)
// b1、b2（单行）
rep(
  `<svg class="baby b1" viewBox="0 0 30 40"><image href="data:image/png;base64,${b64}" x="0" y="0" width="30" height="40"/></svg>`,
  `<div class="baby b1" aria-hidden="true"></div>`
)
rep(
  `<svg class="baby b2" viewBox="0 0 30 40"><image href="data:image/png;base64,${b64}" x="0" y="0" width="30" height="40"/></svg>`,
  `<div class="baby b2" aria-hidden="true"></div>`
)

// 2. CSS：.whale 改成 div 样式（加 height 比例 + background）
rep(
  `  .whale {
    width: var(--whale-w, 84px);
    height: auto;
    display: block;
    filter: drop-shadow(0 0 7px rgba(190, 220, 255, 0.35)) drop-shadow(0 0 14px rgba(190, 220, 255, 0.18));
    animation: sway 5.5s ease-in-out infinite;
  }`,
  `  .whale {
    width: var(--whale-w, 84px);
    height: calc(var(--whale-w, 84px) * 4 / 3);
    background: var(--dsh-whale) center/contain no-repeat;
    filter: drop-shadow(0 0 7px rgba(190, 220, 255, 0.35)) drop-shadow(0 0 14px rgba(190, 220, 255, 0.18));
    animation: sway 5.5s ease-in-out infinite;
  }`
)

// 3. CSS：.baby 改成 div 样式
rep(
  `  .baby {
    position: absolute;
    width: 26px; height: auto;
    opacity: 0.85;
    filter: drop-shadow(0 0 4px rgba(190, 220, 255, 0.3));
  }`,
  `  .baby {
    position: absolute;
    width: 26px;
    height: 35px;
    background: var(--dsh-whale) center/contain no-repeat;
    opacity: 0.85;
    filter: drop-shadow(0 0 4px rgba(190, 220, 255, 0.3));
  }`
)

// 4. 在 <style> 顶部加 :root 变量（在 html/body 全局样式之前）
rep(
  `<style>
  /* 整窗透明：窗口本体由 tauri.conf.json transparent:true 打通 */
  * { box-sizing: border-box; user-select: none; }`,
  `<style>
  /* DSH 黑色鲸鱼（PNG，透明背景，240×320，aspect 0.75）共用给本体和小弟 */
  :root { --dsh-whale: url("data:image/png;base64,${b64}"); }

  /* 整窗透明：窗口本体由 tauri.conf.json transparent:true 打通 */
  * { box-sizing: border-box; user-select: none; }`
)

if (misses) { console.error(`FAILED: ${misses} misses`); process.exit(1) }
writeFileSync(new URL('../app/ui/index.html', import.meta.url), html)
console.log('OK — file size:', html.length, 'bytes')
