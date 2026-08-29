import { readFileSync, writeFileSync } from 'node:fs'
const html = readFileSync('app/ui/index.html', 'utf8')
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) { console.error('no script'); process.exit(1) }
writeFileSync('scripts/_check-inline.js', m[1])
// 确认没有残留 syncSize 引用
console.log('syncSize refs:', (m[1].match(/syncSize/g) || []).length)
console.log('applySize refs:', (m[1].match(/applySize/g) || []).length)
console.log('tipTargetH refs:', (m[1].match(/tipTargetH/g) || []).length)
