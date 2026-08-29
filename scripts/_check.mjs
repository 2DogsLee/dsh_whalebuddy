import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
const html = readFileSync('app/ui/index.html', 'utf8')
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) { console.error('no script'); process.exit(1) }
writeFileSync('scripts/_check-inline.js', m[1])
console.log('--- key references ---')
console.log('WebviewWindow.getByLabel:', (m[1].match(/WebviewWindow\.getByLabel/g) || []).length)
console.log('emitTo:', (m[1].match(/emitTo/g) || []).length)
console.log('event.emit:', (m[1].match(/event\.emit/g) || []).length)
console.log('showTip:', (m[1].match(/showTip/g) || []).length)
console.log('hideTip:', (m[1].match(/hideTip/g) || []).length)
console.log('emitTipData:', (m[1].match(/emitTipData/g) || []).length)
