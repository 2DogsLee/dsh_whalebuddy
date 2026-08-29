// 在 exe 二进制里搜嵌入的 index.html 版本特征（Tauri 嵌入资源通常是 UTF-8 字符串）
import { readFileSync } from 'node:fs'

const exe = readFileSync('app/src-tauri/target/debug/dsh-pet.exe')
console.log('exe size:', exe.length)

const markers = [
  'calling showTip',        // 最新代码
  'hover: over pendingAsk', // 之前版本
  'hover: mouseover',       // 更早版本
  'whaleImg',               // 黑鲸图
  'tip-data',               // tip 事件
  'setWindowH',             // 旧方案代码
  'getByLabel',             // B 方案
]
for (const m of markers) {
  const idx = exe.indexOf(Buffer.from(m))
  console.log(`${m}: ${idx >= 0 ? 'FOUND @' + idx : 'not found'}`)
}
