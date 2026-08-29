import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ui = resolve('app/ui/index.html')
const debugExe = resolve('app/src-tauri/target/debug/dsh-pet.exe')
const releaseExe = resolve('app/src-tauri/target/release/dsh-pet.exe')

console.log('ui mtime:', statSync(ui).mtime)
console.log('debug mtime:', statSync(debugExe).mtime)
console.log('release mtime:', statSync(releaseExe).mtime)

for (const [name, p] of [['DEBUG', debugExe], ['RELEASE', releaseExe]]) {
  const buf = readFileSync(p)
  const txt = buf.toString('binary')
  // 查关键标记
  const hasWhaleImg = txt.includes('whaleImg')
  const hasDataImg = (txt.match(/data:image\/png;base64/g) || []).length
  const hasSeabed = txt.includes('seabed')
  const hasFourLayer = txt.includes('class="pet"')
  const hasPetGlyph = txt.includes('💤') || txt.includes('\u{1F4A4}')
  const hasViewBox3040 = txt.includes('viewBox="0 0 30 40"')
  console.log(`${name}:`)
  console.log(`  whaleImg def: ${hasWhaleImg}`)
  console.log(`  inline data:image/png count: ${hasDataImg}`)
  console.log(`  seabed class: ${hasSeabed}`)
  console.log(`  class="pet": ${hasFourLayer}`)
  console.log(`  old emoji glyph: ${hasPetGlyph}`)
  console.log(`  new viewBox 30 40: ${hasViewBox3040}`)
  console.log(`  file size: ${buf.length}`)
}
