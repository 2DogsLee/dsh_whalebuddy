
(function () {
  const T = window.__TAURI__
  if (!T) {
    document.getElementById('label').textContent = '⚠️ 请用 cargo run 启动'
    document.getElementById('label').className = 'label offline'
    return
  }
  const invoke = T.core.invoke
  const win = T.window.getCurrentWindow()

  // 窗口高度：待批准时加高以在舷窗下方显示审批区；只 setSize（顶不动），不改位置
  const HEIGHT_BASE = 210
  const HEIGHT_APPROVE = 330
  function applyHeight(h) {
    win.setSize(new T.window.LogicalSize(178, h)).catch(() => {})
  }

  const ACTIVITY_LABEL = {
    idle: '闲置', thinking: '思考中…', coding: '写代码',
    cmd: '跑命令', search: '查资料', spawning: '召唤小弟', waiting: '等你输入',
  }

  const $ = (id) => document.getElementById(id)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  let state = null
  let online = false
  let curPort = null
  let ws = null             // 当前 WebSocket（answerApproval 也要用，必须在 IIFE 顶层）
  let hostVersion = null    // 握手响应里的 hostVersion（v1.1 起提供；null = 旧版）
  let pendingAsk = null    // { askId, toolName, reason } — 服务端 approval/asked
  let askAnswered = false  // 已点过按钮，等服务端 settled
  let discoverErr = null   // discover_port 失败时的错误文本（显示在标签上，便于无控制台诊断）
  let debugMode = null     // 调试模式锁定：{ state, activity, intensity } 或 null（真实模式）

  function deriveState(s) {
    if (!s || !online) return 'offline'
    if (s.awaitingApproval?.pending) return 'needYou'
    if (s.pulse?.kind === 'panic') return 'panic'
    if (s.pulse?.kind === 'celebrating') return 'celebrating'
    if (s.session?.status === 'running') return 'working'
    return 'sleeping'
  }
  function deriveActivity(s) {
    if (!s || s.session?.status !== 'running') return 'idle'
    return s.activity || 'thinking'
  }

  // 气泡速率：按 (状态, 活动, 思考强度) 调共享粒子池的两个 CSS 变量
  // ============ 声呐（Canvas 绘制扩散圆环，search 状态显示） ============
  const sonarCanvas = $('sonar-canvas')
  const sctx = sonarCanvas && sonarCanvas.getContext('2d')
  let sonarRAF = null
  let sonarT0 = 0
  function sizeSonar() {
    if (!sonarCanvas || !sctx) return
    const dpr = window.devicePixelRatio || 1
    sonarCanvas.width = 150 * dpr
    sonarCanvas.height = 150 * dpr
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  function drawSonar(now) {
    sctx.clearRect(0, 0, 150, 150)
    const t = now - sonarT0
    const cx = 92, cy = 62   // 鲸鱼头部附近（search 时鲸鱼下移，头在舷窗中上偏右）
    const period = 2400
    for (let k = 0; k < 3; k++) {
      const ph = ((t % period) / period + k / 3) % 1
      const r = 10 + ph * 55
      const op = (1 - ph) * 0.7
      sctx.beginPath()
      sctx.arc(cx, cy, r, 0, Math.PI * 2)
      sctx.strokeStyle = 'rgba(140, 210, 255, ' + op.toFixed(2) + ')'
      sctx.lineWidth = 2.5
      sctx.shadowColor = 'rgba(140, 210, 255, 0.9)'
      sctx.shadowBlur = 10
      sctx.stroke()
      sctx.shadowBlur = 0
    }
    sonarRAF = requestAnimationFrame(drawSonar)
  }
  function startSonar() {
    if (!sctx || sonarRAF) return
    sonarT0 = performance.now()
    sonarRAF = requestAnimationFrame(drawSonar)
  }
  function stopSonar() {
    if (sonarRAF) { cancelAnimationFrame(sonarRAF); sonarRAF = null }
    if (sctx) sctx.clearRect(0, 0, 150, 150)
  }
  sizeSonar()

  function bubbleParams(st, act, n) {
    switch (st) {
      case 'offline':     return { spd: 9,  op: 0.16 }
      case 'sleeping':    return { spd: 6,  op: 0.34 }
      case 'needYou':     return { spd: 1.7, op: 0.8 }
      case 'panic':       return { spd: 0.9, op: 0.6 }
      case 'celebrating': return { spd: 1.9, op: 0.75 }
    }
    if (act === 'thinking') return { spd: Math.max(1.2, 3.4 - n * 0.55), op: 0.5 + n * 0.12 }
    if (act === 'search')   return { spd: 2.2, op: 0.55 }
    return { spd: 2.6, op: 0.5 }
  }

  function render() {
    // 调试模式优先：debugMode 非 null 时锁定状态/活动/强度
    const st = debugMode ? debugMode.state : deriveState(state)
    const act = debugMode ? debugMode.activity : deriveActivity(state)
    const n = debugMode ? debugMode.intensity : (state?.activityIntensity ?? 0)
    const pet = $('pet')
    pet.dataset.state = st
    pet.dataset.activity = act
    pet.dataset.intensity = String(n)

    const bp = bubbleParams(st, act, n)
    const bub = $('bubbles')
    bub.style.setProperty('--spd', bp.spd + 's')
    bub.style.setProperty('--op', String(bp.op))

    // 声呐：search 时用 Canvas 绘制扩散圆环（不依赖 CSS 动画，必定可见）
    if (act === 'search') startSonar(); else stopSonar()

    // 批准态切换：.card 加 .approving（CSS 控制 actions 显示）+ 窗口加高容纳舷窗下方的审批区
    const approving = !!pendingAsk
    if (card.classList.contains('approving') !== approving) {
      card.classList.toggle('approving', approving)
    }
    applyHeight(approving ? HEIGHT_APPROVE : HEIGHT_BASE)

    // 标签：待批准优先；working 显示活动名 + 强度点；其余显示状态词
    const lbl = $('label')
    const acts = $('actions')
    if (pendingAsk) {
      lbl.className = 'label'
      lbl.textContent = '⏳ 待批准'
      acts.classList.add('show')
      $('ask-text').textContent = (pendingAsk.toolName || '?') + (pendingAsk.reason ? '：' + (pendingAsk.reason.length > 40 ? pendingAsk.reason.slice(0, 40) + '…' : pendingAsk.reason) : '')
      $('btn-allow').disabled = askAnswered
      $('btn-deny').disabled = askAnswered
    } else {
      acts.classList.remove('show')
      if (debugMode) {
        // 调试模式：标签显示锁定的状态/活动
        lbl.className = 'label'
        const dn = debugMode.activity === 'thinking' ? ('思考' + debugMode.intensity) : (ACTIVITY_LABEL[debugMode.activity] || debugMode.activity)
        lbl.textContent = '🔧 ' + (debugMode.state === 'working' ? dn : debugMode.state)
      } else if (st === 'working') {
        lbl.className = 'label'
        lbl.innerHTML = (ACTIVITY_LABEL[act] || act) +
          '<span class="intensity">' + [0,1,2,3].map((i) => '<i class="' + (i < n ? 'on' : '') + '"></i>').join('') + '</span>'
      } else {
        lbl.className = 'label' + (st === 'offline' ? ' offline' : '')
        lbl.textContent = st === 'offline'
          ? (discoverErr ? '发现异常: ' + discoverErr
            : online ? '断线重连中…' : '找 DSH 中…')
          : st === 'sleeping' ? '睡着了 😴'
          : st === 'needYou' ? '需要你！'
          : st === 'panic' ? '出错了！'
          : st === 'celebrating' ? '搞定啦！'
          : st
      }
    }

    // 多会话角标
    const running = state?.sessions?.running ?? 0
    const c = $('count')
    if (running > 1) { c.textContent = '×' + running; c.classList.add('show') }
    else c.classList.remove('show')
  }

  function handleMsg(raw) {
    try {
      const msg = JSON.parse(raw)
      if (msg.type === 'state') { state = msg; render() }
      else if (msg.type === 'approval/asked') {
        // v1 单待批显示：并发多批时显示最新（服务端按 askId 各自结算/回退，不会卡死）
        pendingAsk = { askId: msg.askId, toolName: msg.toolName, reason: msg.reason }
        askAnswered = false
        render()
      } else if (msg.type === 'approval/settled') {
        if (pendingAsk && msg.askId === pendingAsk.askId) {
          pendingAsk = null
          askAnswered = false
          render()
        }
      }
      // ping 忽略；协议预留
    } catch (e) { /* 忽略坏帧 */ }
  }

  async function ensureLoop() {
    for (;;) {
      online = false
      curPort = null
      render()

      let port = null
      // 上次成功的端口作为 hint 先验证（直连一次，免全段扫描）
      let hint = null
      try { const n = Number(localStorage.getItem('petPort')); if (Number.isInteger(n) && n > 0) hint = n } catch (e) {}
      try { port = await invoke('discover_port', { portHint: hint }); discoverErr = null } catch (e) { discoverErr = String((e && e.message) || e); render() }

      if (port) {
        curPort = port
        await new Promise((resolve) => {
          try { ws = new WebSocket('ws://127.0.0.1:' + port + '/dsh-pet/ws') }
          catch (e) { resolve(); return }
          ws.onopen = () => {
            online = true; render()
            try { localStorage.setItem('petPort', String(port)) } catch (e) { /* 缓存尽力而为 */ }
            // 版本探测（handshake 带 ACAO:*，可跨源）：v1.1 起显示 host 版本，旧版静默
            fetch('http://127.0.0.1:' + port + '/dsh-pet/handshake')
              .then((r) => r.json())
              .then((j) => { hostVersion = j.hostVersion || null; render() })
              .catch(() => {})
          }
          ws.onmessage = (ev) => handleMsg(ev.data)
          ws.onclose = () => {
            ws = null
            hostVersion = null
            // 断开即弃待批：服务端检测到全断开会自动把请求交回 GUI 卡片，不会卡死
            pendingAsk = null
            askAnswered = false
            resolve()
          }
          ws.onerror = () => { /* close 会跟着来 */ }
        })
        // 连上后断开：DSH 可能重启换了端口 → 短暂等待后重新发现
        await sleep(3000)
      } else {
        // 没找到端点：等 8s 再扫（插件没装 / DSH 没开）
        await sleep(8000)
      }
    }
  }

  // ---- 窗口行为 ----
  $('close').addEventListener('click', async () => {
    try { await win.destroy() } catch (e) { window.close() }
  })

  // ---- 批准应答 ----
  function answerApproval(outcome) {
    if (!pendingAsk) return
    // 调试 mock 审批：不发给服务端，直接模拟清除
    if (pendingAsk.askId === 'debug') {
      pendingAsk = null
      askAnswered = false
      render()
      return
    }
    if (!ws || ws.readyState !== 1) return
    askAnswered = true
    render()
    try {
      ws.send(JSON.stringify({ type: 'approval/respond', protocolVersion: 1, askId: pendingAsk.askId, outcome }))
    } catch (e) {
      askAnswered = false
      render()
    }
  }
  $('btn-allow').addEventListener('click', () => answerApproval('allowed-once'))
  $('btn-deny').addEventListener('click', () => answerApproval('rejected'))

  // 拖拽：显式调用 startDragging（drag-region 属性会被子元素命中拦截，不可靠）
  $('pet').addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    if (ev.target.closest('.close')) return
    if (ev.target.closest('.debug-menu')) return
    win.startDragging().catch(() => {})
  })

  // ============ 调试模式：右键宠物弹出状态菜单 ============
  const dmMenu = $('debug-menu')
  // 解析菜单项 data-debug → 调试锁定值
  const DEBUG_VALUES = {
    'live': null,
    'offline': { state: 'offline', activity: 'idle', intensity: 0 },
    'sleeping': { state: 'sleeping', activity: 'idle', intensity: 0 },
    'needYou': { state: 'needYou', activity: 'idle', intensity: 0 },
    'panic': { state: 'panic', activity: 'idle', intensity: 0 },
    'celebrating': { state: 'celebrating', activity: 'idle', intensity: 0 },
    'working-thinking': { state: 'working', activity: 'thinking', intensity: 2 },
    'working-coding': { state: 'working', activity: 'coding', intensity: 0 },
    'working-cmd': { state: 'working', activity: 'cmd', intensity: 0 },
    'working-search': { state: 'working', activity: 'search', intensity: 0 },
    'working-spawning': { state: 'working', activity: 'spawning', intensity: 0 },
  }
  function openDebugMenu() {
    dmMenu.classList.add('open')
    // 高亮当前锁定项
    const cur = debugMode ? (debugMode.state === 'working'
      ? 'working-' + debugMode.activity + (debugMode.activity === 'thinking' ? debugMode.intensity : '')
      : debugMode.state) : 'live'
    dmMenu.querySelectorAll('.dm-item').forEach((it) => {
      it.classList.toggle('active', it.dataset.debug === cur)
    })
  }
  function closeDebugMenu() {
    dmMenu.classList.remove('open')
  }
  // 右键宠物弹出菜单（contextmenu 不用于拖拽）
  $('pet').addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    openDebugMenu()
  })
  // 点击菜单项：切换调试锁定
  dmMenu.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.dm-item')
    if (!btn) return
    const key = btn.dataset.debug
    if (key === undefined) return
    debugMode = DEBUG_VALUES[key]
    // needYou 需要模拟一个待批准请求，才能看到审批区/按钮
    if (key === 'needYou') {
      pendingAsk = { askId: 'debug', toolName: 'escalate sandbox', reason: '请求提升沙箱权限执行命令' }
      askAnswered = false
    } else if (pendingAsk && pendingAsk.askId === 'debug') {
      pendingAsk = null
      askAnswered = false
    }
    closeDebugMenu()
    render()
  })
  // 点击菜单外（宠物本体空白区）关闭菜单
  document.addEventListener('click', (ev) => {
    if (dmMenu.classList.contains('open') && !ev.target.closest('.debug-menu')) {
      closeDebugMenu()
    }
  })

  // 位置记忆（物理像素）——只在窗口回到基准尺寸时保存，避免坏值
  let saveTimer = null
  win.onMoved(({ payload }) => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try { localStorage.setItem('petPos', JSON.stringify({ x: payload.x, y: payload.y })) } catch (e) {}
    }, 500)
  })
  ;(async () => {
    try {
      const pos = JSON.parse(localStorage.getItem('petPos') || 'null')
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        // 校验位置在屏幕内
        let ok = true
        try {
          const mon = await win.currentMonitor()
          if (mon && mon.size) {
            if (pos.x < -50 || pos.y < -50 ||
                pos.x > mon.size.width + 50 || pos.y > mon.size.height + 50) ok = false
          }
        } catch (e) {}
        if (ok) await win.setPosition(new T.window.PhysicalPosition(pos.x, pos.y))
      }
    } catch (e) {}
  })()

  render()
  ensureLoop()
})()
