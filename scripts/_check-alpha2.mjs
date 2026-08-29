// 正确解析 PNG（含 filter 重建）并统计：外部透明、内部黑、内部白细节
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

function decodePng(path) {
  const buf = readFileSync(path)
  const W = buf.readUInt32BE(16), H = buf.readUInt32BE(20)
  const bitDepth = buf[24], colorType = buf[25]
  const chunks = []
  let i = 8
  while (i < buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.slice(i + 4, i + 8).toString('ascii')
    if (type === 'IDAT') chunks.push(buf.slice(i + 8, i + 8 + len))
    i += 8 + len + 4
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks))
  // RGBA8: stride = W*4, filter byte per row
  const bpp = 4
  const stride = W * bpp
  const out = Buffer.alloc(H * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < H; y++) {
    const ft = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = row[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
    prev = Buffer.from(cur)
  }
  return { W, H, data: out }
}

const { W, H, data } = decodePng(process.argv[2])
const px = (x, y) => {
  const o = (y * W + x) * 4
  return [data[o], data[o + 1], data[o + 2], data[o + 3]]
}
console.log(`size ${W}x${H}`)
console.log('corners:', px(0, 0), px(W - 1, 0), px(0, H - 1), px(W - 1, H - 1))
let opaque = 0, transparent = 0, partial = 0, innerWhite = 0, innerBlack = 0
for (let y = 0; y < H; y += 2) {
  for (let x = 0; x < W; x += 2) {
    const [r, g, b, a] = px(x, y)
    if (a === 0) transparent++
    else if (a === 255) {
      opaque++
      if (r >= 200 && g >= 200 && b >= 200) innerWhite++   // 内部白色细节
      else innerBlack++                                      // 黑色主体
    } else partial++
  }
}
console.log(`alpha: opaque=${opaque} transparent=${transparent} partial=${partial}`)
console.log(`opaque breakdown: black=${innerBlack} white=${innerWhite}`)
