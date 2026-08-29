# 02 · 信号源清单

来源：对当前 DSH 进程 Host 侧 Inspect Provider（Event.listEvents /
Service.listService）的实际查询结果。开发前应以当时的 inspect 结果复核
（事件可能随 DSH 版本增减）。

## 1. 事件信号（Host Event）

### 1.1 核心状态机

| 事件 | 模式 | payload 摘要 | 折叠用途 | 宠物表现 |
|---|---|---|---|---|
| `agent/status` | emit | `{ agent, status: 'idle' \| 'running' }` | `session.status`，**主状态机输入** | 睡觉 ⇄ 干活 |
| `agent/error` | emit | `{ agent, turn, step, error }` | `panic` 一次性脉冲 | 慌张/冒汗（短暂） |
| `agent/session-start` | emit | `{ agent, source }` | 会话开始标记 | 醒来打招呼 |
| `agent/created` / `agent/disposed` | emit | `{ agent }` | 会话集合增减 | 计数、打招呼/道别 |

### 1.2 活动细节（working 子状态）

| 事件 | 模式 | 折叠用途 | 宠物表现 |
|---|---|---|---|
| `tools/execute` | waterfall（around） | 当前工具名 → `activity` 细分 | 见 §3 活动映射表 |
| `tools/result` | emit | 工具结束，回落 activity | 动作收尾 |
| `llm/stream` | waterfall（around） | 流式生成中 → `activity="thinking"`，按 chunk 计数调节"思考强度" | 头顶冒泡、眼睛转动 |
| `agent/inbox/inserted` | emit | 有用户消息进来（即将开跑） | 竖起耳朵/看屏幕 |

### 1.3 提醒类（高优先级）

| 事件 | 模式 | 折叠用途 | 宠物表现 |
|---|---|---|---|
| `approval/request` | waterfall | `awaitingApproval`（挂起期间为 true，promise 落定后清除） | **敲门/跳起来喊你**，最高优先级 |

### 1.4 编排与进度

| 事件 | 模式 | 折叠用途 | 宠物表现 |
|---|---|---|---|
| `subagent/start` / `subagent/end` | emit | `subagents.running` 计数 | 召唤/收回小弟图标 |
| `workflow/start` / `workflow/phase` / `workflow/log` / `workflow/end` | emit | `workflow.phase`、运行中标记 | 阶段切换换姿势 |
| `workflow/agent-start` / `workflow/agent-end` | emit | workflow 内子代理计数 | 同 subagent |
| `goal/changed` | emit | 目标完成/暂停等变化 | `celebrating` 一次性脉冲 |

## 2. 服务信号（Host Service，用 ctx.get 按需读取）

| 服务 | 用法 | 用途 |
|---|---|---|
| `jobs` | `onJobsChanged(listener)` / `onJobDone(listener)`（均返回 disposer）；`list()` | 后台任务计数与描述 → `jobs[]` |
| `tokenMeter` | `measure(session)` | token 估算 → 趣味数值（吃饭长胖） |
| `sessionTitle` | `get(session)` / `refresh(session)` | 会话标题 → `session.title`（tooltip 展示） |
| `agents` | `list()` / `roots()` | 当前活跃会话集合与根会话选择 |
| `timer` | `throttle` / `interval`（自带 disposer） | 聚合器节流，避免手写计时器泄漏 |
| `webServer` | `registerUpgrade(route)` / `register(route)` | WS 通道 + HTTP handshake 路由（**核心**） |
| `settings` | `register(ns, schema)` | M3 可选：宠物设置命名空间 |

## 3. 活动映射表（activity 字段）

由 `tools/execute` / `llm/stream` 折叠：

| 原始信号 | activity 值 | 语义 | 动画 |
|---|---|---|---|
| （无进行中信号但 status=running） | `thinking` | 等模型/流式输出中 | 托腮思考、冒泡 |
| `llm/stream` chunk 密度高 | `thinking`（强度↑） | 输出很快 | 泡泡变密 |
| tool: `pwsh` / `shell` 类 | `cmd` | 跑命令 | 敲键盘、看终端 |
| tool: `edit` / `write` / `read` 类 | `coding` | 读写文件 | 搬砖、写字 |
| tool: `web_search` / `web fetch` 类 | `search` | 查资料 | 翻书、放大镜 |
| tool: `subagent`/`workflow` 类 | `spawning` | 派小弟 | 吹哨集合 |
| status=idle 且无挂起 | `idle` | — | 睡觉 |

> 精确的工具名集合在 M1 开发时从 `ToolExecution` 实际字段确认，
> 映射表做成插件内的可配置字典，未命中的工具名归入 `coding`。

## 4. 实现注意事项（红线）

1. **waterfall 事件必须透传**：`tools/execute`、`llm/stream`、`approval/request`
   是业务管线。观察型监听器统一写法：

   ```js
   ctx.on('tools/execute', async (exec, next) => {
     try { collect(exec) } catch { /* 采集失败不影响业务 */ }
     return next()
   })
   ```

2. **live 对象只读叶子**：payload 里的 `agent` / `session` 是活对象。
   只取 `status`、标题（经 `sessionTitle`）等叶子字段构建自己的小对象，
   禁止 `JSON.stringify(liveObj)` / 递归枚举 / 整体克隆。

3. **`llm/stream` 是高频流**：监听器里只做计数器自增（O(1)），
   任何字符串处理/序列化都放到节流窗口的 flush 里。

4. **emit 事件的 Scoped this**：事件签名带 `this: Scoped<Agent>`，
   监听回调不依赖 this，只消费 payload。

5. **优先级仲裁**：同一时刻多个信号竞争宠物状态时，按
   `needYou > panic > working > celebrating > sleeping` 仲裁（见 05 文档）。

## 5. M1 开发期待复核的契约

设计期只确认了目录级签名，以下精确形状需在写代码前用
`cordis_inspect_query` 复核：

- `WebRoute` / `WebUpgradeRoute` 的字段与 handler 形状（ws 升级怎么拿到 socket）
- `AgentStatus` 的字面量集合
- `ToolExecution` 中工具名/入参摘要字段
- `SessionEvent` 中与 turn 编号相关的字段（若 state 要带 turn）
- `ApprovalRequest` 中可展示给宠物的摘要字段（工具名/命令行）
