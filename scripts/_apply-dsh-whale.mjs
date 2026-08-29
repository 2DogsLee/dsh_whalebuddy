// 把 app/ui/index.html 里的鲸鱼主体从 DeepSeek 蓝鲸 path 换成 DSH 黑色 PNG（base64 嵌入）。
// 一次性改动：defs、单体 svg、小弟 svg ×2、whale 光晕与位移、breach 关键帧、offline 滤镜。
import { readFileSync, writeFileSync } from 'node:fs'

const b64 = readFileSync(new URL('../logo/_dsh_whale_b64.txt', import.meta.url), 'utf8')
let html = readFileSync(new URL('../app/ui/index.html', import.meta.url), 'utf8')

let misses = 0
function rep(from, to) {
  if (typeof from === 'string') {
    if (!html.includes(from)) {
      console.error('MISS:', JSON.stringify(from).slice(0, 100))
      misses++
      return
    }
    const idx = html.indexOf(from)
    if (html.indexOf(from, idx + 1) !== -1) {
      console.error('NOT UNIQUE:', JSON.stringify(from).slice(0, 80))
      misses++
      return
    }
    html = html.replace(from, to)
  } else {
    // regex
    const m = html.match(from)
    if (!m) { console.error('MISS (regex)'); misses++; return }
    if (html.match(from).length > 1) { console.error('NOT UNIQUE (regex)'); misses++; return }
    html = html.replace(from, to)
  }
}

// —— (A) 单例注释 ——
rep(
  '  <!-- 鲸鱼 path 单例定义：不写 fill，由 <use> 传入（换色/主题用） -->',
  '  <!-- DSH 黑色鲸鱼单例：240×320 PNG，<use> 复用于本体与小弟 -->'
)

// —— (B) defs：path → image（用正则匹配整个长 path） ——
rep(
  /<path id="whalePath" fill-rule="evenodd"\s+d="[^"]*"\/>/,
  `<image id="whaleImg" href="data:image/png;base64,${b64}" width="240" height="320"/>`
)

// —— (C) 主体 whale svg ——
rep(
  `<svg class="whale" viewBox="0 0 57 42" aria-hidden="true">
            <use href="#whalePath" fill="#4d6bfe"/>
          </svg>`,
  `<svg class="whale" viewBox="0 0 30 40" aria-hidden="true">
            <use href="#whaleImg" width="30" height="40"/>
          </svg>`
)

// —— (D)(E) 小弟 svg ×2 ——
rep(
  `<svg class="baby b1" viewBox="0 0 57 42"><use href="#whalePath" fill="#5f7dff"/></svg>`,
  `<svg class="baby b1" viewBox="0 0 30 40"><use href="#whaleImg" width="30" height="40"/></svg>`
)
rep(
  `<svg class="baby b2" viewBox="0 0 57 42"><use href="#whalePath" fill="#7d95ff"/></svg>`,
  `<svg class="baby b2" viewBox="0 0 30 40"><use href="#whaleImg" width="30" height="40"/></svg>`
)

// —— (F) .whale 宽度默认值与冷白光晕 ——
rep(
  '    width: var(--whale-w, 100px);',
  '    width: var(--whale-w, 84px);'
)
rep(
  '    filter: drop-shadow(0 0 8px rgba(77, 107, 254, 0.5));',
  '    filter: drop-shadow(0 0 7px rgba(190, 220, 255, 0.35)) drop-shadow(0 0 14px rgba(190, 220, 255, 0.18));'
)

// —— .baby 光晕也换成冷白边 ——
rep(
  '    filter: drop-shadow(0 0 4px rgba(90, 120, 255, 0.4));',
  '    filter: drop-shadow(0 0 4px rgba(190, 220, 255, 0.3));'
)

// —— (H) 各状态/活动位移（黑鲸变高后整体收回，避免出框） ——
rep('  [data-activity="coding"]   .whale-pos { transform: translate(-20px, 24px) rotate(6deg); }',
    '  [data-activity="coding"]   .whale-pos { transform: translate(-14px, 16px) rotate(6deg); }')
rep('  [data-activity="cmd"]      .whale-pos { transform: translate(20px, 26px) rotate(-5deg); }',
    '  [data-activity="cmd"]      .whale-pos { transform: translate(14px, 18px) rotate(-5deg); }')
rep('  [data-activity="search"]   .whale-pos { transform: translate(0, 14px); }',
    '  [data-activity="search"]   .whale-pos { transform: translate(0, 8px); }')
rep('  [data-activity="spawning"] .whale-pos { transform: translate(24px, -8px); }',
    '  [data-activity="spawning"] .whale-pos { transform: translate(18px, -4px); }')
rep('  [data-state="offline"]     .whale-pos { transform: translate(0, 10px); }',
    '  [data-state="offline"]     .whale-pos { transform: translate(0, 4px); }')
rep('  [data-state="sleeping"]    .whale-pos { transform: translate(0, 34px); }',
    '  [data-state="sleeping"]    .whale-pos { transform: translate(0, 20px); }')
rep('  [data-state="needYou"]     .whale-pos { transform: translate(0, -30px); }',
    '  [data-state="needYou"]     .whale-pos { transform: translate(0, -22px); }')

// —— offline .whale 滤镜（黑鲸版） ——
rep(
  `  [data-state="offline"]     .whale {
    filter: saturate(0.2) brightness(0.7) drop-shadow(0 0 3px rgba(77, 107, 254, 0.25));
    opacity: 0.5;
  }`,
  `  [data-state="offline"]     .whale {
    filter: opacity(0.55) drop-shadow(0 0 4px rgba(190, 220, 255, 0.15));
    opacity: 0.55;
  }`
)

// —— breach 关键帧（黑鲸版） ——
rep(
  `  @keyframes breach {
    0%, 100% { transform: translate(0, 24px) rotate(0deg); }
    32%      { transform: translate(0, -44px) rotate(-9deg) scale(1.04); }
    58%      { transform: translate(0, -26px) rotate(5deg); }
    82%      { transform: translate(0, 12px) rotate(-3deg); }
  }`,
  `  @keyframes breach {
    0%, 100% { transform: translate(0, 14px) rotate(0deg); }
    32%      { transform: translate(0, -26px) rotate(-9deg) scale(1.04); }
    58%      { transform: translate(0, -14px) rotate(5deg); }
    82%      { transform: translate(0, 8px) rotate(-3deg); }
  }`
)

if (misses) { console.error(`FAILED: ${misses} misses`); process.exit(1) }

writeFileSync(new URL('../app/ui/index.html', import.meta.url), html)
console.log('OK — index.html updated, new size:',
  readFileSync(new URL('../app/ui/index.html', import.meta.url)).length, 'bytes')
