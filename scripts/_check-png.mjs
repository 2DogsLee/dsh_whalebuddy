// 检查 PNG 是否真的有透明通道，以及 alpha 分布
import { readFileSync } from 'node:fs'
const buf = readFileSync('logo/dsh_logo_sm.png')

// 读 PNG IHDR
if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
  console.log('not PNG')
  process.exit(1)
}
// IHDR 长度(4) + type(4) + data(13) starts at byte 8
const width = buf.readUInt32BE(16)
const height = buf.readUInt32BE(20)
const bitDepth = buf[24]
const colorType = buf[25]
console.log('width:', width, 'height:', height, 'bitDepth:', bitDepth, 'colorType:', colorType)
// colorType: 0=gray, 2=RGB, 3=palette, 4=gray+alpha, 6=RGBA
console.log('has alpha channel:', colorType === 4 || colorType === 6)
