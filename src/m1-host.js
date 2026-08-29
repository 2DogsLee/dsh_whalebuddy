// dsh-pet M1 感知层插件 —— 本文件内容即 cordis_define 的 code.host 函数体（plain JS）。
// 能力：监听 DSH Host 事件流 → 折叠成 state 快照 → 经 /dsh-pet/handshake (HTTP)
//       与 /dsh-pet/ws (WebSocket, 手写极简 RFC6455) 对外广播。
// 红线：waterfall 事件（tools/execute, llm/stream, approval/request）只观察、必透传；
//       live 对象（Agent/Session/…）只读叶子字段，绝不整体序列化。
return {
  inject: ['webServer', 'timer'],
  apply(ctx) {
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const disposers = []
    const keep = (d) => { if (typeof d === 'function') disposers.push(d) }

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
        // 强度：chunk 计数分档
        agg.activityIntensity = thinkTicks > 40 ? 3 : thinkTicks > 15 ? 2 : thinkTicks > 0 ? 1 : 0
        thinkTicks = 0
        // activity 仲裁：工具进行中 > running(思考) > idle
        if (toolInFlight > 0 && currentActivity) agg.activity = currentActivity
        else if (agg.session.status === 'running') agg.activity = 'thinking'
        else agg.activity = 'idle'
        // pulse 8s 过期
        if (agg.pulse && Date.now() - agg.pulse.at > 8000) agg.pulse = null
        const msg = snapshot()
        const json = JSON.stringify(msg)
        if (json === lastJson) return
        lastJson = json
        broadcast(msg)
      } catch (e) { console.error('[dsh-pet] flush', e) }
    }

    // 节流：优先 timer 服务（throttle 前沿即触发 + 尾沿补发），退化时直接 flush
    let throttledFlush = flush
    try {
      const t = (ctx.timer && typeof ctx.timer.throttle === 'function')
        ? ctx.timer
        : (typeof ctx.throttle === 'function' ? ctx : null)
      if (t) { throttledFlush = t.throttle(flush, 500); keep(throttledFlush.dispose) }
    } catch (e) { console.error('[dsh-pet] throttle', e) }
    const markDirty = () => { try { throttledFlush() } catch (e) { console.error('[dsh-pet] markDirty', e) } }

    // ---------------- 2. EventCollectors ----------------
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

    // ---- 多会话聚合：per-agent 状态表 ----
    function touchAgent(id) {
      let entry = agents.get(id)
      if (!entry) { entry = { id, title: '', status: 'idle' }; agents.set(id, entry) }
      return entry
    }
    // 表太大时优先淘汰 idle 的旧条目
    function pruneAgents() {
      if (agents.size <= 16) return
      for (const [id, a] of agents) {
        if (agents.size <= 16) break
        if (a.status !== 'running') agents.delete(id)
      }
    }
    // 全局 status = 任一会话 running；sessions 列表取运行中的前 4 个
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
        const entry = touchAgent(id)
        entry.status = payload && payload.status === 'running' ? 'running' : 'idle'
        const title = getTitle(agent)
        if (title) entry.title = title
        // 展示焦点跟随最近发事件的会话
        agg.session.id = id
        agg.session.title = entry.title
        deriveSessions()
        pruneAgents()
        markDirty()
      } catch (e) { console.error('[dsh-pet] agent/status', e) }
    }))

    keep(ctx.on('tools/execute', (exec, next) => {
      try {
        const name = String((exec && exec.name) || '')
        toolInFlight++
        currentActivity = classify(name)
        if (exec && exec.agent && exec.agent.id) {
          const id = String(exec.agent.id)
          agg.session.id = id
          const entry = touchAgent(id)
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
      const settle = () => {
        // 计数结算：多个批准并发时，只有最后一个 settle 才清掉 pending
        approvalCount = Math.max(0, approvalCount - 1)
        agg.awaitingApproval = {
          pending: approvalCount > 0,
          summary: approvalCount > 0 ? (agg.awaitingApproval.summary || summary) : null,
        }
        markDirty()
      }
      return next().then(
        (r) => { settle(); return r },
        (e) => { settle(); throw e },
      )
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

    // ---------------- 3. 极简 RFC6455 服务端 ----------------
    // SHA-1（纯整数运算）→ Sec-WebSocket-Accept
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

    // 帧编码：server→client 不掩码
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
      try { conn.socket.destroy() } catch (e) { /* 已关 */ }
    }
    function broadcast(msg) {
      const frame = frameText(JSON.stringify(msg))
      conns.forEach((conn) => {
        try { conn.socket.write(frame) } catch (e) { closeConn(conn) }
      })
    }

    // 返回 { needMore } | { error } | { opcode, payload, used }
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
      if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
        // v1 容忍任何应用层文本（pong/hello/command 预留），暂不处理
        return
      }
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

    // ---------------- 4. WsHub：路由注册 ----------------
    keep(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-pet/handshake',
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        res.end(JSON.stringify({ ok: true, name: 'dsh-pet', protocolVersion: 1, wsPath: '/dsh-pet/ws' }))
      },
    }))

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
          socket.on('close', () => { conn.alive = false; conns.delete(conn) })
          socket.on('error', () => { conn.alive = false; conns.delete(conn) })
          // 连接即全量
          try { socket.write(frameText(JSON.stringify(snapshot()))) } catch (e) { /* 忽略 */ }
          if (head && head.length) feed(conn, head)
        } catch (e) {
          console.error('[dsh-pet] upgrade', e)
          try { socket.destroy() } catch (e2) { /* 已关 */ }
        }
      },
    }))

    // 心跳：10s 应用层 ping（协议 03 §4）
    try {
      const t = (ctx.timer && typeof ctx.timer.interval === 'function')
        ? ctx.timer
        : (typeof ctx.interval === 'function' ? ctx : null)
      if (t) keep(t.interval(() => {
        broadcast({ type: 'ping', protocolVersion: 1, ts: Date.now() })
      }, 10000))
    } catch (e) { console.error('[dsh-pet] heartbeat', e) }

    // ---------------- 5. 统一清理 ----------------
    ctx.effect(() => () => {
      for (let i = 0; i < disposers.length; i++) {
        try { disposers[i]() } catch (e) { /* 清理尽力而为 */ }
      }
      conns.forEach((conn) => {
        try { conn.socket.write(frameText(JSON.stringify({ type: 'bye', protocolVersion: 1 }))) } catch (e) { /* 忽略 */ }
        try { conn.socket.destroy() } catch (e) { /* 已关 */ }
      })
      conns.clear()
    }, 'dsh-pet: teardown')

    console.log('[dsh-pet] perception plugin active: /dsh-pet/handshake + /dsh-pet/ws')
  },
}
