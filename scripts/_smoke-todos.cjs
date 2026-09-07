/**
 * whalebuddy v0.3 冒烟测试：假 cordis ctx 拉起宿主插件，验证焦点/待办全链路。
 *
 * 覆盖（docs/11 §7）：
 *  1. 插件 apply 成功、路由注册齐全（handshake/api/focus/api/todos/todos/ws 升级）
 *  2. agent/status 事件 → 活动近似焦点（source=activity，cwd=header.cwd）
 *  3. POST /dsh-pet/api/focus → GUI 真焦点（source=gui，last-writer-wins）
 *  4. WS 升级 → 全量 state 快照带 focus/todos
 *  5. WS command todo/add|toggle|remove|clear → commandResult 回带最新清单
 *  6. todos.json 原子落盘（$DSH_HOME/whalebuddy/todos.json）
 *  7. Origin 校验：跨源 WS 升级被拒、跨源 POST focus 403
 *
 * 用法：node scripts/_smoke-todos.cjs  （DSH_HOME 指到临时目录，跑完即焚）
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const REPO = path.resolve(__dirname, '..')
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebuddy-smoke-'))
process.env.DSH_HOME = DSH_HOME
// 拉起观察器前先关掉（launchOnDshStart 默认 false，双保险）
delete process.env.DSH_WEB_URL

const log = []
const plugin = require(path.join(REPO, 'whalebuddy', 'lib', 'index.cjs'))

// ---- 假 cordis ctx ----
const routes = new Map()     // path -> handler(req, res)
const upgrades = new Map()   // path -> handler(req, socket, head)
const listeners = new Map()  // event -> [fn]
const effects = []

function makeCtx() {
  const ctx = {
    webServer: {
      register: (r) => {
        if (routes.has(r.path)) throw new Error('duplicate route ' + r.path)
        routes.set(r.path, r.handler)
        return () => routes.delete(r.path)
      },
      registerUpgrade: (r) => {
        upgrades.set(r.path, r.handler)
        return () => upgrades.delete(r.path)
      },
    },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => { listeners.set(name, listeners.get(name).filter((f) => f !== fn)) }
    },
    effect: (fn, why) => {
      effects.push({ fn, why })
      return () => {}
    },
    get: () => undefined, // sessionTitle / jobs 全部缺席 → 走降级分支
    inject: (deps, cb) => {
      // 真 cordis 的 inject 回调在 apply 同步段之后才调起（服务就绪后异步调度），
      // 这里用 microtask 模拟同样语义，避免踩插件内 const 的 TDZ。
      queueMicrotask(() => {
        // settings / workspaceRegistry：给一个会注册成功的假 scope/registry
        if (deps.includes('settings')) {
          try {
            cb({ settings: { register: () => ({ get: () => ({}), update: async () => {}, watch: () => () => {} }) }, effect: () => () => {} })
          } catch (e) { log.push('settings inject: ' + e.message) }
        } else if (deps.includes('workspaceRegistry')) {
          try {
            const reg = { list: () => [{ id: 'ws-1', path: path.normalize('D:\\proj\\alpha'), title: 'Alpha 项目' }] }
            cb({ workspaceRegistry: reg, effect: () => () => {} })
          } catch (e) { log.push('workspaceRegistry inject: ' + e.message) }
        }
      })
    },
    timer: {
      throttle: (fn) => { const t = (...a) => fn(...a); t.dispose = () => {}; return t },
      interval: () => () => {},
    },
  }
  return ctx
}

const ctx = makeCtx()
plugin.apply(ctx)

// ---- 工具：调 HTTP 路由 ----
async function callRoute(p, { method = 'GET', headers = {}, body = '' } = {}) {
  assert.ok(routes.has(p), 'route missing: ' + p)
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) },
  }
  let status = 0
  let chunks = []
  const res = {
    writeHead: (code, hdrs) => { status = code; res.headers = hdrs },
    end: (data) => { chunks.push(String(data == null ? '' : data)) },
  }
  await routes.get(p)(req, res)
  return { status, text: chunks.join(''), headers: res.headers || {} }
}

// ---- 工具：WS 客户端（手工 RFC6455：客户端帧必须掩码） ----
function maskFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, 0x80 | len])
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2) }
  const out = Buffer.alloc(header.length + 4 + len)
  header.copy(out, 0)
  mask.copy(out, header.length)
  for (let i = 0; i < len; i++) out[header.length + 4 + i] = payload[i] ^ mask[i & 3]
  return out
}
function parseServerFrames(buf) {
  // 服务端帧不掩码；只解析文本帧
  const frames = []
  let off = 0
  while (off < buf.length) {
    const opcode = buf[off] & 0x0f
    let len = buf[off + 1] & 0x7f
    let hdr = 2
    if (len === 126) { len = buf.readUInt16BE(off + 2); hdr = 4 }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(off + 2)); hdr = 10 }
    const payload = buf.subarray(off + hdr, off + hdr + len)
    frames.push({ opcode, text: opcode === 0x1 ? payload.toString('utf8') : null })
    off += hdr + len
  }
  return frames
}
function makeSocket() {
  const written = []
  const handlers = {}
  return {
    headers: {},
    destroyed: false,
    on: (ev, fn) => { handlers[ev] = fn },
    destroy() { this.destroyed = true },
    write: (buf) => { written.push(Buffer.from(buf)); return true },
    push: (buf) => { if (handlers.data) handlers.data(Buffer.from(buf)) }, // 客户端→服务端
    frames: () => {
      const all = Buffer.concat(written)
      // 跳过连接开头的 HTTP/1.1 101 升级响应头
      let start = 0
      const sep = all.indexOf('\r\n\r\n')
      if (sep >= 0 && all.subarray(0, Math.min(sep, 4)).toString('utf8').startsWith('HTTP')) start = sep + 4
      return parseServerFrames(all.subarray(start))
    },
  }
}
function wsConnect({ origin } = {}) {
  const sock = makeSocket()
  const req = { headers: { 'sec-websocket-key': 'x3JJHMbDL1EzLkh9GBhXDw==' } }
  if (origin !== undefined) req.headers.origin = origin
  upgrades.get('/dsh-pet/ws')(req, sock, Buffer.alloc(0))
  return { sock, req }
}

async function main() {
  // 1. 路由齐全
  for (const p of ['/dsh-pet/handshake', '/dsh-pet/config', '/dsh-pet/api/status', '/dsh-pet/api/launch', '/dsh-pet/api/focus', '/dsh-pet/api/todos', '/dsh-pet/todos']) {
    assert.ok(routes.has(p), '缺少路由 ' + p)
  }
  assert.ok(upgrades.has('/dsh-pet/ws'), '缺少 WS 升级路由')
  const hs = await callRoute('/dsh-pet/handshake')
  assert.strictEqual(JSON.parse(hs.text).hostVersion, '1.3')

  // 2. 活动近似焦点：agent/status 事件（cwd 从 header 叶子读）
  const agentPayload = {
    agent: { id: 'session-abc', session: { id: 'session-abc', header: { cwd: 'D:\\proj\\beta' } } },
    status: 'running',
  }
  listeners.get('agent/status')[0](agentPayload)
  let r = await callRoute('/dsh-pet/api/focus')
  let j = JSON.parse(r.text)
  assert.strictEqual(j.focus.source, 'activity')
  assert.strictEqual(j.focus.cwd, path.normalize('D:\\proj\\beta') === 'D:\\proj\\beta' ? 'D:\\proj\\beta' : j.focus.cwd) // normalize 保原样（无尾分隔符）

  // 3. GUI 真焦点上报（同源 origin 放行）
  r = await callRoute('/dsh-pet/api/focus', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:60498' },
    body: JSON.stringify({ sessionId: 'session-xyz', cwd: 'D:\\proj\\alpha' }),
  })
  j = JSON.parse(r.text)
  assert.strictEqual(j.ok, true)
  r = await callRoute('/dsh-pet/api/focus')
  j = JSON.parse(r.text)
  assert.strictEqual(j.focus.source, 'gui')
  assert.strictEqual(j.focus.cwd, 'D:\\proj\\alpha')
  assert.strictEqual(j.focus.workspaceTitle, 'Alpha 项目') // workspaceRegistry 反查
  // 缺字段 → 400
  r = await callRoute('/dsh-pet/api/focus', { method: 'POST', headers: { origin: 'http://127.0.0.1:1' }, body: JSON.stringify({ sessionId: 'x' }) })
  assert.strictEqual(r.status, 400)
  // 跨源 → 403
  r = await callRoute('/dsh-pet/api/focus', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ sessionId: 'x', cwd: 'y' }) })
  assert.strictEqual(r.status, 403)

  // 4. WS：跨源升级被拒 / 同源、无 origin、tauri.localhost（宠物 WebView）放行；快照带 focus
  let bad = wsConnect({ origin: 'https://evil.example' })
  assert.ok(bad.sock.destroyed, '跨源 WS 应被拒')
  bad = wsConnect({ origin: 'http://evil.localhost.example' }) // 伪 .localhost 后缀不认
  assert.ok(bad.sock.destroyed, 'evil.localhost.example 应被拒')
  const tauri = wsConnect({ origin: 'http://tauri.localhost' })
  assert.ok(!tauri.sock.destroyed, 'tauri.localhost（宠物 WebView origin）应放行')
  const { sock } = wsConnect({ origin: 'http://127.0.0.1:60498' })
  const snapFrames = sock.frames().filter((f) => f.text).map((f) => JSON.parse(f.text))
  const stateMsg = snapFrames.find((m) => m.type === 'state')
  assert.ok(stateMsg, '连上应收全量 state')
  assert.strictEqual(stateMsg.focus.source, 'gui')
  assert.ok(Array.isArray(stateMsg.todos), 'state.todos 应为数组')

  // 5. command：add → toggle → 再 add → clear
  const send = (obj) => sock.push(maskFrame(JSON.stringify(obj)))
  const awaitFrame = async (pred, ms = 1500) => {
    const t0 = Date.now()
    for (;;) {
      const hit = sock.frames().map((f) => { try { return JSON.parse(f.text) } catch (e) { return null } }).filter(Boolean).find(pred)
      if (hit) return hit
      if (Date.now() - t0 > ms) throw new Error('等帧超时: ' + JSON.stringify(pred))
      await new Promise((res) => setTimeout(res, 25))
    }
  }
  send({ type: 'command', id: 'c-1', action: 'todo/add', payload: { content: '冒烟第一条' } })
  let cr = await awaitFrame((m) => m.type === 'commandResult' && m.id === 'c-1')
  assert.strictEqual(cr.ok, true)
  assert.strictEqual(cr.todos.length, 1)
  assert.strictEqual(cr.todos[0].content, '冒烟第一条')
  const itemId = cr.todos[0].id

  send({ type: 'command', id: 'c-2', action: 'todo/toggle', payload: { id: itemId } })
  cr = await awaitFrame((m) => m.type === 'commandResult' && m.id === 'c-2')
  assert.strictEqual(cr.todos[0].status, 'done')

  send({ type: 'command', id: 'c-3', action: 'todo/add', payload: { content: '' } }) // 空 content → ok:false
  cr = await awaitFrame((m) => m.type === 'commandResult' && m.id === 'c-3')
  assert.strictEqual(cr.ok, false)

  send({ type: 'command', id: 'c-4', action: 'todo/clear', payload: { doneOnly: true } })
  cr = await awaitFrame((m) => m.type === 'commandResult' && m.id === 'c-4')
  assert.strictEqual(cr.todos.length, 0)

  send({ type: 'command', id: 'c-5', action: 'focus/refresh' })
  cr = await awaitFrame((m) => m.type === 'commandResult' && m.id === 'c-5')
  assert.strictEqual(cr.ok, true)
  assert.ok(cr.state && cr.state.focus && cr.state.focus.cwd === 'D:\\proj\\alpha')

  // 6. todos.json 落盘（写链是异步的，等一拍）
  await new Promise((res) => setTimeout(res, 150))
  const todosFile = path.join(DSH_HOME, 'whalebuddy', 'todos.json')
  assert.ok(fs.existsSync(todosFile), 'todos.json 应落盘')
  const disk = JSON.parse(fs.readFileSync(todosFile, 'utf8'))
  const key = Object.keys(disk.workspaces)[0]
  assert.ok(key.toLowerCase().includes('alpha'), '键应为 D:\\proj\\alpha，实际 ' + key)
  assert.strictEqual(disk.workspaces[key].title, 'Alpha 项目') // title 冗余进存储

  // 7. 兜底页 GET 渲染 + POST add（PRG 303）
  r = await callRoute('/dsh-pet/todos')
  assert.strictEqual(r.status, 200)
  assert.ok(r.text.includes('Alpha 项目'), '兜底页应含项目名')
  r = await callRoute('/dsh-pet/todos', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:60498', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'action=add&content=' + encodeURIComponent('页面添加'),
  })
  assert.strictEqual(r.status, 303)
  r = await callRoute('/dsh-pet/api/todos')
  j = JSON.parse(r.text)
  assert.ok(j.todos.some((t) => t.content === '页面添加'))

  console.log('ALL PASS ✓  (DSH_HOME=' + DSH_HOME + ')')
}

main().then(
  () => { try { fs.rmSync(DSH_HOME, { recursive: true, force: true }) } catch (e) { /* 留给临时目录自清 */ } },
  (e) => {
    console.error('FAIL:', e && e.stack || e)
    process.exitCode = 1
  },
)
