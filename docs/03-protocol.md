# 03 · 通信协议（DSH ⇄ 宠物）

## 1. 通道

挂在 DSH 现有 webServer（绑定 127.0.0.1）上，不新开端口：

| 通道 | 方法与路径 | 用途 |
|---|---|---|
| 握手 | `GET /dsh-pet/handshake` | HTTP JSON：确认这是 DSH Pet 端点 + 协议版本协商 |
| 数据 | `WS /dsh-pet/ws` | 双向消息信封；v1 只有 server→client 的 `state`/`ping` |

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
宠物 → DSH:  pong | hello | command（预留）
             | approval/respond（v1.1 已实现：批准应答）
```

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
    "turn": 3
  },
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

## 7. `command` 消息（v2 预留，v1 不实现）

信封已双向，将来宠物点击交互走同一 WS：

```json
{ "type": "command", "action": "approval/respond",
  "payload": { "outcome": "allow" }, "id": "c-123" }
```

- `action` 命名空间化（`approval/respond`、`job/kill`、`session/interrupt`…）；
- 每个命令带 `id`，插件回 `{ "type": "commandResult", "id": "c-123", "ok": true }`；
- 安全边界：宠物是本机 UI 的等价物，但命令仍应在插件侧走 DSH 既有的
  approval/权限链路，而不是绕过；具体设计在 M3 前另行评审。

## 8. 安全

- webServer 只绑 127.0.0.1，宠物与 DSH 同机，无跨机暴露；
- 握手路径是唯一入口，未注册路径 404；
- v1 宠物→DSH 无任何可执行语义，纯只读展示，无注入面；
- v2 引入 command 前必须过一次安全评审（本地恶意页面能否连这个 WS：
  浏览器同源策略会阻止跨源 WS 读取，但需复核 DSH webServer 的 Origin 校验行为）。
