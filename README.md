# whalebuddy 🐋 — DeepSeek Harness 桌面宠物

<img width="178" height="210" alt="image" src="https://github.com/user-attachments/assets/eb2b2a36-a84e-413c-bbca-37c4f7d9ff5d" /> <img width="178" height="210" alt="image" src="https://github.com/user-attachments/assets/d46ac100-abd3-43b9-816d-0638b807905a" /> <img width="178" height="210" alt="image" src="https://github.com/user-attachments/assets/fd5850ad-bef0-4419-9f73-8964b6414359" /> <img width="178" height="210" alt="image" src="https://github.com/user-attachments/assets/d38281be-fdea-4c55-b07c-27b6a368d002" />

透明置顶的桌面宠物，实时感知 DeepSeek Harness（DSH）中 agent 会话的运行状态：
任务在跑时它干活，空闲时它睡觉，等待批准时它敲门提醒你——并可在 DSH 设置菜单里配置**开机自启动**与**皮肤**。

```
┌─ DSH 进程 ───────────────────────────────┐   ┌─ 桌面 ──────────────────┐
│ agent 事件流 → whalebuddy（感知层插件）   │   │ Tauri 宠物窗（透明置顶）│
│ (DSH bundle 插件包, 设置菜单注册项)       │   │  Rust 端口发现 + WS 客户端 │
│   折叠成 state + config ── WS 广播 ──────┼──▶│  状态动画 + 皮肤 data-skin│
│   approval waterfall 宠物回答者 ◀─────────┼───│  ✓允许 / ✗拒绝 按钮      │
│   settings: whalebuddy.autostart/skin ───┼──▶│  autostart → Run 键写删 │
└──────────────────────────────────────────┘   └─────────────────────────┘
```

## 仓库结构

| 路径 | 内容 |
|---|---|
| [`whalebuddy/`](whalebuddy/README.md) | **DSH 插件包**（感知层）：npm 包 + `dsh.bundle` 声明，可安装到任意 DSH；注册 `whalebuddy` 设置 namespace（autostart/skin） |
| `app/` | 桌面壳：Tauri v2 透明置顶窗口（`app/src-tauri` Rust 端，`app/ui/index.html` 单文件前端） |
| `host/dsh-pet-host.cjs` | 旧版感知层（`$DSH_HOME/cordis.patch.yml` 直挂方式），已被 `whalebuddy/` 包取代 |
| `docs/` | 设计文档：架构 / 协议 / 主题 / 状态规格 |
| `logo/`、`scripts/` | 鲸鱼素材处理与调试脚本 |

## 部署手册（给 AI agent 的操作指南）

> **本节写给 DSH agent**：用户把本仓库交给你后，按以下步骤完成部署。步骤均为可直接执行的
> PowerShell（Windows）。**所有端口都不要硬编码**——DSH 每次启动随机分配端口，用 §4 的发现方法。

### 前置条件

| 依赖 | 验证 | 说明 |
|---|---|---|
| Windows 10/11 | — | 宠物壳是 Tauri/WebView2，仅 Windows |
| DSH（Desktop 或 CLI）已能运行 | DSH 进程存在或 `dsh` 可调 | 感知层装进 DSH 的 profile |
| Rust 工具链（MSVC） | `cargo --version` | 构建宠物壳；没有则 `winget install Rustlang.Rustup` 后重开终端 |
| Node.js ≥ 18 | `node --version` | 仅验证/调试用，宠物本体不需要 |

### 第 1 步：安装感知层插件（whalebuddy → DSH profile）

```powershell
# 变量：REPO = 本仓库路径；DSH_HOME 默认 %USERPROFILE%\.dsh（设了环境变量则用之）
$REPO    = '<本仓库绝对路径>'                      # 例如 D:\projects\dsh-pet
$DSH     = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$PROFILE = Join-Path $DSH 'profiles\web'            # DSH Desktop 默认 profile；其他 profile 替换名字

# 1a. 复制插件包到 profile 的平铺 node_modules（bundle 解析会找到它）
Copy-Item -Recurse -Force "$REPO\whalebuddy" "$DSH\profiles\node_modules\whalebuddy"

# 1b. 在 profile 的 package.json 里登记 bundle（dsh.profile.bundles 数组追加 "whalebuddy"）
$manifestPath = Join-Path $PROFILE 'package.json'
$m = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($m.dsh.profile.bundles -notcontains 'whalebuddy') {
  $m.dsh.profile.bundles += 'whalebuddy'
  $m | ConvertTo-Json -Depth 10 | Set-Content $manifestPath -Encoding utf8
}

# 1c. 确认 $DSH\cordis.patch.yml 里没有旧的 dsh-pet-perception 直挂行（有则删除该 insert 块）
```

### 第 2 步：重启 DSH

bundle 层只在 DSH **启动时**加载（HMR 只热重载 cordis.patch.yml，不重载 bundle）。请用户重启
DSH Desktop（或重启 `dsh` 服务），等进程稳定后继续。

### 第 3 步：构建并启动宠物壳

```powershell
cd "$REPO\app\src-tauri"
cargo build            # 首次编译 5-15 分钟
Start-Process .\target\debug\dsh-pet.exe
```

> 若要长期使用：把 `target\debug\dsh-pet.exe` 拷到固定目录（如 `D:\tools\whalebuddy\`）再启动，
> 并让用户在配置页开启 autostart（注册表记录的是当时运行的 exe 路径，挪动后需重新开关一次）。

### 第 4 步：验证（全部通过即部署成功）

```powershell
# 4a. 找 DSH 端口（三种方法，按序尝试）：
# ① 环境变量（在带 DSH 环境的 shell 里命中）
$port = ($env:DSH_WEB_URL -split ':')[-1] -as [int]
# ② netstat：DSH Desktop 进程监听的端口，逐个探测 /dsh-pet/handshake（应答含 "whalebuddy"）
$pids = (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue).Id
$cands = netstat -ano -p tcp | Select-String LISTENING | ForEach-Object {
  $c = $_.ToString().Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)
  if ($c.Count -ge 5 -and $pids -contains [int]$c[4]) { [int]($c[1].Split(':')[-1]) } } | Sort-Object -Unique
# ③ 都不行时：宠物 exe --discover 会全段扫描并把结果写进 exe 旁 pet-discover.log
#    （注意：对关闭端口逐个 curl 会因安全软件静默丢包极慢，务必用 netstat 缩小候选）

# 4b. 感知层就绪：handshake 应答 name=whalebuddy 且带 config
Invoke-WebRequest "http://127.0.0.1:$port/dsh-pet/handshake" -UseBasicParsing | Select -Expand Content
# 期望: {"ok":true,"name":"whalebuddy",...,"config":{"autostart":false,"skin":"dsh-black-whale"}}

# 4c. 配置页可用：HTTP 200 且表单含 autostart
(Invoke-WebRequest "http://127.0.0.1:$port/dsh-pet/config" -UseBasicParsing).StatusCode   # 200

# 4d. 宠物窗口已出现并连上：exe 旁 pet-discover.log 出现 "hit port <端口>"；
#     之后用户右键宠物可见菜单（含「🐋 whalebuddy 设置…」），窗口显示 DSH 实时状态
```

### 设置项怎么用（告诉用户）

- **入口**：宠物右键 →「🐋 whalebuddy 设置…」（自动带当前端口打开浏览器），或手动访问
  `http://127.0.0.1:<DSH端口>/dsh-pet/config`
- **autostart**：勾选保存 → 即写 `HKCU\...\CurrentVersion\Run\whalebuddy` → 下次开机宠物自启
- **skin**：皮肤 id（当前默认 `dsh-black-whale`；扩展见 `app/ui/index.html` 皮肤区注释）

### 常见故障

| 症状 | 处理 |
|---|---|
| handshake 404 / 配置页 404 | 感知层没加载：检查第 1 步 bundles 登记 + node_modules 复制，然后**重启 DSH** |
| 宠物一直「找 DSH 中…」 | 端口发现失败：看 pet-discover.log；确认 DSH 在跑、netstat 能看到监听端口 |
| 宠物窗口空白 | WebView2 与别的应用撞 identifier：删除 `%LOCALAPPDATA%\dev.dsh.pet.app` 后重启宠物 |
| autostart 保存后没写注册表 | 宠物须在线（它执行写入）：确认宠物进程活着且已连上；看 pet-discover.log 的 `autostart enabled` 行 |
| cargo build 报 exe 被锁 | 先 `Stop-Process -Name dsh-pet -Force` 再构建 |

## 快速开始（本机开发）

```powershell
# 1. 感知层插件：已作为 bundle 安装到本机 DSH（$DSH_HOME/profiles/web 的
#    dsh.profile.bundles 含 "whalebuddy"，包在 $DSH_HOME/profiles/node_modules/whalebuddy）。
#    DSH 重启后自动加载；改动插件源码后：同步到 $DSH_HOME/profiles/node_modules/whalebuddy 并重启 DSH。

# 2. 桌面宠物：
cd D:\projects\dsh-pet\app\src-tauri
cargo run            # 开发运行（首次编译 5-15 分钟）
```

浏览器预览版（设计验证用）：`node proto/serve.mjs` → `http://127.0.0.1:8765/?port=<DSH端口>`

## 安装到其他 DSH（开源分享）

见 [`whalebuddy/README.md`](whalebuddy/README.md)：包放进 profile 可解析的 node_modules，
在 profile package.json 的 `dsh.profile.bundles` 追加 `"whalebuddy"`，重启 DSH 即可。
（官方 CLI 等价操作：`dsh plugin --profile <name> add whalebuddy`）

## 设置项（whalebuddy 配置页）

| 字段 | 默认 | 说明 |
|---|---|---|
| `autostart` | `false` | 开机自启动宠物（桌面壳写/删 `HKCU\...\Run\whalebuddy`） |
| `skin` | `dsh-black-whale` | 皮肤 id；前端按 `html[data-skin]` 换肤（扩展见 `app/ui/index.html` 皮肤区注释） |

**配置入口**（DSH 设置菜单不渲染无 client UI 包的 namespace，见 docs/10 §7）：
- 桌面壳**右键菜单 →「🐋 whalebuddy 设置…」**（默认浏览器打开）
- 或直接访问 `http://127.0.0.1:<DSH端口>/dsh-pet/config`

持久化在 `~/.dsh/settings.yaml`；改动经感知层 WS 即时广播给桌面壳。

## 已定决策

| 决策点 | 结论 |
|---|---|
| 宠物形态 | 真桌面悬浮宠物（透明置顶独立窗口） |
| 宠物壳技术栈 | Tauri v2（Windows 复用系统 WebView2，动画走 Web 渲染） |
| 感知层 | DSH **bundle 插件包**（`dsh.bundle` manifest），可分发到任意 DSH |
| 设置集成 | 感知层注册 `whalebuddy` settings namespace + 自带 `/dsh-pet/config` 配置页（DSH 设置菜单需配套 client UI 包，未做） |
| 传输层 | WebSocket，复用 DSH 现有 webServer 端口（`registerUpgrade`），不新开端口 |
| 端口发现 | 桌面壳 Rust 侧做：DSH_WEB_URL 环境变量 → 8 线程扫描 49152–65535 |
| 应用标识符 | `dev.dsh.pet.app`（不能用 `dev.dsh.pet`：与宿主 DSH Desktop 撞 identifier，WebView2 用户数据目录互锁） |

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 整体架构：三层划分、组件职责、技术选型、部署形态 |
| [docs/02-signal-sources.md](docs/02-signal-sources.md) | 信号源清单：DSH 事件/服务 → 宠物状态的完整映射 |
| [docs/03-protocol.md](docs/03-protocol.md) | 通信协议：WS 通道、消息信封、state schema、心跳与重连 |
| [docs/04-perception-plugin.md](docs/04-perception-plugin.md) | 感知层插件详细设计：事件采集、状态折叠、WS Hub |
| [docs/05-pet-app.md](docs/05-pet-app.md) | 宠物端详细设计：Tauri 窗口、状态机、动画与性能预算 |
| [docs/06-roadmap.md](docs/06-roadmap.md) | 实施路线：三个里程碑的任务清单与验收标准 |
| [docs/07-m1-lessons.md](docs/07-m1-lessons.md) | M1 实战踩坑实录（llm/stream、btoa、路由泄漏、端口发现） |
| [docs/08-porthole-design.md](docs/08-porthole-design.md) | 舷窗×鲸鱼主题设计：四层渲染架构、状态→深海场景映射、主题包机制 |
| [docs/09-state-visual-spec.md](docs/09-state-visual-spec.md) | 状态与画面规格追踪：场景色/道具/鲸鱼姿态/动画参数 + 调试模式 |
| [docs/10-whalebuddy-plugin.md](docs/10-whalebuddy-plugin.md) | whalebuddy 插件化：bundle 机制、settings 集成、安装/卸载到任意 DSH |

## 相关路径

- DSH 运行时源码（只读参考）：`D:\projects\dsh_desktop\DSH Desktop\resources\dsh-runtime\`
- 本机 DSH profile：`~/.dsh/profiles/web/`（bundle 登记在 `package.json` 的 `dsh.profile.bundles`）
- 设置文档：`~/.dsh/settings.yaml`（whalebuddy 段）
