# 11 · 工作区聚焦与项目待办（设计）

> 需求原话：桌面宠物能否获取我在 DSH（含 Desktop）正在聚焦的会话的工作区？
> 想针对工作区（项目）管理待办清单，通过宠物做入口。
>
> 结论：**能**。工作区信息 Host 侧现成可得；"正在聚焦"是 GUI 客户端状态、Host 无此概念，
> 需要 whalebuddy 的 client 半边新增一条上报链路；项目待办由 whalebuddy 自建存储。
> 本文是实施前设计，信号源结论均来自对当前 DSH Desktop 运行时
> （`resources/dsh-runtime/node_modules/@deepseek-ai/*`）源码的实测核查。
>
> **实现状态（v0.3.0，已上线验证 ✓）**：三处改动全部落地，冒烟
> （`scripts/_smoke-todos.cjs`）与真实 DSH 环境均通过——GUI 真焦点跟随、
> workspaceRegistry 项目名反查、宠物面板增删改、todos.json 持久化、Origin
> 拒绝（含 tauri.localhost 白名单实战修正，见 §3.4）。
> 实装两枚坑存档：① 注入回调同步调起时 `conns` TDZ（已用 queueMicrotask 隔离）；
> ② Origin 白名单漏了宠物 WebView 的 `http://tauri.localhost` 导致宠物 WS 全断。

## 1. 信号源核查

### 1.1 工作区（cwd）：Host 侧三层可得 ✅

| 层次 | 来源 | 用途 |
|---|---|---|
| `agent.session.header.cwd` | `dsh-session`：会话 header 携带可选绝对 cwd（校验强制绝对路径）；`dsh-agent-loop` 以 `ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)` 注入提示词 | 活会话的工作区路径。whalebuddy 的 `agents` Map 已持有 `entry.agent` 活引用，读叶子字段即可（红线：只读叶子，不序列化活对象） |
| `workspaceRegistry` Host 服务 | apiproxy 以 `ctx.workspaceRegistry.list()` 支撑 `workspace.list` RPC；条目含 `id / path / title / sessionIds` | cwd → 项目名反查（`cwd === workspace.path` 恰是 client 侧 `connectWorkspace` 的对照法） |
| `session.list` RPC 的 `SessionSummary.cwd` | apiproxy sessions contract；冷会话也带 | client 半边读聚焦会话 cwd 用（见 §1.2） |

### 1.2 聚焦（focus）：Host 无、Client 有 ⚠

- **Host 侧无焦点概念**：apiproxy 的 mux 流在连接建立时订阅**全部**会话
  （`for (const session of ctx.sessions.list()) subscribeSession(queue, session)`），
  订阅 ≠ 聚焦；`KNOWN_SESSION_EVENT_TYPES` 里没有任何 viewed/focused 类事件；
  因此 Host 事件流推不出"用户正在看哪个会话"。
- **真焦点在 client-runtime**：`SessionRuntime`（`reflect.provide("sessions", …)`）的
  `list` 快照店形如 `{ ids, byId, current, currentAddress, … }`——`current` 即当前选中
  会话 id（`sessions.open(id)` 是切换入口，选择持久化在 localStorage 键 `dsh.sessions.current`，
  GUI 重载后立即恢复）；`byId[current].cwd` 即聚焦工作区路径。
- **client 插件可达性**：client 半边在 `exports.inject` 声明 `'sessions'` 后即可拿到
  `ctx.sessions`（dsh-cordis-client-runner 的 guard facade 只放行声明过的服务，
  `sessions` 在 Client Service 目录中；guard 对非函数属性原样放行，
  故 `ctx.sessions.list.getSnapshot()` 可用）。
  ⚠ 实现首日需一次注入冒烟验证（§7 第 1 条），失败则降级为近似焦点。

### 1.3 待办：DSH 自带的不能用 ❌ → 自建

`todo_write`（`dsh-tool-todo`）是**会话内 agent 的计划**：整表替换、写进会话日志、
`turn/start` 即清空（standing plan）、随会话生灭——不是按项目的用户待办。
结论：whalebuddy 自建 per-workspace 存储（§4.2）；可选增强见 §8。

## 2. 总体数据流

```
┌─ DSH GUI（Desktop / 浏览器，同一 web 前端） ─────────────────────────┐
│ whalebuddy client 半边（现有 client.js 升级）                        │
│   sessions.list 订阅 → current / byId[current].cwd                   │
│   变化即 POST /dsh-pet/api/focus（+5s 心跳上报）                     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ 同源 HTTP（127.0.0.1）
┌─ DSH Host ───────────────────▼───────────────────────────────────────┐
│ whalebuddy 感知层插件                                                 │
│   FocusTracker：last-writer-wins 记录上报；15s 无上报 → 回落          │
│     source='activity'（现有"最近发事件的会话"近似，cwd 取              │
│     entry.agent.session.header.cwd）                                 │
│   workspaceRegistry（可选注入）：cwd → workspaceTitle 反查            │
│   TodosStore：$DSH_HOME/whalebuddy/todos.json，按规范化 cwd 分键      │
│   → state.focus + state.todos 并入现有 500ms 节流 flush / diff 广播   │
│   ← 宠物入站命令 todo/add|toggle|remove|edit|clear（WS，§3.2）        │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ 现有 WS /dsh-pet/ws
┌─ 桌面宠物 ────────────────────▼───────────────────────────────────────┐
│ 点击鲸鱼 / 右键「📋 项目待办」→ 待办面板：项目名 + 清单 + 勾选/增删    │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. 协议变更（protocolVersion 保持 1，字段只增）

### 3.1 `state` 新增字段

```json
{
  "focus": {
    "sessionId": "session-…",
    "cwd": "D:\\projects\\dsh-pet",
    "workspaceId": "ws-…",
    "workspaceTitle": "dsh-pet",
    "source": "gui" | "activity",
    "reportedAt": 1730000000000
  },
  "todos": [
    { "id": "<uuid>", "content": "…", "status": "pending" | "done",
      "createdAt": 0, "updatedAt": 0 }
  ]
}
```

- `todos` 恒为**当前聚焦工作区**的清单（宠物面板只服务当前项目；切换项目即换表）。
- 协议稳定性规则（03 文档 §3）：字段只增不改名、宠物端容忍未知字段——本变更满足，
  不升 protocolVersion。

### 3.2 新入站消息（宠物 → DSH，启用 03 文档 §7 预留的 command 通道）

```
宠物 → DSH  command:
  { "type": "command", "id": "c-…", "action": "todo/add",
    "payload": { "content": "…" } }
  actions: todo/add | todo/toggle {id} | todo/remove {id}
           | todo/edit {id, content} | todo/clear {doneOnly?}
DSH → 宠物  commandResult:
  { "type": "commandResult", "id": "c-…", "ok": true, "todos": […] }
```

- 与 `approval/respond` 同一条 WS 入站解析路径（`handleClientMessage` 扩展）；
  每个命令落在 TodosStore 后回带最新清单，宠物端用它校正乐观更新。
- `focus/refresh`（请求全量 state）作为便利 action 一并提供。

### 3.3 新 HTTP 路由（Host webServer）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/dsh-pet/api/focus` | POST | client 半边上报 `{ sessionId, cwd }`；同源限制；字段截断校验 |
| `/dsh-pet/api/todos` | GET | 当前焦点清单 JSON（调试/兜底） |
| `/dsh-pet/todos` | GET/POST | 轻量兜底页（宠物离线时 GUI 里也能管理，同 `/dsh-pet/config` 风格） |

### 3.4 安全（顺带收敛 03 文档 §8 的既有 TODO）

- WS 升级路由与 `/dsh-pet/api/*`、`/dsh-pet/todos` 增加 **Origin 校验**：无 Origin
  （宠物壳原生 WS / curl 探测）放行；浏览器来源放宽到**回环 origin**——
  `127.0.0.1` / `localhost` / `*.localhost`（含宠物 WebView 的
  `http://tauri.localhost`，实现首日踩过：漏了它导致宠物 WS 全被断）及本机
  其他端口的本机页面（proto 预览 127.0.0.1:8765），拒绝一切非回环来源——
  跨源 WS 连接不受浏览器同源策略限制，恶意网页本可直接连上来答批准，
  这是 v1.1 起就该补的口子。
- todo 命令只写 whalebuddy 自己的存储文件；ws 键 = 规范化 cwd，
  且必须是 `workspaceRegistry.list()` 的 path 或某个活 agent 的 cwd（白名单校验），
  不接受任意路径。

## 4. Host 插件改动（`whalebuddy/lib/index.cjs`）

### 4.1 FocusTracker

- 状态 `focusReport = { sessionId, cwd, at }`；last-writer-wins（多 GUI 窗口）。
- **新鲜度回落**：client 半边变化即报 + 每 5s 心跳；Host 若 15s 无新鲜上报，
  `source` 回落 `'activity'`（现有 `agg.session.id` 近似 + `entry.agent.session.header.cwd`）。
  GUI 全关时宠物仍显示最近活跃会话的工作区。
- `state.session.cwd` 一并取自 focus（两种 source 同一字段），`sessions.list` 条目补 `cwd`。

### 4.2 TodosStore

- 文件：`$DSH_HOME/whalebuddy/todos.json`，shape：

```json
{ "version": 1,
  "workspaces": {
    "D:\\projects\\dsh-pet": {
      "title": "dsh-pet", "updatedAt": 0,
      "items": [ { "id": "…", "content": "…", "status": "pending",
                    "createdAt": 0, "updatedAt": 0 } ]
    }
  } }
```

- 原子写（tmp + rename）；写操作串行排队防交错；
  单工作区条目上限 200、单条 content ≤ 500 字符（超限截断/拒绝并回错）；
  id 用 `randomUUID()`。
- `workspaceTitle` 冗余存进文件（反查失败时兜底 basename）。

### 4.3 workspaceRegistry 可选注入

- `ctx.inject(['workspaceRegistry'], …)`（与 settings 同模式，缺席静默降级）：
  焦点 cwd → title 反查；同时给 §3.4 白名单供源。

### 4.4 广播与清理

- focus/todos 变化并入现有 `markDirty` → 500ms 节流 flush → diff 抑制广播（照旧）。
- TodosStore 持久层无监听器/定时器，`ctx.effect` 清理不需要额外动作。

## 5. client 半边改动（`whalebuddy/client/client.js`）

- `exports.inject` 增加 `'sessions'`（保留 `slots` / `settingsScope`）。
- watcher：`sessions.list.subscribe(report)`；`report()` 读快照 →
  `{ sessionId: current, cwd: byId[current]?.cwd }`，与上次不同或心跳到点即
  `fetch('/dsh-pet/api/focus', { method: 'POST', … })`，失败静默。
- 设置卡片逻辑不动；`sessions` 服务缺席（旧版 DSH）→ try/catch 静默降级，
  等同现状近似焦点（Host 自动回落 `source='activity'`）。

## 6. 宠物端改动（`app/ui/index.html`，无 Rust 改动）

- 入口：点击鲸鱼 / 右键菜单新增「📋 项目待办」→ 弹出面板（复用皮肤 CSS 变量）。
- 面板内容：项目名（`focus.workspaceTitle` || basename(cwd)）、来源徽标
  （`gui`=跟随 GUI 聚焦 / `activity`=最近活跃）、清单（勾选 / 删除 / 添加输入框）。
- 交互：todo 命令按 §3.2 发送，本地先乐观更新，`commandResult.todos` 到达后校正；
  3s 无 commandResult 回滚并提示。
- 边界：离线 / 无 cwd（`focus` 为空）→ 面板显示离线提示，不可编辑。

## 7. 验证清单

1. **client 注入冒烟**：GUI 控制台出现 focus 上报日志 / Host 日志收到
   `/dsh-pet/api/focus`；`sessions` 不可注入时确认静默降级路径。
2. 切换会话 → 宠物 `state.focus.sessionId/cwd` 即时跟随（真焦点，非近似）。
3. 关闭全部 GUI 窗口 → ≤15s 后 `source` 回落 `'activity'`。
4. 重启 DSH → todos.json 完整；宠物离线时 `/dsh-pet/todos` 兜底页可增删。
5. Origin 校验：跨源页面连 WS / POST focus 被拒；宠物壳（无 Origin）不受影响。
6. 回归：approval/respond、设置卡片、状态动画、`/dsh-pet/config` 全部不受影响。

## 8. 开放问题（实现前定夺）

| 问题 | 备选 |
|---|---|
| 多窗口策略 | last-writer-wins（简单，默认）；per-client 记录 + 宠物面板可切换 |
| 是否镜像聚焦会话的 agent todos（`todos` projection 只读）进面板 | v1 不做 / v1.3 只读小节 |
| workspace 删除时待办处置 | 保留（cwd 为键，天然留存）/ 随 workspace 归档清理 |
| 命令集合裁剪 | 最小集 add/toggle/remove，edit/clear 看面板交互需要 |

## 9. 工作量评估

| 改动面 | 规模 |
|---|---|
| Host 插件（FocusTracker + TodosStore + 路由 + Origin 校验） | ≈ 250–350 行 |
| client 半边（watcher + 心跳） | ≈ 40–60 行 |
| 宠物 UI（待办面板） | ≈ 150–250 行（纯前端） |
| 验证 | 一轮部署 + §7 冒烟 |
