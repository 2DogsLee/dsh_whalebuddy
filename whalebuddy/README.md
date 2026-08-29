# whalebuddy 🐋

DeepSeek Harness 桌面宠物感知层插件：把 DSH 的 agent 状态折叠成桌面宠物画面（舷窗），
并提供 **开机自启动** 与 **皮肤** 配置（自带轻量配置页）。

- **感知层**（本包）：监听 DSH 事件流 → 折叠 state → 经 `/dsh-pet/ws` 广播给桌面壳；注册 `whalebuddy` settings namespace。
- **桌面壳**（独立程序，本仓库 `app/`）：Tauri 透明置顶窗口，渲染黑鲸 + 状态动画，把 `autostart` 落到系统 Run 键。

## 初次使用（给 AI agent / 人类）

完整部署（含桌面壳构建与验证）见**仓库根 README 的「部署手册（给 AI agent 的操作指南）」**。
仅装本插件包的要点：

1. **定位 DSH_HOME**：默认 `%USERPROFILE%\.dsh`（Windows）/ `~/.dsh`；设了 `DSH_HOME` 环境变量则用之。
2. **复制包**：`whalebuddy/` → `$DSH_HOME/profiles/node_modules/whalebuddy`
3. **登记 bundle**：`$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 数组追加 `"whalebuddy"`（用的不是 web profile 就替换名字）
4. **重启 DSH**：bundle 只在启动时加载（HMR 不重载 bundle 层）
5. **验证**：找 DSH 端口（见下），`GET /dsh-pet/handshake` 应答 `name:"whalebuddy"` 且带 `config`
6. **桌面壳**：到仓库 `app/src-tauri` 下 `cargo build` 并运行（仅 Windows，需 Rust/MSVC；详见根 README）

### DSH 端口怎么找（每次启动随机变，勿硬编码）

DSH 的 web 端口每次启动从临时端口段（49152–65535）随机分配，人与 agent 都不应写死：

```powershell
# ① 环境变量（在带 DSH 环境的 shell 里）
($env:DSH_WEB_URL -split ':')[-1]
# ② netstat：DSH Desktop 进程监听端口 → 逐个 GET /dsh-pet/handshake 探测（应答含 whalebuddy）
$pids = (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue).Id
netstat -ano -p tcp | Select-String LISTENING | ForEach-Object {
  $c = $_.ToString().Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)
  if ($c.Count -ge 5 -and $pids -contains [int]$c[4]) { [int]($c[1].Split(':')[-1]) } } | Sort-Object -Unique
```

- **宠物壳自动发现端口**（环境变量 → netstat 候选 → 全段扫描），无需任何配置；
  配置页入口用宠物右键菜单「🐋 whalebuddy 设置…」会自动带当前端口打开浏览器。
- 注意：对关闭端口逐个 curl 会因安全软件静默丢包极慢（单端口可达 ~2s），务必先 netstat 缩小候选。

## 安装到任意 DSH

本包是一个标准 **DSH bundle 插件**（`package.json` 声明 `dsh.bundle.patch`），
安装 = 放进 profile 可解析的 node_modules + 在 profile 的 `dsh.profile.bundles` 里登记。

以 DSH Desktop / CLI 的默认 profile（`~/.dsh/profiles/web`）为例：

```bash
# 1) 安装包（发布后：pnpm/npm install；本地开发：复制目录）
#    对 profile 用 pnpm 安装到其 node_modules 根（$DSH_HOME/profiles/node_modules 亦可，bundle 解析会走到）
cp -r whalebuddy ~/.dsh/profiles/node_modules/whalebuddy

# 2) 在 profile 清单登记 bundle
#    ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 数组末尾追加 "whalebuddy"
```

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "whalebuddy"            // ← 追加
      ]
    }
  }
}
```

3) 重启 DSH（或重载 profile）。插件加载后：
   - DSH 事件感知 + WS 广播照常；
   - **设置入口**：桌面壳右键菜单「🐋 whalebuddy 设置…」或直接浏览器访问
     `http://127.0.0.1:<DSH端口>/dsh-pet/config`——极简 HTML 配置页（autostart 开关 + skin 输入），
     保存即写 `~/.dsh/settings.yaml` 并即时广播给桌面壳（autostart → 写/删
     `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\whalebuddy`；skin → 桌面壳换肤）。
   - 说明：whalebuddy 配置**不在 DSH 设置菜单里**——DSH 设置页的"插件" tab 只渲染有
     client UI 包（React）的 namespace；本项目走轻量自带配置页方案（见 docs/10 §7）。

> 卸载：从 `dsh.profile.bundles` 移除并删除包目录即可；设置项残留在 `~/.dsh/settings.yaml`（无害，可手动删 `whalebuddy:` 段）。

## 设置项（settings namespace `whalebuddy`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `autostart` | boolean | `false` | 开机自启动桌面宠物（桌面壳写/删 Windows Run 键） |
| `skin` | string | `dsh-black-whale` | 皮肤 id。桌面壳按 `data-skin` 属性换肤，新增皮肤见桌面壳文档 |

schema（schemastery）：

```js
z.object({
  autostart: z.boolean().default(false),
  skin: z.string().default('dsh-black-whale'),
})
```

设置持久化在 `~/.dsh/settings.yaml`（DSH 的 settings-file provider，原子写入 + 热重载）。

## 协议（桌面壳 ↔ 感知层）

- `GET /dsh-pet/handshake` → `{ ok, name, protocolVersion, hostVersion, wsPath, config }`
- `GET /dsh-pet/config` → HTML 配置页（autostart checkbox + skin 输入，回显当前值）
- `POST /dsh-pet/config` → 表单提交 → `scope.update` → 303 回 GET（PRG）
- `WS /dsh-pet/ws`：服务端推 `state`（含 `config`）、`config`（设置变更即时推）、`approval/asked`、`approval/settled`、`ping`；客户端发 `approval/respond`。

## 开发

- 感知层源码：`lib/index.cjs`（纯 Node，零依赖；RFC6455 手写服务端）。
- 桌面壳：见仓库根 README（`app/`，Tauri v2）。
- 旧版 `host/dsh-pet-host.cjs` 是改造成本包前的 `$DSH_HOME/cordis.patch.yml` 直挂版，已由本包取代。

## License

MIT
