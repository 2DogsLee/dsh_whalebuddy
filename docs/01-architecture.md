# 01 · 整体架构

## 1. 背景与目标

DSH（DeepSeek Harness）以 Cordis 插件体系组成，agent 会话的每一次状态迁移
（开始/结束一轮、执行工具、流式输出、请求批准、子代理启动……）都会在 Host 侧
产生事件。本项目要做的桌面宠物 = 把这股事件流**折叠成一个小型状态对象**，
推送给一个独立的桌面进程，用动画表达出来。

目标：

- 宠物**常驻**桌面，DSH 可间歇运行；
- 状态延迟低（感知 → 表现 < 1s）；
- 宠物进程崩溃/退出**不影响 DSH**；
- DSH 重启后宠物自动重连；
- 为将来"点击宠物做操作"预留通道。

非目标（第一版）：

- 不做双向交互（批准/拒绝、暂停任务等只预留协议）；
- 不做多宠物/每会话一只宠物（协议支持，表现层先做聚合单只）；
- 不跨机器、不暴露到 localhost 之外。

## 2. 三层架构

```
┌─ DSH 进程（Node.js）────────────────────────────────────┐
│                                                          │
│  ① 感知层：Cordis 插件（Host 半边）                       │
│     EventCollectors  ──监听──▶  StateAggregator          │
│       agent/status         （折叠 + 500ms 节流）          │
│       tools/*                   │                        │
│       llm/stream                ▼                        │
│       approval/request      WsHub（广播）                 │
│       subagent/* workflow/*    │                         │
│       jobs / tokenMeter …      │ webServer.registerUpgrade│
│  ┌─────────────────────────────┼───────────────────┐     │
└──┤ 传输层：WS 路由挂在 DSH 现有 HTTP 端口上              │─────┘
   │   ws://127.0.0.1:<dsh端口>/dsh-pet/ws             │
   └─────────────────────────────┬───────────────────┘
                                 ▼
┌─ 宠物进程（表现层）───────────────────────────────────────┐
│  ② Tauri 壳：透明 / 置顶 / 无边框 / 不进任务栏             │
│  ③ 前端：状态机 + 动画（Lottie / sprite / CSS）            │
│     连接管理：端口发现、心跳、指数退避重连                   │
└──────────────────────────────────────────────────────────┘
```

## 3. 组件职责

| 组件 | 位置 | 职责 | 不做什么 |
|---|---|---|---|
| 感知层插件 | DSH 进程内 | 订阅事件/服务，把高频事件流折叠成低频、稳定、可序列化的 `state` 对象 | 不做任何业务决策，不改写事件流 |
| WsHub | 感知层插件内 | 在现有 webServer 端口上注册 upgrade 路由，管理连接，广播 state | 不新开端口，不做鉴权以外的网络逻辑 |
| Tauri 壳 | 独立进程 | 透明置顶窗口、拖拽、点击穿透、自启动 | 不解析 DSH 内部对象，只懂协议 |
| 宠物前端 | Tauri WebView 内 | 状态机驱动动画、重连逻辑 | 不直接访问 DSH 任何 API |

关键解耦点：**宠物端只依赖 `docs/03-protocol.md` 这一份协议**。
感知层内部怎么实现、DSH 怎么升级，都与宠物无关；反之宠物壳换成 Electron
也不影响感知层。

## 4. 技术选型与理由

### 4.1 感知层：Cordis 插件（没有悬念）

DSH 的一切能力都经 Cordis 上下文暴露，事件与服务只能从这里拿。分两种装载形态：

- **动态插件**（`cordis_define` + `cordis_run`）：零配置、即写即跑，适合 M1 验证；
  缺点是不跨进程重启。
- **composition 行**：验证通过后写进自己的 composition 常驻，DSH 启动即生效。
  按规范**复制**发行版 composition 再改，绝不直接改发行版安装目录。

### 4.2 传输层：复用 webServer 的 upgrade 路由（vs 备选方案）

| 备选 | 结论 | 理由 |
|---|---|---|
| `webServer.registerUpgrade` + WS | **采用** | 零新端口、零新进程；webServer 已绑定 127.0.0.1，天然不对外 |
| 宠物轮询 HTTP 路由 | 弃 | 延迟与轮询频率不可兼得；事件驱动才是宠物的意义 |
| 状态写 JSON 文件 + watch | 弃 | Windows 文件通知延迟不稳定，最终退化成轮询 |
| 插件自己 listen 新端口 | 弃 | 多一个端口要管、要发现，还可能撞端口 |

### 4.3 表现层：Tauri（vs 备选方案）

| 需求 | Tauri | Electron | Python(pywebview/PyQt) |
|---|---|---|---|
| 常驻内存 | 低（复用系统 WebView2） | 高（自带 Chromium） | 中 |
| 动画能力 | Web 全家桶（Lottie/sprite/CSS/Spine） | 同左 | 受壳限制，打磨成本高 |
| 透明置顶无边框 | 成熟支持 | 成熟支持 | 可用但坑多 |
| 生态/现成集成 | 够用 | 最全（Live2D 现成） | 少 |

用户明确要求"动画效果好、内存占用低"，Tauri 是交集最优解。
将来要上 Live2D 也有 Web SDK 路径，不封死。

## 5. 数据流（一次典型的状态变化）

```
用户在会话里发起请求
  → agent/status(running)          ┐
  → llm/stream 持续 chunk          ├ EventCollectors 收集
  → tools/execute(pwsh)            ┘
  → StateAggregator 折叠：activity="cmd", session.status="running"
  → 500ms 节流窗口到期，生成 state 快照
  → WsHub 广播 {type:"state", ...}
  → 宠物端 WS 收到 → 状态机转移 sleeping→working(cmd)
  → 播放对应动画
```

等待批准（`approval/request`）是最高优先级信号：宠物切到 `needYou` 状态敲门。
这是本项目最实用的单点价值——**不用盯着 GUI 也不会错过批准请求**。

## 6. 设计原则

1. **折叠优先**：宠物收到的是稳定状态机转移，不是原始事件流；高频信号
   （`llm/stream`）只在聚合器里留计数/强度，绝不透传。
2. **协议最小**：state 对象字段少而稳，加字段向后兼容，改字段升 protocolVersion。
3. **副作用可逆**：插件里每个事件订阅、路由注册、连接都持有 disposer，
   stop/update/undefine 后 DSH 恢复原样。
4. **离线友好**：宠物把"连不上"当作正常状态（offline：睡觉/散步），不是错误。
5. **不碰内部对象**：Agent/Session 等活对象只读需要的叶子字段（如标题、状态值），
   严禁 JSON.stringify 整体序列化。

## 7. 部署形态演进

```
M1  动态插件（会话内 define/run）──▶ 用 wscat/浏览器页验证 state 流质量
M2  Tauri 壳开发期仍用动态插件      ─▶ 宠物完整可用，但插件要手动 define
M3  固化进自定义 composition        ─▶ DSH 启动即常驻；再加双向 command
```

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| waterfall 事件监听器写错阻塞管线（tools/execute、llm/stream、approval/request） | 影响 DSH 本体功能 | 观察型监听器统一模式：`try { ... } finally { return next() }`，绝不修改入参 |
| webServer upgrade 路由的精确 API 形状未在设计期验证 | M1 开发时返工 | 已列入 M1 首项任务：先 `cordis_inspect_query` 查 WebUpgradeRoute 契约再写代码 |
| DSH 端口动态变化，宠物找不到 | 宠物永远 offline | 端口发现策略：配置文件 → 缓存的上次端口 → 端口段扫描（见 03 文档） |
| 动态插件不跨重启 | 每次开机要手动跑 | M3 固化 composition；固化前 README 标注手动步骤 |
| 宠物进程泄漏/占 CPU | 桌面体验差 | 睡眠态降帧、动画暂停策略（见 05 文档） |
