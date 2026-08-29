/**
 * dsh-pet-host — 桌面宠物感知层（宿主组合行，$DSH_HOME/cordis.patch.yml 挂载）。
 *
 * 职责：
 *  1. 感知：监听 Host 事件流 → 折叠成 state 快照 → /dsh-pet/handshake (HTTP, CORS)
 *     与 /dsh-pet/ws (手写极简 RFC6455) 广播给桌面宠物。
 *  2. 批准交互：approval/request waterfall 里当"宠物回答者"——宠物客户端在线时
 *     把待批请求推给宠物（approval/asked），等宠物回 approval/respond；
 *     宠物不在线 / 全部断开 / 超时（5min）则 next() 交回 api-proxy 的 GUI 卡片路径。
 *     两条路径互斥且都经 ApprovalService 的 asked/decided 审计事件落日志，
 *     不绕过任何权限语义。
 *
 * 平面归属：跨会话（聚合所有会话、消费者是进程外的宠物），按 composition 规范
 * 属宿主平面 —— 挂在 home 补丁层而不是任何 agent 预设里。
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

module.exports = {
  name: 'dsh-pet-perception',
  inject: ['webServer', 'timer'],
  apply(ctx) {
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const disposers = []
    const keep = (d) => { if (typeof d === 'function') disposers.push(d) }

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
          res.end(JSON.stringify({ ok: true, name: 'dsh-pet', protocolVersion: 1, hostVersion: '1.1', wsPath: '/dsh-pet/ws' }))
        },
      }))
    } catch (e) {
      if (/duplicate/.test(String((e && e.message) || ''))) {
        leader = false
        console.log('[dsh-pet] follower mode: /dsh-pet routes already held by another instance, idling')
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
      }, 'dsh-pet-host: follower teardown')
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
    }
    let thinkTicks = 0        // 自上次 flush 以来的 llm chunk 数
    let toolInFlight = 0      // 进行中的工具调用数
    let currentActivity = null // 工具触发的 activity（工具结束后保留至 flush 仲裁）
    let lastJson = ''
    let approvalCount = 0     // 进行中的批准请求数（多会话并发时不会互相误清）
    const agents = new Map()  // agentId -> { id, title, status }，全局 status 由所有条目派生

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
        },
        activity: agg.activity,
        activityIntensity: agg.activityIntensity,
        awaitingApproval: {
          pending: agg.awaitingApproval.pending,
          summary: agg.awaitingApproval.summary,
        },
        subagents: { running: agg.subagents },
        sessions: {
          running: agg.sessions.running,
          list: agg.sessions.list.map((a) => ({ id: a.id, title: a.title, status: a.status })),
        },
        jobs: agg.jobs.map((j) => ({ id: j.id, desc: j.desc, status: j.status })),
        workflow: { running: agg.workflow.running, phase: agg.workflow.phase },
        tokens: { estimated: agg.tokens.estimated },
        pulse: agg.pulse ? { kind: agg.pulse.kind, at: agg.pulse.at } : null,
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
      } catch (e) { console.error('[dsh-pet] flush', e) }
    }

    let throttledFlush = flush
    try {
      const t = (ctx.timer && typeof ctx.timer.throttle === 'function')
        ? ctx.timer
        : (typeof ctx.throttle === 'function' ? ctx : null)
      if (t) { throttledFlush = t.throttle(flush, 500); keep(throttledFlush.dispose) }
    } catch (e) { console.error('[dsh-pet] throttle', e) }
    const markDirty = () => { try { throttledFlush() } catch (e) { console.error('[dsh-pet] markDirty', e) } }

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
        // 应用层文本：宠物命令（v1 仅 approval/respond）
        try { handleClientMessage(JSON.parse(dec.decode(f.payload))) } catch (e) { /* 坏帧忽略 */ }
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
      } catch (e) { console.error('[dsh-pet] feed', e); closeConn(conn) }
    }

    // ---------------- 3. 宠物命令通道（入站） + 批准回答者 ----------------
    // waterfall 语义（cordis 源码 dispatch+shift）：监听器列表头部 = 最外层 = 先跑。
    // 用 prepend:true 把本监听器插到链头，不依赖挂载顺序运气：
    // 宠物在线则截流自己答，否则 next() 原样透传给 api-proxy 的 GUI 卡片路径。
    // askId -> { askId, next, finish, timer, onAbort }
    const pendingAsks = new Map()
    const ASK_FALLBACK_MS = 300000 // 5 分钟无应答 → 交回 GUI

    function handleClientMessage(msg) {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'approval/respond' && typeof msg.askId === 'string') {
        const ask = pendingAsks.get(msg.askId)
        if (!ask) return
        if (msg.outcome !== 'allowed-once' && msg.outcome !== 'rejected') return
        console.log(`[dsh-pet] approval answered on pet: ${msg.askId} -> ${msg.outcome}`)
        broadcast({ type: 'approval/settled', askId: msg.askId, outcome: msg.outcome, by: 'pet' })
        ask.finish(Promise.resolve(msg.outcome))
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
          id, title: '', status: 'idle',
          agent: agent || null,             // 活引用：用于后续 sessionTitle.get(agent.session)
          titleStale: false,                // 标题需要重读
          titleNextPoll: 0,                 // 下次允许重读的时间戳
          titleInterval: 0,                 // 当前退避（ms）
        }
        agents.set(id, entry)
      } else if (agent && entry.agent !== agent) {
        entry.agent = agent // 刷新活引用（agent 偶尔被重建）
      }
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
          if (list.length < 4) list.push({ id: a.id, title: a.title || '', status: 'running' })
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
      } catch (e) { console.error('[dsh-pet] agent/status', e) }
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
      } catch (e) { console.error('[dsh-pet] agent/created', e) }
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
      } catch (e) { console.error('[dsh-pet] agent/disposed', e) }
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
      } catch (e) { console.error('[dsh-pet] agent/inbox/inserted', e) }
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
      } catch (e) { console.error('[dsh-pet] agent/session-start', e) }
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
      } catch (e) { console.error('[dsh-pet] tools/execute', e) }
      return next() // 红线：透传
    }))

    keep(ctx.on('tools/result', () => {
      try {
        toolInFlight = Math.max(0, toolInFlight - 1)
        markDirty()
      } catch (e) { console.error('[dsh-pet] tools/result', e) }
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
      } catch (e) { console.error('[dsh-pet] agent/error', e) }
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
          } catch (e) { console.error('[dsh-pet] jobs', e) }
        }
        keep(jobsSvc.onJobsChanged(refreshJobs))
        keep(jobsSvc.onJobDone(refreshJobs))
        refreshJobs()
      }
    } catch (e) { console.error('[dsh-pet] jobs init', e) }

    // ---------------- 5. WS 升级路由 + 心跳（leader 已确认） ----------------
    keep(ctx.webServer.registerUpgrade({
      path: '/dsh-pet/ws',
      handler: (req, socket, head) => {
        try {
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
          console.error('[dsh-pet] upgrade', e)
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
    } catch (e) { console.error('[dsh-pet] heartbeat', e) }

    // ---------------- 6. 统一清理 ----------------
    ctx.effect(() => () => {
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
    }, 'dsh-pet-host: teardown')

    console.log('[dsh-pet host v1.1] perception active: /dsh-pet/handshake + /dsh-pet/ws (approval answerer armed, prepend)')
  },
}
