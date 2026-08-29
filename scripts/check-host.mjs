// 重启 DSH 后验证感知层状态/版本：node scripts/check-host.mjs [端口]
// 端口省略时取 DSH_WEB_URL；输出 handshake JSON + 结论。
const port = process.argv[2]
  ?? (process.env.DSH_WEB_URL ? Number(process.env.DSH_WEB_URL.split(':').pop()) : null)
if (!port) {
  console.error('用法: node scripts/check-host.mjs <DSH端口>（或先设 DSH_WEB_URL）')
  process.exit(1)
}
try {
  const r = await fetch(`http://127.0.0.1:${port}/dsh-pet/handshake`)
  const j = await r.json()
  console.log(JSON.stringify(j))
  if (!j.ok) { console.log('✗ 响应异常'); process.exit(1) }
  console.log(j.hostVersion === '1.1'
    ? '✓ v1.1 已生效（prepend 确定性加固版）'
    : `✓ 感知层在线（hostVersion: ${j.hostVersion ?? '未标注，≤1.0 旧版'}）`)
} catch (e) {
  console.log(`✗ 端口 ${port} 无响应：${e.message}（DSH 没开 / 感知层未挂载？）`)
  process.exit(1)
}
