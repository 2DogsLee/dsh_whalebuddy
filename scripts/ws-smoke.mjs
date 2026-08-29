// dsh-pet M1 冒烟测试：握手 + WS 收流
// 用法:
//   node ws-smoke.mjs                      从 $DSH_WEB_URL 自动读端口
//   node ws-smoke.mjs <port>               用指定端口
//   node ws-smoke.mjs <port> <seconds>     指定端口与收流时长（默认 15s）
// 注意：DSH webServer 端口在每次进程重启后会变（动态分配）。
//       DSH_WEB_URL 环境变量由 harness 在每次 pwsh 调用时刷新一次，
//       如果连不上，先确认端口与 DSH 当前 GUI 端口一致（系统提示里的 URL 最权威）。
function resolvePort() {
  const arg = process.argv[2]
  if (arg && /^\d+$/.test(arg)) return arg
  const env = process.env.DSH_WEB_URL
  if (env) {
    const m = /:(\d+)\/?$/.exec(env)
    if (m) return m[1]
  }
  // 兜底：系统提示里的 GUI 端口（DSH 桌面进程当前 URL）。
  //     这个值由 runtime context 提供；如果 DSH 重启了，这里会过时，需要再查 DSH_WEB_URL。
  return '64171'
}
const port = resolvePort()
const seconds = Number(process.argv[3]) || 15
const base = `http://127.0.0.1:${port}`
console.log(`[config] port=${port}  duration=${seconds}s  (DSH_WEB_URL=${process.env.DSH_WEB_URL || '(unset)'})`)

// 1. HTTP 握手
try {
  const res = await fetch(`${base}/dsh-pet/handshake`)
  console.log(`[handshake] HTTP ${res.status} -> ${await res.text()}`)
} catch (e) {
  console.log(`[handshake] FAILED: ${e.message}`)
  process.exit(1)
}

// 2. WebSocket 收流
if (typeof WebSocket === 'undefined') {
  console.log('[ws] this node has no global WebSocket; need node >= 22')
  process.exit(2)
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/dsh-pet/ws`)
let count = 0
ws.onopen = () => console.log('[ws] open')
ws.onmessage = (ev) => {
  count++
  console.log(`[ws ${new Date().toISOString().slice(11, 19)}] #${count} ${ev.data}`)
}
ws.onerror = () => console.log('[ws] error')
ws.onclose = (ev) => console.log(`[ws] close code=${ev.code} reason=${ev.reason || ''}`)

setTimeout(() => { console.log(`[done] ${count} messages received`); ws.close(); process.exit(0) }, seconds * 1000)
