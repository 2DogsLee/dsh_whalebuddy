import { readFileSync } from 'node:fs'
const s = readFileSync(new URL('../app/ui/index.html', import.meta.url), 'utf8')
const re = /\s*<image id="whaleImg" href="data:image\/png;base64,[^"]*" width="240" height="320"\/>/
const m = s.match(re)
console.log('match:', m ? `len=${m[0].length}, preview=${JSON.stringify(m[0].slice(0, 80))}` : 'null')
