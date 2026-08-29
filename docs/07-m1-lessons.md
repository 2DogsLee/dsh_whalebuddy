# M1 开发实录与踩坑记录

> 2026-08 完成的一次完整开发调试记录。M1 = 感知层插件（事件 → state JSON → WS 广播）。
> 以下是设计文档没写、但实战中踩出来的东西。

## 修复链（按发现顺序）

### 1. `llm/stream` 的 waterfall 签名陷阱（致命）

**症状**：插件激活后 DSH 整个卡死，用户被迫重启进程。

**原因**：目录签名是 `next: () => AsyncIterable<StreamChunk>`——`next()` **同步**返回异步可迭代对象。我写了 `await next()`，await 一个非 Promise 的可迭代对象后 `for await` 找不到 `[Symbol.asyncIterator]`，抛
`yield* (intermediate value) is not async iterable`，炸掉所有模型流式调用。

**修复**：
```js
// 错：const stream = await next()
// 对：
const stream = next()
return (async function* () {
  for await (const chunk of stream) { thinkTicks++; yield chunk }
})()
```

**教训**：三个 waterfall 事件的 next 形状不一样——`tools/execute` 和 `approval/request` 返回 Promise（可以 await/then），`llm/stream` 同步返回 AsyncIterable。写观察器前必须逐个查目录签名。

### 2. DSH 内置 `btoa` 是"UTF-8 文本 → base64"

**症状**：WS 握手响应的 `Sec-WebSocket-Accept` 是 44 字符（标准应为 28），浏览器拒绝握手（1006）。

**原因**：Builtin 目录里 `btoa` 的描述是 "Encode **UTF-8 text** as base64"。我按浏览器习惯传二进制字符串（charCode 0-255），它先做 UTF-8 编码（高位字节膨胀成 2 字节），20 字节 SHA-1 摘要变成 33 字节。

**修复**：手写 `b64encode(Uint8Array)`（~25 行），不依赖内置 btoa。

**教训**：动态插件的 Builtins 语义以 inspect 描述为准，不能按 Web 标准想当然。

### 3. `code.host` 传参时的笔误防线

一次 define 因一行多了一个 `)` 直接 SyntaxError 被拒（"Check bracket balance"）。define 的代码是字符串里嵌代码，长表达式（位运算组合）容易错位。**写完先 `node --check` 一下再传**（把函数体存文件验证），或保持每行一个动作。

### 4. webServer 路由不随插件 stop/undefine 释放

**症状**：`cordis_stop` / `cordis_undefine` 之后，`/dsh-pet/handshake` 依然响应；重新 define 同路径插件报
`webserver: duplicate exact route "/dsh-pet/handshake"`，无法再激活。

**原因**：`webServer.register()` 的 disposer 只在 fiber 正常 dispose 时执行；undefine 不保证走完这条清理链，路由表里的条目残留到进程结束。

** workaround**：
- 开发期每次要"干净重挂"同名路由 → 只能重启 DSH 进程；
- 或者换路径名（`/dsh-pet-v7/...`），但协议上留两套路径不干净。

**教训**：**一个进程里同一路径只注册一次**。开发迭代时要么忍受"旧 handler 泄漏"，要么规划好版本化路径。M3 固化 composition 后此问题消失（不再动态装卸）。

### 5. 端口发现：浏览器跨源 fetch 的三重坑

DSH 每次重启 webServer 端口都变（动态分配）。宠物页面要找到新端口，踩了三层：

1. **`file://` 起源直接禁 WebSocket**——必须从 `http://` 起源加载页面（起了一个本地静态服务器 :8765）。
2. **CORS**：页面(8765) fetch DSH(57865) 是跨源，DSH 端 handshake 响应必须带 `access-control-allow-origin: *`（已加进插件）。
3. **就算 CORS 修好，大范围端口扫描仍不可靠**：Chrome 每源并发连接上限(~6)排队、500ms abort 成批触发、部分端口 `ERR_INVALID_HTTP_RESPONSE`。12000 端口的扫描要么慢要么漏掉目标。

**最终策略（v0.5+）**：放弃自动扫描，**要求 `?port=<DSH端口>` 显式指定**。端口值 = `DSH_WEB_URL`（GUI 地址栏就是）。M2 的 Tauri 壳不受此限制——桌面进程没有浏览器同源模型，可以直接读环境/配置/扫描。

**教训**：浏览器沙箱里的"自动发现"是奢侈品；桌面壳才是正路。

### 6. inspect 工具的 input 通道故障（环境特定）

`cordis_inspect_query` 的 `input` 参数多次被拒（`"input" must be an object`，无论传字符串还是对象）。换路：直接读 DSH 运行时源码（`dsh-runtime/node_modules/@deepseek-ai/*/lib/*.js` + typert 声明块），契约反而更精确。**签名存疑时，发行版源码就是 source of truth。**

## 验证方法沉淀

- **裸 TCP 探测**（`scripts/_probe-ws.mjs`）：手写 HTTP upgrade 请求打印原始响应字节——排查握手问题的黄金手段，能看到浏览器吞掉的细节。
- **单端口最小页面**（`proto/ws-test.html`）：排除页面逻辑干扰，纯测 `new WebSocket()` 生命周期。
- **node 内建 WebSocket 客户端**（`scripts/ws-smoke.mjs`）：Node 24 全局有 WebSocket，绕开浏览器因素验证服务端。
- **RFC 6455 测试向量**：`Sec-WebSocket-Accept` 用标准 key（`dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`）对拍。

## M3 补充教训（composition 固化）

### 7. composition 行的 `name` 是 ESM import 语义：Windows 绝对路径必须写 `file:///` URL

**症状**：全局补丁层 `~/.dsh/cordis.patch.yml` 里写 `name: 'D:/projects/dsh-pet/host/dsh-pet-host.cjs'`，DSH 启动报
`Received protocol 'd:'`，**整个插件树加载失败**，桌面客户端起不来（全局层作用于所有 profile，任何 dsh 运行时都撞）。

**原因**：`name` 走 ESM loader 的 import 解析，裸的 `D:/...` 被当作 `d:` 协议的 URL。这与 agent 预设里 `./xxx.cjs` 相对路径能工作的现象不矛盾——相对路径按组合文件目录解析，绝对路径则必须是完整 URL。

**修复**：
```yaml
# 错：name: 'D:/projects/dsh-pet/host/dsh-pet-host.cjs'
# 对（盘符前三个斜杠不能省）：
name: 'file:///D:/projects/dsh-pet/host/dsh-pet-host.cjs'
```

**教训**：宿主组合/补丁层引用本地绝对路径文件时，一律 `file:///` + 正斜杠。写错了不是"这一行不生效"，而是整个进程起不来——改全局层要格外谨慎，出问题时删掉文件即可回滚。

### 8. 宿主平面的正确挂载位置是 `$DSH_HOME/cordis.patch.yml`

跨会话的感知层（聚合所有会话、消费者是进程外的宠物）按 composition 规范属宿主平面。agent 预设行是会话级挂载：收不到其他会话的 scoped 事件（`approval/request` 等按 agent 作用域派发），多会话还会撞 webServer 路由。home 补丁层热重载、作用于所有 profile，是用户 authored 宿主行的官方位置。

**waterfall 顺序**（批准回答者的互斥关键，源码事实）：cordis 的 `dispatch` 按注册顺序返回监听器，`waterfall` 从**列表头部**开始跑 → **先注册 = 外层 = 先跑**。要让宠物回答者稳定排在 api-proxy（GUI 卡片）外层，注册时用 `ctx.on('approval/request', fn, { prepend: true })` 显式插队，不赌组合挂载顺序。宠物在线则自己答，否则 `next()` 交回 GUI；两路互斥，且都经 ApprovalService 的 `approval/asked`/`approval/decided` 审计事件落日志，不绕权限。

### 9. Tauri 前端是编译时嵌入的：改 HTML 必须重新 cargo build

**症状**：改了 `app/ui/index.html`（加批准按钮）后直接重启旧 exe，界面毫无变化——一度误判为"插件没推消息"。

**教训**：Tauri 的 `frontendDist` 资源在编译时打进 exe（debug 构建同样如此），HTML/JS/CSS 任何改动都要 `cargo build` 后换新 exe。改 Rust 才需要全量重编（~33s），只改前端是增量（~8s）。

### 10. 事件处理器引用了 Promise 回调里的局部变量 = 点击静默死亡

**症状**：批准按钮可见可点，但点击毫无反应，无任何报错。

**根因**：`ws` 声明在 `ensureLoop` 内部 `new Promise((resolve) => { let ws … })` 回调的局部作用域，而按钮的 `answerApproval` 在 IIFE 顶层引用它——点击时直接 `ReferenceError: ws is not defined`，事件处理器当场死亡，浏览器不弹任何可见错误。

**教训**：跨函数共享的连接句柄（ws 等）必须提到 IIFE 顶层 `let ws = null`；事件处理器里访问未声明变量是静默杀手，宠物 UI 没有控制台可看，只能靠"每轮真机点一遍"验收。

### 11. hover 弹层与批准按钮的 z 冲突：待批时让位

悬停详情 `.tip` 是 `position:absolute; z-index:4`，与批准按钮占同一垂直区域——鼠标进入卡片想去点按钮时 tip 恰好弹出遮挡。修法：`.card.approving .tip { display:none }` + 待批时窗口定高（不随 hover 跳动，按钮不挪位）。**交互面只有一个时，模式化优先：详情让位于操作**。

### 12. 同步 command 阻塞主线程：release 直击"双击 exe 卡死"（2026-08-25）

**症状**：`cargo run` 一切正常；`cargo build --release` 后双击 exe，窗口冻死，事件日志 `Application Hang (1002)`。

**原因链**：
1. 从 DSH 终端跑 `cargo run` 时环境里有 `DSH_WEB_URL`，`discover_port` 第一行就命中返回——**全段扫描路径从未被真实执行过**；双击 exe 没有该环境变量，走进 8 线程扫 49152–65535；
2. `discover_port` 是**同步 command**，Tauri 2 里同步命令在主线程执行 → 扫描期间窗口消息泵停摆 → >5s 触发 Windows Application Hang。

**修复**（三层发现顺序补全 + 阻塞消除）：
- `async fn discover_port(port_hint)`——async 命令跑在 tokio 工作线程，扫描期间窗口保持可交互；
- 前端 localStorage 缓存上次成功端口（`petPort`），作为 `portHint` 先直连验证（docs/03 §6 的"缓存"层落地）；
- `TcpStream::connect_timeout(300ms)` 替代无限 `connect`——防安全软件过滤 loopback 时单端口拖到 OS 级 ~20s。

**教训**：凡耗时 command 一律 async，别赌"这个路径应该很快"；开发期覆盖不到的分支（无环境变量的冷启动）恰恰是用户的第一触点。

### 13. WebView2 profile 目录被僵尸进程锁死 → webview 初始化永远悬挂

**症状**：exe 进程活着、窗口响应，但页面永远不加载（宠物不可见、无任何 TCP 连接）；`%LOCALAPPDATA%\dev.dsh.pet\EBWebView` 零写入且**删不掉、改不了名**（`AutoLaunchProtocolsComponent\manifest.json` Access denied）。

**原因**：某次 webview 初始化中途进程树被硬杀（终端关闭/作业对象级联），profile 目录留下锁；后续每次启动都等待这个死锁的浏览器进程，永远不完成。持有者进程杀不死（宿主应用秒级重长）。

**处置**：重启系统清掉锁持有者 → 删 `%LOCALAPPDATA%\dev.dsh.pet` → 下次启动重建干净 profile。**诊断要点**：Tauri 窗口"存在且响应"≠ 页面加载了——判据是 exe 自身有无 TCP 连接（invoke 发现端口会从 Rust 侧连接）。

**教训**：debug 宠物别靠关终端硬杀（webview 树成孤儿）；怀疑 profile 损坏时先删目录再试，比查代码快。

### 14. 沙箱里验证不了 WebView2 应用

DSH 沙箱的受限命令禁止命名管道 + 作业对象级联杀子进程，而 WebView2 宿主↔浏览器 IPC 恰好依赖管道——在沙箱 pwsh 里 `Start-Process` 宠物，webview 行为不可复现（同一命令每次结果都不同）。**桌面 GUI 的验收只能在真实桌面做**（用户双击），沙箱里最多验证进程/窗口/连接这类 OS 层指标。

### 15. 端口发现三连坑：过滤驱动 2s 延迟 → netstat 候选法（2026-08-25）

**背景**：重启电脑后 release exe 双击，宠物永远停在"找 DSH 中…"（该文本恰好也是 HTML 静态初始值——JS 死掉和正在找它长得一模一样，先改 UI 让错误可见再排查）。

**坑 1 — 本机过滤驱动拖慢关闭端口连接**：实测对未监听的 loopback 端口发起连接要 **~2 秒**才失败（正常 Windows 瞬间 RST）。全段 16384 端口 ÷ 8 线程 × 300ms 超时 ≈ **每轮扫描最坏 10 分钟**——"扫描很快"的假设在这台机器上不成立。

**坑 2 — 全段扫描是错误算法**：端口发现的本质是"找到 DSH 的 webServer 端口"，而它必然处于 LISTENING 状态、登记在内核 TCP 表里。`netstat -ano -p tcp` 直接读表（零网络流量），把候选从 16384 缩到 **~11 个**，并行探测 **781ms 命中**。教训：**先查登记簿，再挨家敲门；扫描只配当兜底**。

**修复后的发现顺序**：`DSH_WEB_URL` 环境变量（2ms）→ netstat LISTENING 候选（亚秒）→ 全段扫描（仅兜底）。

**坑 3 — 无控制台应用的观测通道要提前建好**：GUI 子系统进程没有 stdout，`eprintln` 全部石沉大海。加了三件套：
- `dsh-pet.exe --discover` CLI 诊断模式（只跑发现逻辑、写日志、退出，不起窗口）；
- 双位置日志：exe 旁 `pet-discover.log` 优先，`%LOCALAPPDATA%\dev.dsh.pet\discover.log` 兜底；
- UI 标签直接显示 invoke 失败的错误文本（原来 catch 静默吞掉，排障时两眼一抹黑）。

**教训**：`--discover` 一次运行同时证伪了"安全软件拦 exe 网络"假设（同一进程 probe 2ms 命中）——**没有观测通道时的归因都是猜**；给常驻 GUI 工具预留 CLI 诊断模式 + 落盘日志，是排障的第一基础设施。

### 16. 新会话标题卡在 "—"：插件只读一次，标题异步生成错过（2026-08-25）

**症状**：用户新建一个会话、发第一条消息后，宠物悬停详情里的会话标题永远不更新（卡在 "—" 或残留旧会话名），直到主动切到别的会话再切回来才可能正确。

**根因链**（DSH 运行时源码事实）：
1. 标题来源不止用户改名——还有 `dsh-session-title-first-prompt-llm` 这类 LLM provider 自动根据首条消息生成；
2. 生成走异步流程，最终通过 **session 作用域**的 `'session/title'` 事件写入 `session.events` 流——这不是 cordis host 层事件，`ctx.on('session/title', ...)` 订阅不到；
3. `sessionTitle` 服务只暴露拉取接口（`get/refresh/rename`），没有事件订阅；
4. 插件原实现只在 `agent/status` 触发时调一次 `st.get(agent.session)`——而 `agent/status` 在首条用户消息之前就到了，标题此时还不存在 → 拿到 null → 永远 stale。

**修复**：把标题读改成"按需+轮询"组合：
- `agent/created` 建索引时主动 `refresh()` 一次（fire-and-forget），让 LLM provider 提前走生成路径，不等用户消息；
- `agent/inbox/inserted`（用户消息进收件箱）把对应会话标记为 `titleStale`，1.5s 后开始轮询；
- `flush()` 里增加 `pollTitles()`：到点的会话 `st.get()` 一次，命中非空立即广播，仍空则指数退避（1s→2s→4s…→封顶 30s）；
- `pruneAgents` 保留还在等标题的条目，避免被回收；
- 活引用 `entry.agent` 一直存着——`getTitle` 需要 `agent.session` 才能查 title service。

**教训**：
- **异步生成的状态 ≠ 事件订阅一定能拿到**——看到"看起来应该有事件"先查服务签名是不是有 `onChanged`/`onUpdate`，没有就是拉模型；
- **一次读取对"还没生成"和"不存在"区分不开**——必须做"读到 → 空 → 等 → 再读"的循环，把"还没就绪"显式表达出来；
- 感知层插件这类长期运行组件，状态机里加一个 `stale + nextPoll + interval` 三元组，比加一堆一次性订阅更稳。

## 当前状态（M1 完成时）

- 插件：`pet-1/pkg-2`（v0.6，CORS handshake + 完整事件采集 + WS 首帧 + 10s 心跳）
- 入口：`GET /dsh-pet/handshake`（带 ACAO:*）、`WS /dsh-pet/ws`
- 宠物页：`node dsh-pet/proto/serve.mjs` → `http://127.0.0.1:8765/?port=<DSH端口>`
- 已验证：state 首帧推送、activity 随工具调用切换（cmd/coding/...）、心跳、断线重连、approval pending 字段
- 待验证（小尾巴）：`awaitingApproval` 端到端（需真实批准请求）、多会话 subagents 计数
