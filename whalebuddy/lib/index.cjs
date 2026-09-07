/**
 * whalebuddy — DeepSeek Harness 桌面宠物感知层插件（DSH bundle 插件包）。
 *
 * 包形态：npm 包 + package.json 里 dsh.bundle.patch 声明 → 作为 profile bundle
 * 被 DSH 的 layer stack 自动加载（安装说明见 README）。可开源分发到任意 DSH。
 * client/client.js（浏览器半侧）把设置卡片注册进 settings.plugin.item 插槽——
 * 设置项出现在 DSH「设置 → 插件 → 插件配置」菜单（与 Host namespace 同名配对）。
 *
 * 职责：
 *  1. 感知：监听 Host 事件流 → 折叠成 state 快照 → /dsh-pet/handshake (HTTP, CORS)
 *     与 /dsh-pet/ws (手写极简 RFC6455) 广播给桌面宠物（whalebuddy 桌面壳）。
 *  2. 设置：向 DSH settings 服务注册 "whalebuddy" namespace
 *     （autostart/launchOnDshStart/petPath/skin），配置项出现在 DSH 设置菜单的
 *     「插件配置」分区（客户端卡片）与自带 /dsh-pet/config 配置页；变更经
 *     settings/watch 感知并即时广播 {type:'config'} 给桌面壳
 *     （autostart → 桌面壳写/删系统 Run 键；skin → 换肤）。
 *     launchOnDshStart=true 时每次 DSH 启动（及开关打开时）若宠物未在线，
 *     本插件自动 spawn 拉起宠物程序（petPath 设置 → 注册表 Run 键两级发现）。
 *  3. 批准交互：approval/request waterfall 里当"宠物回答者"——宠物客户端在线时
 *     把待批请求推给宠物（approval/asked），等宠物回 approval/respond；
 *     宠物不在线 / 全部断开 / 超时（5min）则 next() 交回 api-proxy 的 GUI 卡片路径。
 *     两条路径互斥且都经 ApprovalService 的 asked/decided 审计事件落日志，
 *     不绕过任何权限语义。
 *  4. 工作区聚焦与项目待办（v0.3，docs/11）：
 *     - 焦点 = GUI client 半边 POST /dsh-pet/api/focus 上报的真选中会话
 *       （client-runtime sessions.list 的 current + byId[current].cwd），
 *       last-writer-wins；15s 无新鲜上报回落"最近发事件的会话"近似
 *       （cwd 取 agent.session.header.cwd 叶子）。cwd 经 workspaceRegistry
 *       （可选注入）反查项目名。
 *     - 待办 = 自建 per-workspace 存储（$DSH_HOME/whalebuddy/todos.json，
 *       按规范化 cwd 分键、原子写）；state 广播 focus + 当前工作区 todos；
 *       宠物经 WS command 通道（todo/add|toggle|remove|edit|clear）增删改，
 *       commandResult 回带最新清单；宠物离线时 /dsh-pet/todos 轻量页兜底。
 *     - Origin 校验：WS 升级与 /dsh-pet/api/* 只收无 Origin（原生客户端）
 *       或回环 Origin（同源 GUI / 本机预览页）的请求，拒绝恶意网页。
 *
 * 平面归属：跨会话（聚合所有会话、消费者是进程外的宠物），按 composition 规范
 * 属宿主平面 —— bundle 层在 profile 根组合里，天然宿主平面。
 * 只消费 webServer/timer 等宿主服务，不发布服务，无需 realm。
 *
 * 领导权守卫：先注册 handshake 路由探测；撞 duplicate（同进程还有动态插件占着）
 * 则进入 follower 模式零副作用返回——绝不重复挂监听器（waterfall 观察器重复
 * 注册会双重计数，llm/stream 多一层包装也多一分风险）。
 *
 * 红线：waterfall 事件（tools/execute, llm/stream, approval/request）只观察必透传
 * （approval 回答者的"透传"= 要么自己答要么 next()，二者恰一次）；live 对象只读
 * 叶子字段，绝不整体序列化。
 */
const { randomUUID } = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// schemastery（DSH 内置，有 CJS 出口）——settings schema 用；加载失败则降级（settings 不可用）
let z = null
try { z = require('@deepseek-ai/schemastery') } catch (e) { /* settings 不可用时降级 */ }

// whalebuddy 设置 schema：autostart（开机自启动）+ launchOnDshStart（DSH 启动时
// 自动拉起宠物）+ petPath（宠物 exe 路径，空=按注册表 Run 键发现）+ skin（皮肤）。
// base 是插件组合配置层的默认值；用户在 DSH 设置菜单的改动覆盖它。
const WHALEBUDDY_NS = 'whalebuddy'
const DEFAULT_CONFIG = {
  autostart: false,
  launchOnDshStart: false,
  petPath: '',
  skin: 'dsh-black-whale',
}

// ---------------- 模块级工具：Origin 校验 / TodosStore / basename ----------------

// Origin 校验（docs/11 §3.4）：非浏览器客户端（宠物壳原生 WS / curl / PowerShell 探测）
// 不带 Origin，一律放行；浏览器来源只收回环 origin——127.0.0.1 / localhost /
// *.localhost（按 RFC 6761 都是回环域；Tauri WebView 页面 origin 是
// http://tauri.localhost，宠物 UI 的 WS/fetch 从这里发出）/ [::1]，端口不限
// （本机其他端口的预览页如 proto 8765 也放行）。拒绝一切非回环来源——防恶意网页
// 跨源连 WS 答批准/发命令（跨源 WS 连接不受浏览器同源策略限制，服务端必须自查）。
function originAllowed(req) {
  try {
    const origin = req && req.headers && req.headers.origin
    if (origin === undefined || origin === '') return true
    const host = String(new URL(origin).hostname || '').toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.localhost')
  } catch (e) {
    return false
  }
}

function basenameOf(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

// TodosStore：per-workspace 待办，$DSH_HOME/whalebuddy/todos.json（docs/11 §4.2）。
// - 惰性同步加载（首访问一次小文件读）；写路径走 promise 链串行 + tmp/rename 原子替换；
// - 键 = 规范化 cwd（去尾分隔符；Windows 大小写不敏感的归一留给 workspaceRegistry 匹配层）；
// - 上限：单工作区 200 条 / 单条 500 字符（超限报错，不静默截断内容）。
function createTodosStore(log) {
  const MAX_ITEMS = 200
  const MAX_CONTENT = 500
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = path.join(home, 'whalebuddy')
  const file = path.join(dir, 'todos.json')
  let data = null // { version: 1, workspaces: { [cwd]: { title, updatedAt, items[] } } }
  let writeChain = Promise.resolve()

  function ensureLoaded() {
    if (data) return
    try {
      if (fsSync.existsSync(file)) {
        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8'))
        if (parsed && parsed.version === 1 && parsed.workspaces && typeof parsed.workspaces === 'object') {
          data = parsed
          return
        }
      }
    } catch (e) {
      log('todos.json 读取失败，备份后重建：' + ((e && e.message) || e))
      try { fsSync.copyFileSync(file, file + '.bak') } catch (e2) { /* 无旧文件或不可读 */ }
    }
    data = { version: 1, workspaces: {} }
  }
  function keyOf(cwd) {
    const k = path.normalize(String(cwd || '')).replace(/[\\/]+$/, '')
    return k || String(cwd || '')
  }
  function wsOf(cwd, create) {
    ensureLoaded()
    const k = keyOf(cwd)
    let w = data.workspaces[k]
    if (!w && create) {
      w = { title: '', updatedAt: 0, items: [] }
      data.workspaces[k] = w
    }
    return w
  }
  function persist() {
    writeChain = writeChain.then(() => {
      try {
        fsSync.mkdirSync(dir, { recursive: true })
        const tmp = file + '.' + randomUUID().slice(0, 8) + '.tmp'
        fsSync.writeFileSync(tmp, JSON.stringify(data), 'utf8')
        fsSync.renameSync(tmp, file)
      } catch (e) {
        log('todos.json 写入失败：' + ((e && e.message) || e))
      }
    }, () => { /* 前一写失败不阻断后续 */ })
    return writeChain
  }
  const cloneItems = (w) => (w ? w.items.map((it) => ({ ...it })) : [])
  const normContent = (content) => {
    const c = String(content == null ? '' : content).trim().slice(0, MAX_CONTENT)
    if (!c) throw new Error('content 不能为空')
    return c
  }
  const findItem = (w, id) => (w ? w.items.find((it) => it.id === id) : null)

  return {
    file,
    listFor(cwd) { return cloneItems(wsOf(cwd, false)) },
    titleOf(cwd) { const w = wsOf(cwd, false); return (w && w.title) || '' },
    async setTitle(cwd, title) {
      const w = wsOf(cwd, false)
      const t = String(title || '').slice(0, 200)
      if (!w || !t || w.title === t) return
      w.title = t
      await persist()
    },
    async add(cwd, content) {
      const c = normContent(content)
      const w = wsOf(cwd, true)
      if (w.items.length >= MAX_ITEMS) throw new Error(`该工作区待办已达上限 ${MAX_ITEMS} 条`)
      const now = Date.now()
      w.items.push({ id: randomUUID(), content: c, status: 'pending', createdAt: now, updatedAt: now })
      w.updatedAt = now
      await persist()
      return cloneItems(w)
    },
    async toggle(cwd, id) {
      const w = wsOf(cwd, false)
      const it = findItem(w, String(id || ''))
      if (!it) return cloneItems(w)
      it.status = it.status === 'done' ? 'pending' : 'done'
      it.updatedAt = Date.now()
      w.updatedAt = it.updatedAt
      await persist()
      return cloneItems(w)
    },
    async remove(cwd, id) {
      const w = wsOf(cwd, false)
      if (!w || !w.items.some((it) => it.id === id)) return cloneItems(w)
      w.items = w.items.filter((it) => it.id !== id)
      w.updatedAt = Date.now()
      await persist()
      return cloneItems(w)
    },
    async edit(cwd, id, content) {
      const c = normContent(content)
      const w = wsOf(cwd, false)
      const it = findItem(w, String(id || ''))
      if (!it) throw new Error('待办条目不存在')
      it.content = c
      it.updatedAt = Date.now()
      w.updatedAt = it.updatedAt
      await persist()
      return cloneItems(w)
    },
    async clear(cwd, doneOnly) {
      const w = wsOf(cwd, false)
      if (!w) return cloneItems(w)
      const before = w.items.length
      w.items = doneOnly === false ? [] : w.items.filter((it) => it.status !== 'done')
      if (w.items.length === before) return cloneItems(w)
      w.updatedAt = Date.now()
      await persist()
      return cloneItems(w)
    },
  }
}


module.exports = {
  name: 'whalebuddy',
  inject: ['webServer', 'timer'],
  apply(ctx) {
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    // HTML escape（/dsh-pet/config 渲染表单时用，防 skin 等用户可写字段注入）
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const disposers = []
    const keep = (d) => { if (typeof d === 'function') disposers.push(d) }

    // whalebuddy 配置（settings 合并结果；启动时为默认值，settings 服务注入后刷新）。
    // 定义在 leader 探测之前，因为 handshake handler 会引用它。
    const cfg = {
      autostart: DEFAULT_CONFIG.autostart,
      launchOnDshStart: DEFAULT_CONFIG.launchOnDshStart,
      petPath: DEFAULT_CONFIG.petPath,
      skin: DEFAULT_CONFIG.skin,
    }
    // settings scope 引用（settings 段填，config 路由 POST 写回用）
    let writeConfig = async () => { throw new Error('settings service not available') }

    // ---------------- 0. 领导权探测（必须最先做） ----------------
    let leader = true
    try {
      keep(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-pet/handshake',
        handler: (req, res) => {
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          })
          res.end(JSON.stringify({
            ok: true, name: 'whalebuddy', protocolVersion: 1, hostVersion: '1.3', wsPath: '/dsh-pet/ws',
            features: ['approval', 'focus', 'todos'],
            config: { autostart: cfg.autostart, launchOnDshStart: cfg.launchOnDshStart, petPath: cfg.petPath, skin: cfg.skin },
          }))
        },
      }))

      // /dsh-pet/config — whalebuddy 设置页（极简 HTML 表单，浏览器可访问的轻量集成）。
      // 替代 DSH 设置菜单（每个 settings namespace 需要专门的 client UI 包才能在菜单里渲染）。
      // 注意：webServer.register 按 (kind,path) 去重、不区分 method —— GET/POST 必须共用一个 handler，
      // 否则第二个 register 抛 duplicate 会误触发 follower 模式（教训：曾让插件半初始化）。
      keep(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-pet/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            const skin = escapeHtml(cfg.skin)
            const petPath = escapeHtml(cfg.petPath)
            const checked = cfg.autostart ? ' checked' : ''
            const checkedLods = cfg.launchOnDshStart ? ' checked' : ''
            const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>whalebuddy 设置</title>` +
              `<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0e1726;color:#cfd8e3;max-width:480px;margin:48px auto;padding:0 20px}` +
              `h1{font-size:18px;font-weight:600;margin:0 0 24px}label{display:block;margin:16px 0 6px;font-size:13px;color:#8aa0b4}` +
              `input[type=text]{width:100%;box-sizing:border-box;padding:8px 10px;background:#1a2436;color:#cfd8e3;border:1px solid #2a3a52;border-radius:6px;font:inherit}` +
              `.row{display:flex;align-items:center;gap:10px;margin:16px 0 24px}.row input{width:18px;height:18px;margin:0}` +
              `button{background:#2b6cff;color:#fff;border:0;border-radius:6px;padding:9px 18px;font:inherit;cursor:pointer}` +
              `button:hover{background:#3b7cff}.hint{font-size:12px;color:#8aa0b4;margin-top:8px}</style></head><body>` +
              `<h1>🐋 whalebuddy 设置</h1>` +
              `<p style="font-size:12px;color:#8aa0b4">推荐在 DSH「设置 → 插件 → 插件配置」菜单里配置（本页为轻量备用）。</p>` +
              `<form method="post" action="/dsh-pet/config">` +
              `<div class="row"><input type="checkbox" id="autostart" name="autostart" value="1"${checked}>` +
              `<label for="autostart" style="margin:0">开机自启动桌面宠物（Windows 注册表 Run 键）</label></div>` +
              `<div class="row"><input type="checkbox" id="launchOnDshStart" name="launchOnDshStart" value="1"${checkedLods}>` +
              `<label for="launchOnDshStart" style="margin:0">DSH Desktop 启动时自动启动宠物（未在线时自动拉起）</label></div>` +
              `<label for="petPath">宠物程序路径</label>` +
              `<input type="text" id="petPath" name="petPath" value="${petPath}" placeholder="留空 = 按注册表 Run 键自动发现">` +
              `<div class="hint">dsh-pet.exe 完整路径；用于 DSH 启动自启与「立即启动」。留空则读开机自启注册表键。</div>` +
              `<label for="skin">皮肤</label>` +
              `<input type="text" id="skin" name="skin" value="${skin}" placeholder="dsh-black-whale">` +
              `<div class="hint">皮肤 id 由桌面壳识别；默认 dsh-black-whale。</div>` +
              `<div style="margin-top:24px"><button type="submit">保存</button></div>` +
              `</form></body></html>`
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(html)
            return
          }
          // POST：解析表单 → settings.update → 303 回 GET（PRG 模式）
          try {
            const chunks = []
            for await (const c of req) chunks.push(c)
            const body = Buffer.concat(chunks).toString('utf8')
            const params = new URLSearchParams(body)
            const patch = {
              autostart: params.get('autostart') === '1',
              launchOnDshStart: params.get('launchOnDshStart') === '1',
              petPath: (params.get('petPath') || '').toString().slice(0, 512),
              skin: (params.get('skin') || '').toString().slice(0, 64) || DEFAULT_CONFIG.skin,
            }
            await writeConfig(patch)
            res.writeHead(303, { location: '/dsh-pet/config', 'cache-control': 'no-store' })
            res.end()
          } catch (e) {
            console.error('[whalebuddy] config POST', e)
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('保存失败：settings 服务不可用或写入错误。详细：' + escapeHtml(String((e && e.message) || e)))
          }
        },
      }))
    } catch (e) {
      if (/duplicate/.test(String((e && e.message) || ''))) {
        leader = false
        console.log('[whalebuddy] follower mode: /dsh-pet routes already held by another instance, idling')
      } else {
        throw e
      }
    }

    if (!leader) {
      // follower：零副作用。disposers 此刻只含本次成功的注册（无），仍按惯例挂清理。
      ctx.effect(() => () => {
        for (let i = 0; i < disposers.length; i++) {
          try { disposers[i]() } catch (e) { /* 清理尽力而为 */ }
        }
      }, 'whalebuddy: follower teardown')
      return
    }

    // ---------------- 1. StateAggregator ----------------
    const agg = {
      session: { id: '', title: '', status: 'idle', turn: 0 }, // 展示焦点 = 最近发事件的会话
      activity: 'idle',
      activityIntensity: 0,
      awaitingApproval: { pending: false, summary: null },
      subagents: 0,
      jobs: [],
      workflow: { running: false, phase: null },
      tokens: { estimated: 0 },
      pulse: null, // { kind: 'panic' | 'celebrating', at }
      sessions: { running: 0, list: [] }, // 多会话聚合：running 计数 + 前 4 个运行中会话
      focus: null,   // { sessionId, cwd, workspaceId, workspaceTitle, source, reportedAt } | null
      todos: [],     // 当前聚焦工作区的待办（TodosStore 投影）
    }
    let thinkTicks = 0        // 自上次 flush 以来的 llm chunk 数
    let toolInFlight = 0      // 进行中的工具调用数
    let currentActivity = null // 工具触发的 activity（工具结束后保留至 flush 仲裁）
    let lastJson = ''
    let approvalCount = 0     // 进行中的批准请求数（多会话并发时不会互相误清）
    const agents = new Map()  // agentId -> { id, title, status, cwd }，全局 status 由所有条目派生

    // ---------------- 1.1 焦点与待办（docs/11 §4） ----------------
    // 焦点两级来源：GUI client 半边的真焦点上报（last-writer-wins，多窗口取最后），
    // 15s 无新鲜上报回落"最近发事件的会话"近似（cwd 取 agent.session.header.cwd 叶子）。
    const FOCUS_STALE_MS = 15000
    let focusReport = null // { sessionId, cwd, at } — /dsh-pet/api/focus 上报原文
    const todosStore = createTodosStore((m) => console.error('[whalebuddy] ' + m))
    // workspaceRegistry（可选注入，apiproxy 同名服务）的 cwd→{id,title} 反查，5s 缓存
    let wsRegistryList = null // null = 服务缺席；否则 fn -> [{ id, path, title }]
    let wsRegistryAt = 0
    function registryLookup(cwd) {
      if (!wsRegistryList) return null
      const target = path.normalize(String(cwd || '')).replace(/[\\/]+$/, '').toLowerCase()
      try {
        const rows = wsRegistryList() || []
        for (const w of rows) {
          const p = path.normalize(String(w.path || '')).replace(/[\\/]+$/, '').toLowerCase()
          if (p && p === target) return { id: String(w.id || ''), title: String(w.title || '') }
        }
      } catch (e) { /* 列表读取失败按无反查处理 */ }
      return null
    }
    function computeFocus() {
      const now = Date.now()
      if (focusReport && now - focusReport.at < FOCUS_STALE_MS && focusReport.cwd) {
        const meta = registryLookup(focusReport.cwd)
        return {
          sessionId: focusReport.sessionId,
          cwd: focusReport.cwd,
          workspaceId: meta ? meta.id : null,
          workspaceTitle: meta && meta.title ? meta.title : (todosStore.titleOf(focusReport.cwd) || basenameOf(focusReport.cwd)),
          source: 'gui',
          reportedAt: focusReport.at,
        }
      }
      const entry = agents.get(agg.session.id)
      if (entry && entry.cwd) {
        const meta = registryLookup(entry.cwd)
        return {
          sessionId: entry.id,
          cwd: entry.cwd,
          workspaceId: meta ? meta.id : null,
          workspaceTitle: meta && meta.title ? meta.title : (todosStore.titleOf(entry.cwd) || basenameOf(entry.cwd)),
          source: 'activity',
          reportedAt: 0,
        }
      }
      return null
    }
    function currentFocusCwd() {
      const f = computeFocus()
      return f ? f.cwd : null
    }

    const TOOL_ACTIVITY = [
      [/^(pwsh|shell|bash|exec|terminal|run_command)/, 'cmd'],
      [/^(web_search|web_fetch|fetch|search)/, 'search'],
      [/^(subagent|workflow|ralph|send_message|interrupt_agent|list_agents|job_)/, 'spawning'],
      [/^(ask_user_question|ask)/, 'waiting'],
      [/^(todo_write|todo_read|skill|cordis_|get_goal|create_goal|update_goal|exit_plan_mode|plan)/, 'thinking'],
      [/^(read|write|edit|glob|grep|read_image|notebook|apply_patch)/, 'coding'],
    ]
    const classify = (name) => {
      for (let i = 0; i < TOOL_ACTIVITY.length; i++) {
        if (TOOL_ACTIVITY[i][0].test(name)) return TOOL_ACTIVITY[i][1]
      }
      return 'coding'
    }

    function snapshot() {
      return {
        type: 'state',
        protocolVersion: 1,
        ts: Date.now(),
        session: {
          id: agg.session.id,
          title: agg.session.title,
          status: agg.session.status,
          turn: agg.session.turn,
          cwd: agg.focus ? agg.focus.cwd : null,
        },
        focus: agg.focus ? {
          sessionId: agg.focus.sessionId,
          cwd: agg.focus.cwd,
          workspaceId: agg.focus.workspaceId,
          workspaceTitle: agg.focus.workspaceTitle,
          source: agg.focus.source,
          reportedAt: agg.focus.reportedAt,
        } : null,
        todos: agg.todos.map((it) => ({
          id: it.id, content: it.content, status: it.status,
          createdAt: it.createdAt, updatedAt: it.updatedAt,
        })),
        activity: agg.activity,
        activityIntensity: agg.activityIntensity,
        awaitingApproval: {
          pending: agg.awaitingApproval.pending,
          summary: agg.awaitingApproval.summary,
        },
        subagents: { running: agg.subagents },
        sessions: {
          running: agg.sessions.running,
          list: agg.sessions.list.map((a) => ({ id: a.id, title: a.title, cwd: a.cwd || null, status: a.status })),
        },
        jobs: agg.jobs.map((j) => ({ id: j.id, desc: j.desc, status: j.status })),
        workflow: { running: agg.workflow.running, phase: agg.workflow.phase },
        tokens: { estimated: agg.tokens.estimated },
        pulse: agg.pulse ? { kind: agg.pulse.kind, at: agg.pulse.at } : null,
        config: { autostart: cfg.autostart, launchOnDshStart: cfg.launchOnDshStart, petPath: cfg.petPath, skin: cfg.skin },
      }
    }

    function flush() {
      try {
        agg.activityIntensity = thinkTicks > 40 ? 3 : thinkTicks > 15 ? 2 : thinkTicks > 0 ? 1 : 0
        thinkTicks = 0
        if (toolInFlight > 0 && currentActivity) agg.activity = currentActivity
        else if (agg.session.status === 'running') agg.activity = 'thinking'
        else agg.activity = 'idle'
        if (agg.pulse && Date.now() - agg.pulse.at > 8000) agg.pulse = null
        // 焦点与待办：每次 flush 重算（上报新鲜度 / 活动近似切换），title 冗余进存储
        agg.focus = computeFocus()
        agg.todos = agg.focus ? todosStore.listFor(agg.focus.cwd) : []
        if (agg.focus && agg.focus.cwd && agg.focus.workspaceTitle) {
          todosStore.setTitle(agg.focus.cwd, agg.focus.workspaceTitle).catch(() => { /* 尽力而为 */ })
        }
        // 标题轮询：若某个会话的标题刚被异步填上，这里把它推到宠物
        const titleChanged = pollTitles()
        if (titleChanged) {
          const focused = agents.get(agg.session.id)
          if (focused && focused.title) agg.session.title = focused.title
        }
        const msg = snapshot()
        const json = JSON.stringify(msg)
        if (json === lastJson) return
        lastJson = json
        broadcast(msg)
      } catch (e) { console.error('[whalebuddy] flush', e) }
    }

    let throttledFlush = flush
    try {
      const t = (ctx.timer && typeof ctx.timer.throttle === 'function')
        ? ctx.timer
        : (typeof ctx.throttle === 'function' ? ctx : null)
      if (t) { throttledFlush = t.throttle(flush, 500); keep(throttledFlush.dispose) }
    } catch (e) { console.error('[whalebuddy] throttle', e) }
    const markDirty = () => { try { throttledFlush() } catch (e) { console.error('[whalebuddy] markDirty', e) } }

    // ---------------- 1.5 whalebuddy 设置（settings 服务可选） ----------------
    // 注册 "whalebuddy" namespace → DSH「设置 → 插件 → 插件配置」菜单的客户端卡片
    // （client/client.js）与自带 /dsh-pet/config 配置页均可读写；
    // 用户改动经 scope.watch 感知 → 即时广播 {type:'config'} 给桌面壳。
    // settings 服务不存在（无 dsh-settings-file 的组合）时静默降级，不影响感知。
    try {
      ctx.inject(['settings'], (sctx) => {
        if (z === null) {
          console.error('[whalebuddy] schemastery 不可用，settings 注册跳过（仅状态感知）')
          return
        }
        let scope
        try {
          scope = sctx.settings.register(WHALEBUDDY_NS, z.object({
            autostart: z.boolean().default(DEFAULT_CONFIG.autostart),
            launchOnDshStart: z.boolean().default(DEFAULT_CONFIG.launchOnDshStart),
            petPath: z.string().default(DEFAULT_CONFIG.petPath),
            skin: z.string().default(DEFAULT_CONFIG.skin),
          }), { base: { ...DEFAULT_CONFIG } })
          // 让 /dsh-pet/config POST 能写回 settings（PRG 模式 → scope.update → watch → broadcast）
          writeConfig = async (patch) => scope.update(patch)
        } catch (e) {
          console.error('[whalebuddy] settings.register', e)
          return
        }
        const applyConfig = () => {
          let v = {}
          try { v = scope.get() || {} } catch (e) { /* 读不到就用默认 */ }
          const next = {
            autostart: v.autostart === true,
            launchOnDshStart: v.launchOnDshStart === true,
            petPath: typeof v.petPath === 'string' ? v.petPath.slice(0, 512) : '',
            skin: typeof v.skin === 'string' && v.skin ? v.skin : DEFAULT_CONFIG.skin,
          }
          const changed = next.autostart !== cfg.autostart
            || next.launchOnDshStart !== cfg.launchOnDshStart
            || next.petPath !== cfg.petPath
            || next.skin !== cfg.skin
          cfg.autostart = next.autostart
          cfg.launchOnDshStart = next.launchOnDshStart
          cfg.petPath = next.petPath
          cfg.skin = next.skin
          if (changed) {
            try {
              broadcast({ type: 'config', protocolVersion: 1, ts: Date.now(), config: { ...cfg } })
              markDirty()
            } catch (e) { console.error('[whalebuddy] config broadcast', e) }
          }
          // launchOnDshStart 打开（或 DSH 启动首次读到 true）→ 启动观察器：
          // 已连接即结束；进程存活等它重连；进程不在则拉起（见 1.6）
          maybeLaunchPet(next.launchOnDshStart ? 'settings' : 'startup-check')
        }
        applyConfig()
        const stopWatch = scope.watch(applyConfig)
        sctx.effect(() => () => {
          try { stopWatch() } catch (e) { /* 清理尽力而为 */ }
        }, 'whalebuddy: settings scope')
      })
    } catch (e) { console.error('[whalebuddy] settings inject', e) }

    // ---------------- 1.55 workspaceRegistry（可选注入，焦点反查项目名） ----------------
    // apiproxy 同名服务的 list() 即 workspace.list 的数据源（id/path/title）。
    // 服务缺席（无 dsh-workspace 组合）时静默降级：workspaceTitle 回落 basename。
    try {
      ctx.inject(['workspaceRegistry'], (wctx) => {
        const reg = wctx.workspaceRegistry
        if (reg && typeof reg.list === 'function') {
          wsRegistryList = () => reg.list().map((w) => ({ id: w.id, path: w.path, title: w.title }))
          wsRegistryAt = Date.now()
          // 延迟一拍再标脏：注入回调若在 apply 同步段内被调起，markDirty→flush→broadcast
          // 会踩到尚未初始化的 conns（TDZ）；queueMicrotask 保证 apply 先完成
          queueMicrotask(() => { try { markDirty() } catch (e) { /* 应用层尽最大努力 */ } })
        }
        wctx.effect(() => () => { if (wsRegistryList) { wsRegistryList = null; wsRegistryAt = 0 } }, 'whalebuddy: workspaceRegistry')
      })
    } catch (e) { console.error('[whalebuddy] workspaceRegistry inject', e) }

    // ---------------- 1.6 宠物进程拉起（launchOnDshStart / 手动） ----------------
    // 发现顺序：petPath 设置（须存在）→ 注册表 Run 键（开机自启键里已有 exe 路径）。
    // 守卫：宠物已在线不拉起；宠物进程存活（未连上）不拉起——WebView2 用户数据目录
    // 互锁会让新实例立即退出，表现为"自启没生效"；自动拉起 15s 防抖；
    // 手动（force）绕过防抖不绕过在线/存活检查。
    const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    let lastLaunchAt = 0
    let watchTimer = null

    function readRunKeyExe() {
      return new Promise((resolve) => {
        try {
          execFile('reg', ['query', RUN_KEY, '/v', 'whalebuddy'], { windowsHide: true }, (err, stdout) => {
            if (err) { resolve(null); return }
            const s = String(stdout || '')
            // 规范形态是带引号的完整路径 + " --autostart" 尾参；兜底无引号形态（用户手改键值）
            const quoted = /"([^"]+\.(?:exe|EXE))"/.exec(s)
            if (quoted) { resolve(quoted[1]); return }
            const bare = /([A-Za-z]:\\[^\s]+\.exe)/i.exec(s)
            resolve(bare ? bare[1] : null)
          })
        } catch (e) { resolve(null) }
      })
    }

    async function resolvePetExe() {
      const p = String(cfg.petPath || '').trim().replace(/^"|"$/g, '')
      if (p) {
        try {
          if (fsSync.existsSync(p)) return p
        } catch (e) { /* 落到 Run 键发现 */ }
        console.warn(`[whalebuddy] petPath 路径不存在：${p}，回退注册表 Run 键`)
      }
      return readRunKeyExe()
    }

    // tasklist CSV 输出里找进程名（locale 无关：按行首 "名字" 匹配；未找到时输出的是
    // 本地化 INFO 行，不以引号开头，天然不匹配）。
    function tasklistHasProcess(stdout, base) {
      const want = '"' + String(base || '').toLowerCase() + '"'
      return String(stdout || '')
        .split(/\r?\n/)
        .some((line) => line.trim().toLowerCase().startsWith(want))
    }

    function petProcessAlive(exe) {
      return new Promise((resolve) => {
        try {
          const base = String(exe || '').split(/[\\/]+/).pop() || 'dsh-pet.exe'
          execFile('tasklist', ['/FI', `IMAGENAME eq ${base}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
            resolve(!err && tasklistHasProcess(stdout, base))
          })
        } catch (e) { resolve(false) }
      })
    }

    async function launchPet(reason, opts) {
      const force = !!(opts && opts.force)
      if (!leader) return { launched: false, reason: 'follower' }
      if (conns.size > 0) return { launched: false, reason: 'pet-connected' }
      const exe = await resolvePetExe()
      if (!exe) {
        console.warn('[whalebuddy] 未找到宠物程序（petPath 未配置且注册表 Run 键无 whalebuddy 项）')
        return { launched: false, reason: 'exe-not-found' }
      }
      // 宠物进程已在跑（只是还没连上）：绝不重复拉起——WebView2 用户数据目录互锁，
      // 新实例会立即退出（表现为"自启没生效"）。它自己的重连循环（断开 3s 后重发现，
      // netstat 命中约 1s）会很快连回来。
      if (await petProcessAlive(exe)) {
        console.log(`[whalebuddy] 宠物进程已在运行（${exe}），等待其自行重连 DSH`)
        return { launched: false, reason: 'process-running', exe }
      }
      const now = Date.now()
      if (!force && now - lastLaunchAt < 15000) return { launched: false, reason: 'debounced' }
      lastLaunchAt = now
      // 测试/诊断钩子：WHALEBUDDY_DRY_RUN=1 时只解析路径不真正 spawn
      if (process.env.WHALEBUDDY_DRY_RUN === '1') {
        console.log(`[whalebuddy] dry-run（不启动）：${exe}`)
        return { launched: true, dryRun: true, exe, reason }
      }
      try {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        console.log(`[whalebuddy] 宠物已拉起（${reason}）：${exe} pid=${child.pid}`)
        return { launched: true, exe, reason }
      } catch (e) {
        console.error('[whalebuddy] 拉起宠物失败：', (e && e.message) || e)
        return { launched: false, reason: 'spawn-failed' }
      }
    }

    // 观察器（替代单次 4s 定时）：开关打开 / settings 提交后启动，每 5s 检查一次，
    // 最多观察 120s：
    //   已连接            → 结束（宠物在）
    //   进程活着但没连上  → 继续等（宠物断连重连循环自己会连回来，重复拉起只会
    //                       因 WebView2 目录锁失败）
    //   进程不在          → 拉起一次（launchPet 内部含防抖；拉起失败即结束观察）
    // conns 只在延迟回调里读，避免 settings 回调在 conns（第 2 节定义）初始化前踩 TDZ。
    function stopLaunchWatch() {
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
    }

    function maybeLaunchPet(reason) {
      if (cfg.launchOnDshStart !== true) return
      if (watchTimer) return // 观察周期已在进行
      const startedAt = Date.now()
      let saidWaiting = false
      const tick = async () => {
        if (cfg.launchOnDshStart !== true || conns.size > 0) { stopLaunchWatch(); return }
        const r = await launchPet(reason)
        if (r.reason === 'process-running') {
          if (!saidWaiting) { saidWaiting = true; console.log('[whalebuddy] 观察中：宠物进程存活，等待重连') }
        } else if (r.reason === 'exe-not-found' || r.reason === 'spawn-failed') {
          stopLaunchWatch() // 再试也无意义，等用户配置路径
        }
        if (Date.now() - startedAt > 120000) {
          console.log('[whalebuddy] DSH 启动自启观察周期结束（120s）')
          stopLaunchWatch()
        }
      }
      watchTimer = setInterval(() => { tick().catch(() => { /* 已在内部记日志 */ }) }, 5000)
      if (typeof watchTimer.unref === 'function') watchTimer.unref()
    }

    // ---------------- 2. 极简 RFC6455 服务端 ----------------
    function sha1Words(bytes) {
      const ml = bytes.length
      const total = (((ml + 8) >> 6) + 1) << 6
      const m = new Uint8Array(total)
      m.set(bytes)
      m[ml] = 0x80
      m[total - 1] = (ml << 3) & 255
      m[total - 2] = (ml << 3 >>> 8) & 255
      m[total - 3] = (ml >>> 13) & 255
      m[total - 4] = (ml >>> 21) & 255
      let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0
      const w = new Array(80)
      for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) {
          w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3]
        }
        for (let i = 16; i < 80; i++) {
          const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
          w[i] = (n << 1) | (n >>> 31)
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4
        for (let i = 0; i < 80; i++) {
          let f, k
          if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999 }
          else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1 }
          else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC }
          else { f = b ^ c ^ d; k = 0xCA62C1D6 }
          const t = ((((a << 5) | (a >>> 27)) + f) | 0) + (e + k + w[i] | 0) | 0
          e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0
      }
      return [h0, h1, h2, h3, h4]
    }
    // 手写 base64（DSH 内置 btoa 把输入当 UTF-8 文本再编码，对含高位字节的 20 字节摘要会膨胀）
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    function b64encode(bytes) {
      const len = bytes.length
      let out = ''
      let i = 0
      for (; i + 2 < len; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2]
        out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + B64[((b1 & 15) << 2) | (b2 >> 6)] + B64[b2 & 63]
      }
      const rem = len - i
      if (rem === 1) {
        const b0 = bytes[i]
        out += B64[b0 >> 2] + B64[(b0 & 3) << 4] + '=='
      } else if (rem === 2) {
        const b0 = bytes[i], b1 = bytes[i + 1]
        out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + B64[(b1 & 15) << 2] + '='
      }
      return out
    }
    function wsAcceptKey(key) {
      const input = enc.encode(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      const words = sha1Words(input)
      const digest = new Uint8Array(20)
      for (let wi = 0; wi < 5; wi++) {
        const w = words[wi]
        digest[wi * 4] = (w >>> 24) & 255
        digest[wi * 4 + 1] = (w >>> 16) & 255
        digest[wi * 4 + 2] = (w >>> 8) & 255
        digest[wi * 4 + 3] = w & 255
      }
      return b64encode(digest)
    }
    function frameText(str) {
      const p = enc.encode(str)
      const len = p.length
      let h
      if (len < 126) {
        h = new Uint8Array([0x81, len])
      } else if (len < 65536) {
        h = new Uint8Array([0x81, 126, (len >> 8) & 255, len & 255])
      } else {
        h = new Uint8Array(10)
        h[0] = 0x81; h[1] = 127
        let n = len
        for (let i = 9; i >= 2; i--) { h[i] = n & 255; n = Math.floor(n / 256) }
      }
      const out = new Uint8Array(h.length + len)
      out.set(h)
      out.set(p, h.length)
      return out
    }
    function frameControl(opcode, payload) {
      const out = new Uint8Array(2 + payload.length)
      out[0] = 0x80 | opcode
      out[1] = payload.length
      out.set(payload, 2)
      return out
    }

    // 连接表与解析
    const conns = new Set()
    function closeConn(conn) {
      conn.alive = false
      conns.delete(conn)
      onClientsChanged()
      try { conn.socket.destroy() } catch (e) { /* 已关 */ }
    }
    function broadcast(msg) {
      const frame = frameText(JSON.stringify(msg))
      conns.forEach((conn) => {
        try { conn.socket.write(frame) } catch (e) { closeConn(conn) }
      })
    }

    function parseFrame(buf) {
      if (buf.length < 2) return { needMore: true }
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return { needMore: true }
        len = (buf[2] << 8) | buf[3]
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return { needMore: true }
        len = 0
        for (let i = 2; i < 10; i++) len = len * 256 + buf[i]
        off = 10
      }
      if (len > 1 << 20) return { error: true }
      if (!masked) return { error: true } // 客户端帧必须掩码
      if (buf.length < off + 4 + len) return { needMore: true }
      const mask = buf.subarray(off, off + 4)
      const payload = new Uint8Array(len)
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3]
      return { opcode, payload, used: off + 4 + len }
    }

    function handleFrame(conn, f) {
      if (f.opcode === 0x1) {
        // 应用层文本：宠物命令（approval/respond | command/todo/*）
        try { handleClientMessage(conn, JSON.parse(dec.decode(f.payload))) } catch (e) { /* 坏帧忽略 */ }
        return
      }
      if (f.opcode === 0x2 || f.opcode === 0x0) return
      if (f.opcode === 0x8) { // close
        try { conn.socket.write(frameControl(0x8, f.payload.subarray(0, 125))) } catch (e) { /* 忽略 */ }
        closeConn(conn)
        return
      }
      if (f.opcode === 0x9) { // ping → pong
        try { conn.socket.write(frameControl(0xA, f.payload.subarray(0, 125))) } catch (e) { /* 忽略 */ }
      }
    }

    function feed(conn, chunk) {
      try {
        const nb = new Uint8Array(conn.buf.length + chunk.length)
        nb.set(conn.buf)
        nb.set(chunk, conn.buf.length)
        conn.buf = nb
        if (conn.buf.length > 1 << 20) { closeConn(conn); return }
        for (;;) {
          if (!conn.alive) break
          const f = parseFrame(conn.buf)
          if (f.needMore) break
          if (f.error) { closeConn(conn); break }
          conn.buf = conn.buf.subarray(f.used)
          handleFrame(conn, f)
        }
      } catch (e) { console.error('[whalebuddy] feed', e); closeConn(conn) }
    }

    // ---------------- 3. 宠物命令通道（入站） + 批准回答者 ----------------
    // waterfall 语义（cordis 源码 dispatch+shift）：监听器列表头部 = 最外层 = 先跑。
    // 用 prepend:true 把本监听器插到链头，不依赖挂载顺序运气：
    // 宠物在线则截流自己答，否则 next() 原样透传给 api-proxy 的 GUI 卡片路径。
    // askId -> { askId, next, finish, timer, onAbort }
    const pendingAsks = new Map()
    const ASK_FALLBACK_MS = 300000 // 5 分钟无应答 → 交回 GUI

    // 单连接回帧（commandResult 只发给请求方，不广播）
    function replyConn(conn, obj) {
      try { conn.socket.write(frameText(JSON.stringify(obj))) } catch (e) { /* 对方已断 */ }
    }

    // 宠物待办命令（docs/11 §3.2）：action 落在 TodosStore 后回带最新清单；
    // focus/refresh 直接回全量快照。所有失败以 commandResult { ok:false, error } 回。
    async function handleCommand(conn, msg) {
      const id = typeof msg.id === 'string' ? msg.id : ''
      const action = String(msg.action || '')
      const p = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {}
      try {
        if (action === 'focus/refresh') {
          markDirty()
          replyConn(conn, { type: 'commandResult', id, ok: true, state: snapshot() })
          return
        }
        const cwd = currentFocusCwd()
        if (!cwd) {
          replyConn(conn, { type: 'commandResult', id, ok: false, error: 'no-focus' })
          return
        }
        let todos = null
        if (action === 'todo/add') {
          todos = await todosStore.add(cwd, p.content)
        } else if (action === 'todo/toggle') {
          todos = await todosStore.toggle(cwd, String(p.id || ''))
        } else if (action === 'todo/remove') {
          todos = await todosStore.remove(cwd, String(p.id || ''))
        } else if (action === 'todo/edit') {
          todos = await todosStore.edit(cwd, String(p.id || ''), p.content)
        } else if (action === 'todo/clear') {
          todos = await todosStore.clear(cwd, p.doneOnly !== false)
        } else {
          replyConn(conn, { type: 'commandResult', id, ok: false, error: 'unknown-action' })
          return
        }
        markDirty() // 触发 flush → state 广播（其余宠物客户端也同步新清单）
        replyConn(conn, { type: 'commandResult', id, ok: true, todos })
      } catch (e) {
        replyConn(conn, { type: 'commandResult', id, ok: false, error: String((e && e.message) || e) })
      }
    }

    function handleClientMessage(conn, msg) {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'approval/respond' && typeof msg.askId === 'string') {
        const ask = pendingAsks.get(msg.askId)
        if (!ask) return
        if (msg.outcome !== 'allowed-once' && msg.outcome !== 'rejected') return
        console.log(`[whalebuddy] approval answered on pet: ${msg.askId} -> ${msg.outcome}`)
        broadcast({ type: 'approval/settled', askId: msg.askId, outcome: msg.outcome, by: 'pet' })
        ask.finish(Promise.resolve(msg.outcome))
        return
      }
      if (msg.type === 'command' && typeof msg.action === 'string') {
        handleCommand(conn, msg).catch(() => { /* handleCommand 内部已兜错 */ })
        return
      }
      // 其余消息 v1 容忍不处理（pong/hello 预留）
    }

    // 安全调用 next()：同步抛错也归一成 rejected promise（外层 ApprovalService 折算 "unavailable"）
    function safeNext(ask) {
      try { return ask.next() } catch (e) { return Promise.reject(e) }
    }

    // 所有宠物客户端断开时，把在等的 ask 交回 next()（GUI 卡片路径）
    function onClientsChanged() {
      if (conns.size > 0) return
      for (const ask of [...pendingAsks.values()]) {
        broadcast({ type: 'approval/settled', askId: ask.askId, outcome: 'fallback', by: 'disconnect' })
        ask.finish(safeNext(ask))
      }
    }

    keep(ctx.on('approval/request', (req, next) => {
      let summary = '等待批准'
      try {
        const tool = String((req && req.toolName) || '')
        const reason = req && typeof req.reason === 'string' ? req.reason : ''
        summary = tool + (reason ? '：' + reason : '')
        if (!summary) summary = '等待批准'
      } catch (e) { /* 用默认摘要 */ }
      approvalCount++
      agg.awaitingApproval = { pending: true, summary }
      markDirty()
      const settleDisplay = () => {
        approvalCount = Math.max(0, approvalCount - 1)
        agg.awaitingApproval = {
          pending: approvalCount > 0,
          summary: approvalCount > 0 ? (agg.awaitingApproval.summary || summary) : null,
        }
        markDirty()
      }

      let sessionId = ''
      try { sessionId = String(req.agent.session.id) } catch (e) { /* 展示用 */ }

      if (conns.size === 0) {
        // 没有宠物：GUI 路径（观察 + 透传）
        return next().then(
          (r) => { settleDisplay(); return r },
          (e) => { settleDisplay(); throw e },
        )
      }

      // 宠物在线：截流，等宠物答（断开/超时回退 next()）
      const askId = randomUUID()
      return new Promise((resolve) => {
        let finished = false
        const ask = {
          askId,
          next,
          timer: null,
          finish(value) {
            if (finished) return
            finished = true
            clearTimeout(this.timer)
            try { req.signal?.removeEventListener('abort', this.onAbort) } catch (e) { /* 忽略 */ }
            pendingAsks.delete(askId)
            settleDisplay()
            resolve(value) // promise 会自动被外层采纳
          },
          onAbort: () => {
            broadcast({ type: 'approval/settled', askId, outcome: 'cancelled', by: 'abort' })
            ask.finish('cancelled')
          },
        }
        ask.timer = setTimeout(() => {
          if (finished) return
          broadcast({ type: 'approval/settled', askId, outcome: 'fallback', by: 'timeout' })
          ask.finish(safeNext(ask))
        }, ASK_FALLBACK_MS)
        pendingAsks.set(askId, ask)
        try { req.signal?.addEventListener('abort', ask.onAbort, { once: true }) } catch (e) { /* 无 signal */ }
        broadcast({
          type: 'approval/asked',
          askId,
          sessionId,
          toolName: String((req && req.toolName) || ''),
          reason: req && typeof req.reason === 'string' ? req.reason : null,
        })
      })
    }, { prepend: true }))

    // ---------------- 4. EventCollectors ----------------
    const getTitle = (agent) => {
      try {
        const st = ctx.get('sessionTitle')
        if (st && agent && agent.session) {
          const snap = st.get(agent.session)
          if (snap && typeof snap.title === 'string' && snap.title) return snap.title
        }
      } catch (e) { /* 标题是锦上添花 */ }
      return null
    }

    function touchAgent(id, agent) {
      let entry = agents.get(id)
      if (!entry) {
        entry = {
          id, title: '', status: 'idle', cwd: '',
          agent: agent || null,             // 活引用：用于后续 sessionTitle.get(agent.session)
          titleStale: false,                // 标题需要重读
          titleNextPoll: 0,                 // 下次允许重读的时间戳
          titleInterval: 0,                 // 当前退避（ms）
        }
        agents.set(id, entry)
      } else if (agent && entry.agent !== agent) {
        entry.agent = agent // 刷新活引用（agent 偶尔被重建）
      }
      // cwd 只读叶子：会话 header 的绝对路径（焦点回落源，docs/11 §1.1）
      try {
        const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
        if (typeof cwd === 'string' && cwd) entry.cwd = cwd
      } catch (e) { /* header 未稳定时跳过，下次事件再读 */ }
      return entry
    }
    function pruneAgents() {
      if (agents.size <= 16) return
      // 保留还在等标题的条目；只剩"无活动 + 非标题等待"才清
      for (const [id, a] of agents) {
        if (agents.size <= 16) break
        if (a.titleStale) continue
        if (a.status !== 'running') agents.delete(id)
      }
    }

    // 标题轮询：每个 titleStale 的 entry 到点了就重读一次。
    // 命中非空 → 立即推送给宠物；仍为空 → 退避翻倍，封顶 30s（焦点会话 60s）。
    // 第一次轮询（新会话 / 首条消息后）几乎免费：st.get 只是查内存表。
    // 调试日志：每次读到非空快照都写一行（含 source 字段），便于无控制台排障。
    function pollTitles() {
      const now = Date.now()
      let changed = false
      for (const entry of agents.values()) {
        if (!entry.titleStale) continue
        if (now < entry.titleNextPoll) continue
        if (!entry.agent) continue
        // 用 try 包：getTitle 内部 catch 已经吞错；这里再加一层防 agent.session 已 dispose
        let snap = null
        try {
          const st = ctx.get('sessionTitle')
          if (st && entry.agent.session) snap = st.get(entry.agent.session)
        } catch (e) { /* 静默 */ }
        const title = snap && typeof snap.title === 'string' && snap.title ? snap.title : null
        if (title) {
          if (title !== entry.title) {
            entry.title = title
            changed = true
            log_discover(`title poll: agent=${entry.id} -> "${title.slice(0,40)}" (${snap && snap.source ? snap.source.kind : '?'})`)
          }
          entry.titleStale = false
          entry.titleInterval = 0
          entry.titleNextPoll = 0
        } else {
          // 仍为空 → 退避。首次失败马上再试；后续 1s→2s→4s…→封顶 30s
          // 焦点会话放宽到 60s（focused 的 LLM 标题可能在用户切走后慢慢到位）
          const cap = entry.id === agg.session.id ? 60000 : 30000
          entry.titleInterval = entry.titleInterval ? Math.min(entry.titleInterval * 2, cap) : 1000
          entry.titleNextPoll = now + entry.titleInterval
        }
      }
      return changed
    }
    function deriveSessions() {
      let running = 0
      const list = []
      for (const a of agents.values()) {
        if (a.status === 'running') {
          running++
          if (list.length < 4) list.push({ id: a.id, title: a.title || '', cwd: a.cwd || '', status: 'running' })
        }
      }
      agg.sessions = { running, list }
      agg.session.status = running > 0 ? 'running' : 'idle'
    }

    keep(ctx.on('agent/status', (payload) => {
      try {
        const agent = payload && payload.agent
        const id = agent && agent.id ? String(agent.id) : (agg.session.id || 'default')
        const entry = touchAgent(id, agent)
        entry.status = payload && payload.status === 'running' ? 'running' : 'idle'
        const title = getTitle(agent)
        if (title) {
          entry.title = title
          entry.titleStale = false
          entry.titleInterval = 0
        } else {
          // 标题还没生成：标记为过期，等首次 flush 后由 pollTitles 接手
          entry.titleStale = true
        }
        agg.session.id = id
        agg.session.title = entry.title
        deriveSessions()
        pruneAgents()
        markDirty()
      } catch (e) { console.error('[whalebuddy] agent/status', e) }
    }))

    // 新会话：建索引 + 主动 refresh() 一次（fire-and-forget），让 LLM provider 提前走生成路径
    keep(ctx.on('agent/created', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent || !agent.id) return
        const id = String(agent.id)
        const entry = touchAgent(id, agent)
        entry.status = 'idle'
        entry.title = ''
        entry.titleStale = true
        entry.titleInterval = 0
        entry.titleNextPoll = 0
        agg.session.id = id
        deriveSessions()
        markDirty()
        // 主动 refresh：触发 sessionTitle 服务的标题评估（即使还没用户消息）
        try {
          const st = ctx.get('sessionTitle')
          if (st && typeof st.refresh === 'function') {
            Promise.resolve(st.refresh(agent.session)).catch(() => { /* 静默 */ })
          }
        } catch (e) { /* refresh 不可用也无所谓，下次轮询照样能拿到 */ }
      } catch (e) { console.error('[whalebuddy] agent/created', e) }
    }))

    // 会话关闭：从索引清掉
    keep(ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent || !agent.id) return
        agents.delete(String(agent.id))
        if (agg.session.id === String(agent.id)) {
          agg.session.id = ''
          agg.session.title = ''
        }
        deriveSessions()
        markDirty()
      } catch (e) { console.error('[whalebuddy] agent/disposed', e) }
    }))

    // 用户消息进收件箱：标题即将被 LLM provider 异步生成/更新，1.5s 后开始轮询
    keep(ctx.on('agent/inbox/inserted', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent || !agent.id) return
        const id = String(agent.id)
        const entry = touchAgent(id, agent)
        agg.session.id = id
        entry.titleStale = true
        entry.titleInterval = 0
        entry.titleNextPoll = Date.now() + 1500 // 给异步生成一个起步窗口
        markDirty()
      } catch (e) { console.error('[whalebuddy] agent/inbox/inserted', e) }
    }))

    // Agent loop 启动完成（agent 完全就绪后由 loop emit）—— 此时再 refresh + 立即 poll，
    // 覆盖"agent/created 时 session 引用未完全稳定"的边角场景
    keep(ctx.on('agent/session-start', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent || !agent.id) return
        const id = String(agent.id)
        const entry = touchAgent(id, agent)
        // 不立刻 push 焦点，避免跟用户当前正在看的会话抢；只刷新活引用 + 标 stale 让 polling 跟
        entry.titleStale = true
        entry.titleInterval = 0
        entry.titleNextPoll = 0
        // 主动 refresh（fire-and-forget）：触发 sessionTitle 服务的标题评估路径
        try {
          const st = ctx.get('sessionTitle')
          if (st && typeof st.refresh === 'function') {
            Promise.resolve(st.refresh(agent.session)).catch(() => { /* 静默 */ })
          }
        } catch (e) { /* refresh 不可用也无所谓 */ }
        markDirty()
      } catch (e) { console.error('[whalebuddy] agent/session-start', e) }
    }))

    keep(ctx.on('tools/execute', (exec, next) => {
      try {
        const name = String((exec && exec.name) || '')
        toolInFlight++
        currentActivity = classify(name)
        if (exec && exec.agent && exec.agent.id) {
          const id = String(exec.agent.id)
          agg.session.id = id
          const entry = touchAgent(id, exec.agent)
          if (entry.title) agg.session.title = entry.title
        }
        markDirty()
      } catch (e) { console.error('[whalebuddy] tools/execute', e) }
      return next() // 红线：透传
    }))

    keep(ctx.on('tools/result', () => {
      try {
        toolInFlight = Math.max(0, toolInFlight - 1)
        markDirty()
      } catch (e) { console.error('[whalebuddy] tools/result', e) }
    }))

    keep(ctx.on('llm/stream', (options, next) => {
      // 观察流：next 同步返回 AsyncIterable<StreamChunk>，不能再 await
      const stream = next()
      return (async function* () {
        for await (const chunk of stream) {
          thinkTicks++
          yield chunk
        }
      })()
    }))

    keep(ctx.on('agent/error', (payload) => {
      try {
        agg.pulse = { kind: 'panic', at: Date.now() }
        if (payload && typeof payload.turn === 'number') agg.session.turn = payload.turn
        markDirty()
      } catch (e) { console.error('[whalebuddy] agent/error', e) }
    }))

    keep(ctx.on('agent/turn-stopping', (payload) => {
      try {
        if (payload && typeof payload.turn === 'number') agg.session.turn = payload.turn
      } catch (e) { /* turn 仅展示用 */ }
    }))

    keep(ctx.on('subagent/start', () => {
      agg.subagents++; markDirty()
    }))
    keep(ctx.on('subagent/end', () => {
      agg.subagents = Math.max(0, agg.subagents - 1); markDirty()
    }))

    keep(ctx.on('workflow/start', () => {
      agg.workflow = { running: true, phase: null }; markDirty()
    }))
    keep(ctx.on('workflow/phase', (info, title) => {
      agg.workflow = { running: true, phase: typeof title === 'string' ? title : null }; markDirty()
    }))
    keep(ctx.on('workflow/end', () => {
      agg.workflow = { running: false, phase: null }; markDirty()
    }))

    keep(ctx.on('goal/changed', (payload) => {
      try {
        const op = payload && payload.change && payload.change.operation
        if (op === 'complete') { agg.pulse = { kind: 'celebrating', at: Date.now() }; markDirty() }
      } catch (e) { /* pulse 可选 */ }
    }))

    // jobs 服务（可选依赖）
    try {
      const jobsSvc = ctx.get('jobs')
      if (jobsSvc && typeof jobsSvc.list === 'function') {
        const refreshJobs = () => {
          try {
            const list = jobsSvc.list() || []
            agg.jobs = list
              .filter((j) => j && String(j.status) === 'running')
              .slice(0, 8)
              .map((j) => ({ id: String(j.id || ''), desc: String(j.label || j.kind || ''), status: 'running' }))
            markDirty()
          } catch (e) { console.error('[whalebuddy] jobs', e) }
        }
        keep(jobsSvc.onJobsChanged(refreshJobs))
        keep(jobsSvc.onJobDone(refreshJobs))
        refreshJobs()
      }
    } catch (e) { console.error('[whalebuddy] jobs init', e) }

    // ---------------- 5. WS 升级路由 + 心跳（leader 已确认） ----------------
    keep(ctx.webServer.registerUpgrade({
      path: '/dsh-pet/ws',
      handler: (req, socket, head) => {
        try {
          // Origin 校验（docs/11 §3.4）：原生客户端（宠物壳）无 Origin 放行；
          // 浏览器只收回环 origin，拒绝恶意网页跨源连 WS（答批准/发命令）。
          if (!originAllowed(req)) { socket.destroy(); return }
          const key = req && req.headers && req.headers['sec-websocket-key']
          if (typeof key !== 'string' || !key) { socket.destroy(); return }
          const accept = wsAcceptKey(key)
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
          )
          const conn = { socket, buf: new Uint8Array(0), alive: true }
          conns.add(conn)
          socket.on('data', (c) => feed(conn, c))
          socket.on('close', () => { conn.alive = false; conns.delete(conn); onClientsChanged() })
          socket.on('error', () => { conn.alive = false; conns.delete(conn); onClientsChanged() })
          try { socket.write(frameText(JSON.stringify(snapshot()))) } catch (e) { /* 忽略 */ }
          if (head && head.length) feed(conn, head)
        } catch (e) {
          console.error('[whalebuddy] upgrade', e)
          try { socket.destroy() } catch (e2) { /* 已关 */ }
        }
      },
    }))

    try {
      const t = (ctx.timer && typeof ctx.timer.interval === 'function')
        ? ctx.timer
        : (typeof ctx.interval === 'function' ? ctx : null)
      if (t) keep(t.interval(() => {
        broadcast({ type: 'ping', protocolVersion: 1, ts: Date.now() })
      }, 10000))
    } catch (e) { console.error('[whalebuddy] heartbeat', e) }

    // ---------------- 5.5 设置卡片 API（GUI 同源 fetch；GET/POST 共用 handler） ----------------
    // /dsh-pet/api/status：「插件配置」卡片显示宠物在线状态 + 当前生效配置。
    keep(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-pet/api/status',
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        res.end(JSON.stringify({
          ok: true,
          name: 'whalebuddy',
          protocolVersion: 1,
          hostVersion: '1.3',
          features: ['approval', 'focus', 'todos'],
          config: { autostart: cfg.autostart, launchOnDshStart: cfg.launchOnDshStart, petPath: cfg.petPath, skin: cfg.skin },
          pet: { connected: conns.size > 0, clients: conns.size },
        }))
      },
    }))
    // /dsh-pet/api/launch：卡片「立即启动」按钮 → force 拉起（绕过防抖，不绕过在线检查）。
    keep(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-pet/api/launch',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          })
          res.end(JSON.stringify(obj))
        }
        try {
          if (!originAllowed(req)) { send(403, { ok: false, error: 'origin denied' }); return }
          const r = await launchPet('manual', { force: true })
          send(200, { ok: true, ...r })
        } catch (e) {
          send(500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }))

    // /dsh-pet/api/focus — GUI client 半边的真焦点上报（docs/11 §3.3）。
    // GET 调试用：回当前推导焦点；POST { sessionId, cwd } last-writer-wins 记录，
    // 字段截断校验后 markDirty（flush 里统一推导/广播，心跳重复上报靠 diff 抑制）。
    keep(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-pet/api/focus',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        try {
          if (!originAllowed(req)) { send(403, { ok: false, error: 'origin denied' }); return }
          if (req.method !== 'POST') {
            const f = computeFocus()
            send(200, { ok: true, focus: f, staleIn: focusReport ? Math.max(0, FOCUS_STALE_MS - (Date.now() - focusReport.at)) : 0 })
            return
          }
          const chunks = []
          for await (const c of req) chunks.push(c)
          const body = Buffer.concat(chunks).toString('utf8')
          let parsed = {}
          try { parsed = JSON.parse(body) } catch (e) { send(400, { ok: false, error: 'bad json' }); return }
          const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.slice(0, 200) : ''
          const cwd = typeof parsed.cwd === 'string' ? parsed.cwd.slice(0, 1024) : ''
          if (!sessionId || !cwd) { send(400, { ok: false, error: 'sessionId and cwd required' }); return }
          const changed = !focusReport || focusReport.sessionId !== sessionId || focusReport.cwd !== cwd
          focusReport = { sessionId, cwd, at: Date.now() }
          if (changed) console.log(`[whalebuddy] focus (gui): session=${sessionId} cwd=${cwd}`)
          markDirty()
          send(200, { ok: true, changed })
        } catch (e) {
          send(500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }))

    // /dsh-pet/api/todos — 当前焦点清单 JSON（调试 / 兜底数据面）。
    keep(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-pet/api/todos',
      handler: (req, res) => {
        if (!originAllowed(req)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'origin denied' }))
          return
        }
        const f = computeFocus()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, focus: f, todos: f ? todosStore.listFor(f.cwd) : [] }))
      },
    }))

    // /dsh-pet/todos — 宠物离线时的轻量兜底页（同 /dsh-pet/config 风格）。
    // GET 渲染当前焦点工作区的清单 + 表单；POST 表单动作后 303 回本页（PRG）。
    keep(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-pet/todos',
      handler: async (req, res) => {
        const f = () => computeFocus()
        if (req.method !== 'POST') {
          const cur = f()
          const items = cur ? todosStore.listFor(cur.cwd) : []
          const esc = escapeHtml
          const rows = items.map((it) =>
            `<li class="item"><form method="post" action="/dsh-pet/todos">` +
            `<input type="hidden" name="action" value="toggle"><input type="hidden" name="id" value="${esc(it.id)}">` +
            `<button class="tick${it.status === 'done' ? ' done' : ''}" title="切换状态">${it.status === 'done' ? '☑' : '☐'}</button></form>` +
            `<span class="txt${it.status === 'done' ? ' done' : ''}">${esc(it.content)}</span>` +
            `<form method="post" action="/dsh-pet/todos" class="rm"><input type="hidden" name="action" value="remove">` +
            `<input type="hidden" name="id" value="${esc(it.id)}"><button title="删除">×</button></form></li>`).join('')
          const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>whalebuddy 项目待办</title>` +
            `<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0e1726;color:#cfd8e3;max-width:480px;margin:48px auto;padding:0 20px}` +
            `h1{font-size:18px;margin:0 0 4px}.sub{font-size:12px;color:#8aa0b4;margin:0 0 20px}` +
            `ul{list-style:none;margin:0 0 16px;padding:0}li.item{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #1a2436}` +
            `.txt{flex:1;font-size:14px;word-break:break-all}.txt.done{color:#5b6b7d;text-decoration:line-through}` +
            `button{font:inherit;background:none;border:0;color:#8aa0b4;cursor:pointer}.tick{font-size:16px}.rm button{font-size:16px}.rm button:hover{color:#ff6b6b}` +
            `form.rm{margin:0}.add{display:flex;gap:8px}input[type=text]{flex:1;padding:8px 10px;background:#1a2436;color:#cfd8e3;border:1px solid #2a3a52;border-radius:6px;font:inherit}` +
            `.go{background:#2b6cff;color:#fff;border:0;border-radius:6px;padding:8px 16px;font:inherit;cursor:pointer}` +
            `.clear{margin:12px 0 0;font-size:12px}</style></head><body>` +
            `<h1>📋 ${cur ? esc(cur.workspaceTitle || basenameOf(cur.cwd)) : '未聚焦工作区'}</h1>` +
            `<p class="sub">${cur ? esc(cur.cwd) + ' · 来源：' + (cur.source === 'gui' ? 'GUI 聚焦' : '最近活跃') : '没有聚焦会话时无法确定工作区（打开 DSH 选中一个会话即可）'}</p>` +
            (cur ? `<ul>${rows || '<li class="item"><span class="txt" style="color:#5b6b7d">（空，添加第一条待办）</span></li>'}</ul>` +
              `<form class="add" method="post" action="/dsh-pet/todos"><input type="hidden" name="action" value="add">` +
              `<input type="text" name="content" maxlength="500" placeholder="新待办…" required><button class="go">添加</button></form>` +
              (items.some((it) => it.status === 'done') ? `<form class="clear" method="post" action="/dsh-pet/todos"><input type="hidden" name="action" value="clear"><button>清除已完成</button></form>` : '')
              : '') +
            `</body></html>`
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
          return
        }
        // POST：Origin 校验 + 表单动作 → TodosStore → 303 回 GET
        if (!originAllowed(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
        }
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          const action = params.get('action') || ''
          const cwd = currentFocusCwd()
          if (!cwd) throw new Error('没有聚焦工作区')
          if (action === 'add') await todosStore.add(cwd, params.get('content') || '')
          else if (action === 'toggle') await todosStore.toggle(cwd, params.get('id') || '')
          else if (action === 'remove') await todosStore.remove(cwd, params.get('id') || '')
          else if (action === 'clear') await todosStore.clear(cwd, true)
          markDirty()
          res.writeHead(303, { location: '/dsh-pet/todos', 'cache-control': 'no-store' })
          res.end()
        } catch (e) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('操作失败：' + escapeHtml(String((e && e.message) || e)))
        }
      },
    }))

    // ---------------- 6. 统一清理 ----------------
    ctx.effect(() => () => {
      stopLaunchWatch()
      for (let i = 0; i < disposers.length; i++) {
        try { disposers[i]() } catch (e) { /* 清理尽力而为 */ }
      }
      for (const ask of [...pendingAsks.values()]) {
        try { ask.finish(safeNext(ask)) } catch (e) { /* 已在链外 */ }
      }
      pendingAsks.clear()
      conns.forEach((conn) => {
        try { conn.socket.write(frameText(JSON.stringify({ type: 'bye', protocolVersion: 1 }))) } catch (e) { /* 忽略 */ }
        try { conn.socket.destroy() } catch (e) { /* 已关 */ }
      })
      conns.clear()
    }, 'whalebuddy: teardown')

    console.log('[whalebuddy v0.3.0] perception active: /dsh-pet/handshake + /dsh-pet/ws + /dsh-pet/api/* + /dsh-pet/todos (approval answerer armed; focus tracker + workspace todos ready)')
  },
}
