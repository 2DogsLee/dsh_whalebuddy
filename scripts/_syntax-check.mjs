// 语法验证：把 src/m1-host.js 当作函数体解析（与 cordis_define code.host 的消费方式一致）
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/m1-host.js', import.meta.url), 'utf8')
try {
  // eslint-disable-next-line no-new-func
  new Function('ctx', src) // 只解析，不调用
  console.log(`OK: parses as function body (${src.split('\n').length} lines)`)
} catch (e) {
  console.error(`SYNTAX ERROR: ${e.message}`)
  process.exit(1)
}