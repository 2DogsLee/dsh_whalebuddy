import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const path = process.argv[2]
const buf = readFileSync(path)
const W = buf.readUInt32BE(16)
const H = buf.readUInt32BE(20)
const colorType = buf[25]

const chunks = []
let i = 8
while (i < buf.length) {
  const len = buf.readUInt32BE(i)
  const type = buf.slice(i + 4, i + 8).toString('ascii')
  if (type === 'IDAT') chunks.push(buf.slice(i + 8, i + 8 + len))
  i += 8 + len + 4
}
const raw = zlib.inflateSync(Buffer.concat(chunks))
const stride = 1 + W * 4
function px(x, y) {
  const off = y * stride + 1 + x * 4
  return [raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]
}
let opaque = 0, transp = 0, partial = 0
for (let y = 0; y < H; y += 16) {
  for (let x = 0; x < W; x += 16) {
    const a = px(x, y)[3]
    if (a === 255) opaque++
    else if (a === 0) transp++
    else partial++
  }
}
console.log(`${path}: ${W}x${H} colorType=${colorType}`)
console.log(`corners: TL=${px(0,0)} TR=${px(W-1,0)} BL=${px(0,H-1)} BR=${px(W-1,H-1)}`)
console.log(`alpha: opaque=${opaque} transparent=${transp} partial=${partial}`)
