import { readFileSync } from 'node:fs'
const h = readFileSync('D:/projects/dsh-pet/app/ui/index.html', 'utf8')
console.log('sonar in whale-pos:', /whale-pos[\s\S]*?class="sonar"/.test(h))
console.log('sonar count in html:', (h.match(/class="sonar"/g) || []).length)
console.log('has [data-activity=thinking] .sonar:', h.includes('data-activity="thinking"') && h.includes('.sonar { display: block; }'))
console.log('sonar CSS block exists:', /\.sonar \{/.test(h))
console.log('whale-pos flex:', /\.whale-pos \{[\s\S]*?display: flex/.test(h))
console.log('z-index 5 sonar:', h.includes('z-index: 5'))
// 找出 sonar 完整 CSS
const m = h.match(/\.sonar \{[\s\S]*?\[data-activity="search"\]\s*\.sonar \{ display: block; \}/)
if (m) console.log('\n--- SONAR CSS BLOCK ---\n' + m[0])
