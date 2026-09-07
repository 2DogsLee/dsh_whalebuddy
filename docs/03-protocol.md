# 03 · 通信协议（DSH ⇄ 宠物）

## 1. 通道

挂在 DSH 现有 webServer（绑定 127.0.0.1）上，不新开端口：

| 通道 | 方法与路径 | 用途 |
|---|---|---|
| 握手 | `GET /dsh-pet/handshake` | HTTP JSON：确认这是 DSH Pet 端点 + 协议版本协商 |
| 数据 | `WS /dsh-pet/ws` | 双向消息信封；v1 只有 server→client 的 `state`/`ping` |
| 焦点上报 | `POST /dsh-pet/api/focus` | GUI client 半边上报真选中会话（`{sessionId, cwd}`）；GET 调试回当前推导焦点 |
| 待办数据 | `GET /dsh-pet/api/todos` | 当前焦点工作区清单 JSON（调试 / 兜底数据面） |
| 待办兜底页 | `GET/POST /dsh-pet/todos` | 宠物离线时的轻量管理页（同 `/dsh-pet/config` 风格） |

握手响应示例：

```json
{ "ok": true, "name": "dsh-pet", "protocolVersion": 1 }
```

- 宠物连 WS 前先握手；`protocolVersion` 不兼容则宠物进入 offline 并提示。
- 连接建立（含重连成功）后，插件**立即全量推送一次 state**，宠物无需请求。

## 2. 消息信封

所有 WS 消息都是带 `type` 字段的 JSON 对象：

```
DSH → 宠物:  state | ping | bye（服务端即将关闭）
             | approval/asked | approval/settled（v1.1 批准交互）
             | commandResult（v1.3 待办命令回执，只发请求方连接）
宠物 → DSH:  pong | hello
             | approval/respond（v1.1 已实现：批准应答）
             | command（v1.3 已实现：todo/* 与 focus/refresh）
```

### v1.3 待办命令（command 通道落地，设计见 docs/11 §3.2）

```
宠物 → DSH  command:
  { "type": "command", "id": "c-123", "action": "todo/add", "payload": { "content": "…" } }
  actions: todo/add {content} | todo/toggle {id} | todo/remove {id}
           | todo/edit {id, content} | todo/clear {doneOnly?}
           | focus/refresh（请求回全量 state）

DSH → 宠物  commandResult（只发请求方连接，不广播）:
  { "type": "commandResult", "id": "c-123", "ok": true, "todos": [...] }
  失败: { "type": "commandResult", "id": "c-123", "ok": false,
          "error": "no-focus" | "unknown-action" | "…" }
  focus/refresh: { "type": "commandResult", "id": "c-123", "ok": true, "state": <全量 state> }
```

- 变更在 ≤500ms 内经 flush 广播新 `state`（其余宠物客户端同步）；回执即时。

### v1.1 批准交互消息

服务端在 `approval/request` waterfall 外层充当"宠物回答者"（composition 行注册晚于
api-proxy 的 GUI 卡片路径 → 外层先跑）：宠物在线则截流给宠物答，离线/断开/超时（5min）
则 `next()` 交回 GUI 卡片。两路互斥，都走 `approval/asked`/`approval/decided` 审计。

```
DSH → 宠物  approval/asked:
  { "type": "approval/asked", "askId": "<uuid>",
    "sessionId": "session-…", "toolName": "pwsh", "reason": "…" }

DSH → 宠物  approval/settled（任何一方落定后的广播，含回退）:
  { "type": "approval/settled", "askId": "<uuid>",
    "outcome": "allowed-once" | "rejected" | "cancelled" | "fallback",
    "by": "pet" | "disconnect" | "timeout" | "abort" }

宠物 → DSH  approval/respond（对某个 asked 的应答；未知 askId / 非法 outcome 忽略）:
  { "type": "approval/respond", "protocolVersion": 1,
    "askId": "<uuid>", "outcome": "allowed-once" | "rejected" }
```

宠物断开 WS 即弃本地待批（服务端检测到全断开会自动回退 GUI 卡片，不会卡死）。

## 3. `state` 消息（v1 核心）

```json
{
  "type": "state",
  "protocolVersion": 1,
  "ts": 1730000000000,
  "session": {
    "title": "桌面宠物调研",
    "status": "running",
    "turn": 3,
    "cwd": "D:\\projects\\dsh-pet"
  },
  "focus": {
    "sessionId": "session-…",
    "cwd": "D:\\projects\\dsh-pet",
    "workspaceId": "ws-…",
    "workspaceTitle": "dsh-pet",
    "source": "gui",
    "reportedAt": 1730000000000
  },
  "todos": [
    { "id": "<uuid>", "content": "…", "status": "pending",
      "createdAt": 1730000000000, "updatedAt": 1730000000000 }
  ],
  "activity": "cmd",
  "activityIntensity": 2,
  "awaitingApproval": {
    "pending": true,
    "summary": "pwsh: pnpm build"
  },
  "subagents": { "running": 2 },
  "jobs": [
    { "id": "job_7", "desc": "pnpm build", "status": "running" }
  ],
  "workflow": { "running": true, "phase": "验证" },
  "tokens": { "estimated": 12345 }
}
```

### 字段表

| 字段 | 类型 | 来源信号 | 说明 |
|---|---|---|---|
| `session.title` | string | `sessionTitle` 服务 | 当前主会话标题（v1 聚合单会话） |
| `session.status` | `'idle' \| 'running'` | `agent/status` | 主状态机输入 |
| `session.turn` | number | 事件 payload | 当前轮次，仅展示用 |
| `session.cwd` | string? | 焦点推导（v1.3） | 聚焦工作区路径，无焦点为 null |
| `focus` | object? | `/dsh-pet/api/focus` 上报 / 活动近似（v1.3） | `{sessionId, cwd, workspaceId, workspaceTitle, source, reportedAt}`；`source: 'gui'`（15s 内新鲜上报，last-writer-wins）或 `'activity'`（回落最近发事件会话，cwd 取 `agent.session.header.cwd`）；无焦点为 null |
| `todos[]` | 数组 | TodosStore（v1.3） | 当前聚焦工作区待办 `{id, content, status, createdAt, updatedAt}`；`status: 'pending' \| 'done'`；持久化于 `$DSH_HOME/whalebuddy/todos.json` |
| `activity` | 枚举 | `tools/*`、`llm/stream` | `idle` `thinking` `coding` `cmd` `search` `spawning`（映射表见 02 文档 §3） |
| `activityIntensity` | 0–3 | `llm/stream` chunk 频率 | 冒泡密度等动画强度 |
| `awaitingApproval.pending` | bool | `approval/request` 挂起期间 | 最高优先级信号 |
| `awaitingApproval.summary` | string? | ApprovalRequest 摘要 | 宠物气泡可显示"在等你批准：pnpm build" |
| `subagents.running` | number | `subagent/start`/`end` | 小弟计数 |
| `jobs[]` | 数组 | `jobs` 服务 | 后台任务快照（每项 ≤ 若干条，只保留 running） |
| `workflow.running` / `phase` | bool/string | `workflow/*` | 阶段进度 |
| `tokens.estimated` | number | `tokenMeter` | 趣味数值 |

### 稳定性规则

- 字段**只增不改名**；新增字段宠物端必须容忍未知字段；
- 不兼容变更（改语义/改类型）→ 升 `protocolVersion`，握手期协商；
- v1 聚合单会话：多 agent 时选"最近有活动的根会话"为代表，其余以
  `subagents`/`workflow` 计数体现。按会话细分的 `agents[]` 数组留待 v2。

## 4. 心跳与保活

- 插件每 **10s** 广播 `{ "type": "ping", "ts }`；
- 宠物收到 ping 更新存活时间戳；**30s** 未收到任何消息视为断线，进入重连；
- 宠物可选回复 `pong`（v1 服务端不强制）。

## 5. 重连策略（宠物端）

```
失败 → 退避重连：1s, 2s, 4s, 8s, … 上限 30s
每次重连从"端口发现"重新开始（见 §6）
重连成功 → 插件全量 state → 宠物从 offline 恢复
offline 期间宠物播放"睡觉/散步"，绝不弹错误框
```

## 6. 端口发现（宠物端启动时）

DSH 的 webServer 端口是动态的（当前会话 GUI 在 60498，不能写死）。按序尝试：

1. **配置文件**：宠物目录下 `dsh-pet.json` 的 `port` 字段（用户显式指定）；
2. **上次缓存**：上次成功连接的端口（写入用户配置目录）；
3. **端口段扫描**：`127.0.0.1:60400–60500` 逐个 `GET /dsh-pet/handshake`，
   命中 `name === "dsh-pet"` 即为正确端口；
4. 全部失败 → offline，之后每 30s 重来一轮（因为 DSH 可能刚启动）。

## 7. `command` 消息（v1.3 起实现 todo/* 子集）

信封双向，宠物点击交互走同一 WS（首批落地待办命令，见 §2 v1.3 小节）：

```json
{ "type": "command", "id": "c-123", "action": "todo/add",
  "payload": { "content": "…" } }
```

- `action` 命名空间化：已实现 `todo/add|toggle|remove|edit|clear`、`focus/refresh`；
  后续候选（`job/kill`、`session/interrupt`…）落地前逐个评审；
- 每个命令带 `id`，插件回 `{ "type": "commandResult", "id": "c-123", "ok": true, … }`
  （只发请求方连接）；
- 安全边界：宠物是本机 UI 的等价物，但命令仍应限制在插件自管数据
  （todo 只写 `$DSH_HOME/whalebuddy/todos.json`），不越过 DSH 既有的
  approval/权限链路。

## 8. 安全

- webServer 只绑 127.0.0.1，宠物与 DSH 同机，无跨机暴露；
- 握手路径是唯一入口，未注册路径 404；
- **Origin 校验（v1.3 起）**：跨源 WS 连接不受浏览器同源策略限制，恶意网页可以
  尝试连 `/dsh-pet/ws`（答批准/发命令）或 POST `/dsh-pet/api/*`。升级路由与
  api/* / todos 路由只接受无 Origin（宠物壳原生 WS / curl 探测）或**回环 Origin**
  （`127.0.0.1` / `localhost` / `*.localhost`——含宠物 WebView 的
  `http://tauri.localhost`——及本机预览页 `127.0.0.1:8765`，端口不限）的请求，
  其余 403 / 断开；
- v1.3 起 宠物→DSH 的可执行语义仅限待办存储（上限 200 条/工作区、500 字/条），
  不触任意路径；批准应答本就复用 ApprovalService 审计链路；
- 后续扩展 command 动作集前仍需逐个评审（Origin 校验已落地，见上）。
