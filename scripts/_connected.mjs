// 分析处理后 PNG 中"内部白色"连通域的分布（面积+位置），以区分眼睛 vs 斑块。
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

function decodePng(path) {
  const buf = readFileSync(path)
  const W = buf.readUInt32BE(16), H = buf.readUInt32BE(20)
  const bpp = 4, stride = W * bpp
  const raw = zlib.inflateSync(Buffer.concat(
    (() => { const c = []; let i = 8; while (i < buf.length) { const l = buf.readUInt32BE(i); const t = buf.slice(i + 4, i + 8).toString('ascii'); if (t === 'IDAT') c.push(buf.slice(i + 8, i + 8 + l)); i += 8 + l + 4 } return c })()
  ))
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
      else if (ft === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c) }
      cur[x] = v & 0xff
    }
    prev = Buffer.from(cur)
  }
  return { W, H, data: out }
}

const { W, H, data } = decodePng(process.argv[2])
const px = (x, y) => { const o = (y * W + x) * 4; return [data[o], data[o + 1], data[o + 2], data[o + 3]] }

// 连通域（4邻接）找白色区域：alpha>128 且 RGB>=180
const white = new Uint8Array(W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const [r, g, b, a] = px(x, y)
  if (a > 128 && r >= 180 && g >= 180 && b >= 180) white[y * W + x] = 1
}
const seen = new Uint8Array(W * H)
const conns = []
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const idx = y * W + x
  if (!white[idx] || seen[idx]) continue
  // BFS
  const q = [idx]; seen[idx] = 1
  let size = 0, minX = x, maxX = x, minY = y, maxY = y
  while (q.length) {
    const i = q.pop()
    const cx = i % W, cy = (i / W) | 0
    size++
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const ni = ny * W + nx
      if (white[ni] && !seen[ni]) { seen[ni] = 1; q.push(ni) }
    }
  }
  conns.push({ size, minX, maxX, minY, maxY })
}
conns.sort((a, b) => b.size - a.size)
console.log(`image ${W}x${H}, white regions: ${conns.length}`)
for (const c of conns) console.log(`size=${c.size}  bbox=(${c.minX},${c.minY})-(${c.maxX},${c.maxY})  center=(${((c.minX + c.maxX) / 2) | 0},${((c.minY + c.maxY) / 2) | 0})`)
