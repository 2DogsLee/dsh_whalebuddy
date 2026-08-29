// 探测 /dsh-pet/ws 的活跃连接数：宠物若连上应为 1
import { setTimeout as delay } from 'node:timers/promises'

const port = process.argv[2]
  ?? (process.env.DSH_WEB_URL ? Number(process.env.DSH_WEB_URL.split(':').pop()) : 57865)

const ws = new WebSocket(`ws://127.0.0.1:${port}/dsh-pet/ws`)
const tag = (m) => console.log(`[conn-check ${new Date().toISOString().slice(11, 19)}] ${m}`)
ws.onopen = () => tag('open（本探测客户端连接成功；加上宠物 = 服务器应有 2 个连接）')
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.type === 'state') tag(`state: activity=${m.activity} status=${m.session?.status} sessions.running=${m.sessions?.running ?? '?'} approval=${JSON.stringify(m.awaitingApproval)} ts=${m.ts}`)
}
ws.onclose = () => tag('close')
ws.onerror = () => tag('error')
await delay(4000)
ws.close()
tag('done')