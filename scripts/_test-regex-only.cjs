'use strict'
// 验证 readRunKeyExe 的解析正则能吃下真实 reg.exe 输出（execFile 在测试沙箱里被 EPERM 拦，
// 这里直接喂数据串验证解析逻辑本身）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const samples = [
  // 真实输出形状（UTF-16 → 已转文本）：value 带 --autostart 尾参
  '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    whalebuddy    REG_SZ    "D:\\projects\\dsh-pet\\app\\src-tauri\\target\\debug\\dsh-pet.exe" --autostart\r\n',
  // 无引号形态
  '\r\nHKEY_CURRENT_USER\\...\\Run\r\n    whalebuddy    REG_SZ    D:\\tools\\whalebuddy\\dsh-pet.EXE --autostart\r\n',
  // 键不存在（reg 返回非 0 → 走 err 分支，这里模拟空串）
  '',
]

const re = /"([^"]+\.(?:exe|EXE))"/
const reBare = /([A-Za-z]:\\[^\s]+\.(?:exe|EXE))/i

for (const [i, s] of samples.entries()) {
  const m = re.exec(String(s || ''))
  const bare = !m && s ? reBare.exec(s) : null
  console.log(`sample ${i}:`, m ? m[1] : (bare ? bare[1] + ' (bare)' : 'null'))
}

// 真实输出文件（若 pwsh 已写入）
const f = path.join(os.tmpdir(), 'regout.txt')
if (fs.existsSync(f)) {
  const real = fs.readFileSync(f, 'utf8')
  const m = re.exec(real)
  const bare = !m ? reBare.exec(real) : null
  const got = m ? m[1] : (bare ? bare[1] : null)
  console.log('real reg output parsed:', got)
  if (!got || !/dsh-pet\.exe$/i.test(got)) { console.error('FAIL: real parse'); process.exit(1) }
  console.log('REAL PARSE OK')
}
