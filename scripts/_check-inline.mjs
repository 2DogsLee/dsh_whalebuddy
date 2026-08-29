import { readFileSync } from 'node:fs'
const s = readFileSync(new URL('../app/ui/index.html', import.meta.url), 'utf8')
console.log('whaleImg def still there:', s.includes('id="whaleImg"'))
console.log('defs tag still there:', s.includes('<defs>'))
console.log('use #whaleImg count:', (s.match(/href="#whaleImg"/g) || []).length)
console.log('inline image count:', (s.match(/<image href="data:image\/png;base64,[^"]+" x="0" y="0"/g) || []).length)
