# 04 · 感知层插件详细设计

一个 Cordis 插件（Host 半边，无需 Client 半边），装载形态随里程碑变化
（M1/M2 动态插件，M3 固化 composition 行），**代码本体不变**。

## 1. 模块划分

```
apply(ctx)
 ├── EventCollectors ──── 订阅 §2 信号，写入 Aggregator 内部状态
 ├── StateAggregator ──── 持有可序列化内部状态；throttle 500ms flush
 │                         仲裁优先级 → 生成 state 快照 → 交给 WsHub
 ├── WsHub ────────────── webServer 路由 + WS 连接表 + 广播
 └── (M3) settings 命名空间、command 分发器
```

全部组件的注册都通过 `ctx.on(...)` / 服务返回的 disposer / `ctx.effect(...)`
挂到当前 Fiber，stop/undefine 后零残留。

## 2. EventCollectors 实现要点

### 2.1 emit 类（直接订阅）

```js
const offs = []
offs.push(ctx.on('agent/status', (payload) => {
  agg.setSessionStatus(readLeaf(payload))       // 只取 status 等叶子
}))
offs.push(ctx.on('subagent/start', () => agg.bumpSubagents(+1)))
// agent/error → agg.pulse('panic')
// goal/changed → agg.pulse('celebrating')
// workflow/phase / workflow/start / workflow/end → agg.setWorkflow(...)
// agent/inbox/inserted → agg.markIncoming()
```

### 2.2 waterfall 类（观察者模式，必须透传）

```js
offs.push(ctx.on('tools/execute', async (exec, next) => {
  try { agg.setActivity(mapToolName(exec)) } catch {}
  return next()                                  // ← 红线：永远透传
}))
offs.push(ctx.on('llm/stream', async (options, next) => {
  try { agg.bumpThinking() } catch {}            // 只做 O(1) 计数
  const stream = await next()
  return (async function* (s) {                  // 透传同时数 chunk
    for await (const c of s) { agg.bumpThinking(); yield c }
  })(stream)
}))
offs.push(ctx.on('approval/request', async (req, next) => {
  agg.setApproval({ pending: true, summary: summarize(req) })
  try { return await next() } finally { agg.setApproval({ pending: false }) }
}))
```

### 2.3 服务类（ctx.get 可选依赖）

```js
const jobs = ctx.get('jobs')            // 可选：不在则 jobs[] 恒空
if (jobs) {
  offs.push(jobs.onJobsChanged(() => agg.refreshJobs(jobs)))
  offs.push(jobs.onJobDone(() => agg.refreshJobs(jobs)))
}
// sessionTitle / tokenMeter / agents 同模式，全部 ctx.get + undefined 分支
```

## 3. StateAggregator

### 3.1 内部状态（可序列化，与协议 state 一一对应）

```js
const internal = {
  session: { title: '', status: 'idle', turn: 0 },
  activity: 'idle',
  thinkTicks: 0,            // 自上次 flush 以来的 llm chunk 数
  awaitingApproval: { pending: false, summary: null },
  subagents: 0,
  jobs: [],
  workflow: { running: false, phase: null },
  tokens: 0,
  pulse: null,              // { kind: 'panic' | 'celebrating', ts }
}
```

### 3.2 flush 与节流

- `ctx.timer.throttle(flush, 500)`（timer 服务自带 disposer）；
- flush 时：`thinkTicks` → `activityIntensity`（0–3 分档）后清零；
  `pulse` 超过 8s 自动过期；生成快照交 WsHub；
- **仅广播有变化时**：对上一份快照做浅比较，无 diff 不发（省宠物端动画抖动）。

### 3.3 优先级仲裁

```
needYou        = awaitingApproval.pending
panic          = pulse.kind === 'panic'（8s 内）
working        = session.status === 'running'
celebrating    = pulse.kind === 'celebrating'（8s 内）
sleeping       = 其余
```

仲裁结果不直接进协议（宠物端自己算，保持感知层薄），
但 `activity` 字段已隐含 working 的子状态。

## 4. WsHub

### 4.1 路由注册（M1 首项任务：先查 WebRoute/WebUpgradeRoute 精确契约）

```js
offs.push(ctx.webServer.register({
  method: 'GET', path: '/dsh-pet/handshake',   // 形状以 inspect 为准
  handler: () => ({ ok: true, name: 'dsh-pet', protocolVersion: 1 }),
}))
offs.push(ctx.webServer.registerUpgrade({
  path: '/dsh-pet/ws',
  handler: (socket) => {
    const conn = track(socket)                 // 连接表登记
    send(conn, latestSnapshot)                 // 连上即全量
    socket.on('message', ...)                  // v1 仅容忍 pong/hello
    socket.on('close', () => untrack(conn))
  },
}))
```

### 4.2 连接管理

- 连接表 `Set`；广播 = 逐个 send，send 抛错则移除该连接；
- 心跳：`ctx.timer.interval(broadcastPing, 10_000)`；
- dispose：遍历连接表逐个关闭，再注销路由与 interval。

## 5. 装载形态

| 阶段 | 形态 | 操作 |
|---|---|---|
| M1/M2 | 动态插件 | `cordis_define`（Host 半边代码）→ `cordis_run`；每次 DSH 重启后需重新 define（会话内可接受） |
| M3 | composition 行 | 复制发行版 composition 到自己的目录后加一行插件；遵循 `editing-cordis-compositions` skill 规范 |

## 6. 测试与验证策略

- **M1 冒烟**：插件跑起来后，用浏览器控制台
  `new WebSocket('ws://127.0.0.1:<port>/dsh-pet/ws')` 观察 state 消息；
- **信号注入**：在真实会话里跑一条命令（触发 tools/execute）、等一次批准请求，
  核对 state 各字段；
- **红线回归**：确认加了监听器之后工具执行、流式输出、批准流程行为不变
  （透传模式生效）；
- **残留检查**：`cordis_stop` 后确认路由 404、无定时器泄漏（DSH 日志无警告）。

## 7. 开发顺序（M1 内部）

1. `cordis_inspect_query` 复核 02 文档 §5 列出的五个契约；
2. WsHub 最小版：handshake + WS + 广播固定假 state → 浏览器验证通道；
3. Aggregator + agent/status / tools / llm/stream 三个采集器 → 真实事件驱动；
4. approval/subagent/workflow/jobs 采集器补齐；
5. 节流、diff 抑制、心跳打磨。
