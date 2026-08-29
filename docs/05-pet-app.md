# 05 · 宠物端详细设计（Tauri）

> 注：本文 §3 的状态机与连接管理仍是现行设计；表现层的**视觉方案**
> （emoji → 舷窗×鲸鱼四层场景）已由 [08-porthole-design.md](08-porthole-design.md) 取代。

## 1. 进程与窗口

| 项 | 值 | 说明 |
|---|---|---|
| 壳 | Tauri 2.x | Windows 复用系统 WebView2，无捆绑 Chromium |
| 窗口 | transparent + alwaysOnTop + decorations=false | 透明置顶无边框 |
| 任务栏 | skipTaskbar + 单实例锁 | 不占任务栏，双击不重复开 |
| 点击 | 宠物本体可点、本体之外点击穿透 | WebView 内 hit-test：本体区域 `pointer-events:auto`，其余 `none` |
| 拖拽 | 按住宠物拖动 | Tauri `startDragging`，位置持久化 |
| 置顶层级 | always-on-top（如需"更高"再调 Win32 扩展样式） | 默认够用 |

## 2. 前端结构

```
src/
 ├── main.ts            入口：连接管理 + 状态机 + 渲染循环
 ├── connection.ts      端口发现 / WS / 心跳 / 退避重连（03 文档 §5–6）
 ├── statemachine.ts    协议 state → 宠物状态（含优先级仲裁）
 ├── renderer/
 │    ├── lottie.ts     Lottie 播放（lottie-web）
 │    └── sprite.ts     帧动画后备方案（零依赖 CSS background 定位）
 └── assets/
      ├── pet/*.json    Lottie 动画文件
      └── config.json   动画 ↔ 状态映射表
```

- 前端只懂协议，不含任何 DSH 内部概念；
- 动画方案主选 **Lottie**（矢量、体积小、AE 工作流），像素风可换 sprite sheet，
  两者经 `renderer` 接口互换，`config.json` 决定用哪套。

## 3. 宠物状态机

```
                 ┌──────── WS 断开/握手失败 ────────┐
                 ▼                                  │
             offline ──重连成功──▶ sleeping ◀── agent idle
                 │                  │               │
                 │            status=running   status=running
                 │                  ▼               ▼
                 │              thinking ──activity──▶ coding/cmd/search/spawning
                 │                  ▲               │
                 │                  └── llm/stream ─┘
                 │
     awaitingApproval=true ▶ needYou（敲门，最高优先级）
     pulse=panic           ▶ panic（8s 自动回落）
     pulse=celebrating     ▶ celebrating（8s 自动回落）
```

- 状态由宠物端从协议 state 自行推导（感知层不做仲裁，保持薄）；
- 优先级：`needYou > panic > working* > celebrating > sleeping > offline`；
- `needYou` 需要用户可感知的提醒：动画 + 可选的 任务栏闪烁/气泡
  （第一版只做动画加提示气泡，避免打扰）。

### 动画清单（第一版最小集）

| 状态 | 动画 | 循环 |
|---|---|---|
| offline | 睡觉（zzz）或散步 | loop |
| sleeping | 打盹 | loop |
| thinking | 托腮 + 思考泡泡（intensity 0–3 控制泡泡密度） | loop |
| coding / cmd | 敲键盘 | loop |
| search | 翻书/放大镜 | loop |
| spawning | 吹哨 + 小图标出现 | once + loop 收尾 |
| needYou | 跳起来敲门 + 气泡显示 summary | loop，直到 pending=false |
| panic | 慌张抖动 | once，回落 |
| celebrating | 跳舞/转圈 | once，回落 |

过渡动画（可选二期）：状态切换时 200ms 淡入淡出，避免跳变。

## 4. 性能预算

| 指标 | 目标 | 手段 |
|---|---|---|
| 常驻内存 | < 100 MB（含 WebView2 渲染进程） | 无框架或极小运行时；动画 JSON 均 < 200KB |
| CPU（sleeping/offline） | ≈ 0% | 降帧至 4–6fps，或纯 CSS animation 暂停 JS 循环 |
| CPU（working） | < 2% | 30fps 上限；Lottie 不开 path 缓存之外的花活 |
| 状态延迟 | 感知 → 动画切换 < 1s | 协议本身 500ms 节流 + WS 即推 |

降帧实现：requestAnimationFrame 里按目标 fps 丢帧；sleeping 态进一步把
`animation-play-state` 与 rAF 循环都停掉，只留 WS 心跳。

## 5. 连接管理要点

- 端口发现顺序、退避重连、心跳超时严格按 03 文档 §4–6；
- offline 是**正常状态**：不弹窗、不 toast，只有宠物换动画；
- 配置文件 `dsh-pet.json`（宠物目录）：

```json
{ "port": 60498, "fps": { "active": 30, "idle": 5 },
  "alerts": { "needYou": { "bubble": true, "taskbarFlash": false } } }
```

## 6. 打包与自启动

- `tauri build` 出单 exe + WebView2 依赖引导（Win10/11 一般已具备）；
- 自启动：`tauri-plugin-autostart`，默认**关**，用户在宠物右键菜单开；
- 更新：宠物端无自动更新需求（本地小工具），版本号随 release 走。

## 7. 交互扩展预留（M3+）

- 宠物本体已可点击（hit-test）：第一版点击 = 播放一个彩蛋动画；
- 右键菜单：退出 / 置顶开关 / 自启动开关 / "关于与协议版本"；
- M3 双向：点击 needYou 气泡上的按钮 → 发 `command` 消息（03 文档 §7），
  前端结构不变，`connection.ts` 加 `sendCommand(action, payload)` 即可。
