/**
 * _smoke-card.cjs — whalebuddy v0.2 host 侧冒烟测试（不进 bundle、不部署）。
 *
 * 用 mock ctx 直接跑真实 lib/index.cjs 的 apply()，验证：
 *  1. /dsh-pet/api/status：默认配置 + pet.connected=false
 *  2. /dsh-pet/api/launch（WHALEBUDDY_DRY_RUN=1）：注册表 Run 键真实解析出 exe 路径，不 spawn
 *  3. /dsh-pet/config GET：HTML 表单含 launchOnDshStart / petPath 新字段
 *  4. /dsh-pet/config POST：settings 服务缺席 → 500 + 错误文案（降级路径）
 *  5. /dsh-pet/handshake：hostVersion=1.2 + config 四字段
 *
 * 运行：node scripts/_smoke-card.cjs（在仓库根）
 */
'use strict'
process.env.WHALEBUDDY_DRY_RUN = '1'

const assert = require('node:assert')
const path = require('node:path')

const PLUGIN = path.join(__dirname, '..', 'whalebuddy', 'lib', 'index.cjs')

async function main() {
  const plugin = require(PLUGIN)
  assert.strictEqual(plugin.name, 'whalebuddy', 'plugin name')
  assert.deepStrictEqual(plugin.inject, ['webServer', 'timer'], 'plugin inject')

  const routes = new Map()
  const upgrades = []
  const listeners = []
  const effects = []

  const ctx = {
    webServer: {
      register: (r) => {
        const k = `${r.kind}:${r.path}`
        if (routes.has(k)) throw new Error('duplicate route ' + k)
        routes.set(k, r.handler)
        return () => routes.delete(k)
      },
      registerUpgrade: (r) => { upgrades.push(r.path); return () => {} },
    },
    on: (ev, fn) => { listeners.push(ev); return () => {} },
    effect: (fn, label) => { effects.push(label); return () => {} },
    inject: () => { /* settings 服务缺席：走降级路径 */ },
    get: (name) => { throw new Error('cannot get property "' + name + '" without inject') },
  }

  plugin.apply(ctx)

  assert.ok(routes.has('exact:/dsh-pet/handshake'), 'handshake route')
  assert.ok(routes.has('exact:/dsh-pet/config'), 'config route')
  assert.ok(routes.has('exact:/dsh-pet/api/status'), 'api/status route')
  assert.ok(routes.has('exact:/dsh-pet/api/launch'), 'api/launch route')
  assert.deepStrictEqual(upgrades, ['/dsh-pet/ws'], 'ws upgrade route')
  assert.ok(listeners.includes('approval/request'), 'approval listener')
  assert.ok(listeners.includes('agent/status'), 'agent/status listener')

  const mkRes = () => {
    const res = { code: 0, headers: null, body: '' }
    res.writeHead = (code, headers) => { res.code = code; res.headers = headers }
    res.end = (s) => { res.body = String(s || '') }
    return res
  }

  // 1. handshake
  {
    const res = mkRes()
    routes.get('exact:/dsh-pet/handshake')({ method: 'GET' }, res)
    const j = JSON.parse(res.body)
    assert.strictEqual(res.code, 200)
    assert.strictEqual(j.ok, true)
    assert.strictEqual(j.name, 'whalebuddy')
    assert.strictEqual(j.hostVersion, '1.2')
    assert.deepStrictEqual(j.config, {
      autostart: false, launchOnDshStart: false, petPath: '', skin: 'dsh-black-whale',
    })
    console.log('✓ handshake: hostVersion=1.2, config 4 字段')
  }

  // 2. api/status
  {
    const res = mkRes()
    routes.get('exact:/dsh-pet/api/status')({ method: 'GET' }, res)
    const j = JSON.parse(res.body)
    assert.strictEqual(j.ok, true)
    assert.strictEqual(j.pet.connected, false)
    assert.strictEqual(j.pet.clients, 0)
    assert.strictEqual(j.config.launchOnDshStart, false)
    console.log('✓ api/status: config + pet 状态')
  }

  // 3. api/launch（dry-run）：真实读注册表 Run 键解析 exe，不 spawn
  {
    const res = mkRes()
    await routes.get('exact:/dsh-pet/api/launch')({ method: 'POST' }, res)
    const j = JSON.parse(res.body)
    assert.strictEqual(res.code, 200)
    assert.strictEqual(j.ok, true)
    if (j.reason === 'process-running') {
      // 宠物进程在跑（exe 解析成功且 tasklist 命中）：不重复拉起 —— v0.2.1 语义
      assert.ok(/\.exe$/i.test(j.exe), '进程存活判定带 exe 路径: ' + j.exe)
      console.log('✓ api/launch (dry-run): 进程存活 → 等待重连（不重复拉起）')
    } else if (j.launched === true) {
      assert.strictEqual(j.dryRun, true, 'dry-run 标记')
      assert.ok(/\.exe$/i.test(j.exe), 'Run 键解析出 exe 路径: ' + j.exe)
      console.log('✓ api/launch (dry-run): Run 键发现 →', j.exe)
    } else {
      // 本机没有 Run 键且无进程时也算通过（解析路径正确走通）
      assert.strictEqual(j.reason, 'exe-not-found')
      console.log('✓ api/launch (dry-run): exe-not-found 降级正确')
    }
  }

  // 4. config GET：新字段渲染
  {
    const res = mkRes()
    routes.get('exact:/dsh-pet/config')({ method: 'GET' }, res)
    assert.strictEqual(res.code, 200)
    assert.ok(res.body.includes('launchOnDshStart'), 'HTML 含 launchOnDshStart')
    assert.ok(res.body.includes('petPath'), 'HTML 含 petPath')
    assert.ok(res.body.includes('插件配置'), 'HTML 提示设置菜单入口')
    console.log('✓ config GET: 新字段已渲染')
  }

  // 5. config POST：settings 缺席 → 500
  {
    const res = mkRes()
    const body = 'autostart=1&launchOnDshStart=1&petPath=&skin=dsh-black-whale'
    const req = {
      method: 'POST',
      async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
    }
    await routes.get('exact:/dsh-pet/config')(req, res)
    assert.strictEqual(res.code, 500)
    assert.ok(res.body.includes('settings'), '500 文案含 settings')
    console.log('✓ config POST: settings 缺席 500 降级')
  }

  console.log('\n全部冒烟断言通过 ✔')
}

main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1) })
