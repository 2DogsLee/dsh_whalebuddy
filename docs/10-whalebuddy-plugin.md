# docs/10 — whalebuddy 插件化：DSH bundle 机制、settings 集成、安装/卸载

> 记录 whalebuddy 从"`$DSH_HOME/cordis.patch.yml` 直挂"升级为"标准 DSH bundle 插件包"的
> 全部机制结论。这些结论来自对 `@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-settings`、
> `@deepseek-ai/dsh-settings-file`、`@deepseek-ai/dsh`（profile-boot）及社区包
> `dsh-desktop-safe-market` 的源码研读（DSH Desktop 自带 runtime）。

## 1. DSH 插件 = "dsh.bundle" 包

DSH 的组合是 **patch layer stack**，层序（profile-boot `composeProfile`）：

```
bundle 层（profile package.json 的 dsh.profile.bundles 顺序，每包一个 patch 文件）
  → profile 自己的 cordis.patch.yml（~/.dsh/profiles/<name>/）
  → 宿主 home 层（$DSH_HOME/cordis.patch.yml，所有 profile 共用）
  → --patch 命令行 overlay
  → telemetry 开关
```

- 每个 bundle 包在**自己的 package.json** 里声明：
  ```json
  { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
  ```
- bundle 的 patch 文件与 cordis.patch.yml 同构（`- insert: [{id, name, config}]`）。
- 解析顺序（`resolveBundleDir`）：先 dsh 安装锚点（runtime 的 `@deepseek-ai/dsh`），
  再 profile 目录——所以包装进 `$DSH_HOME/profiles/node_modules`（平铺 symlink fallback）
  或 profile 自己的 node_modules 都能被解析。
- `healProfilesModuleFallback` 会把 dsh 依赖闭包 symlink 到 `$DSH_HOME/profiles/node_modules`，
  插件包在那里 require 任意 `@deepseek-ai/*` 都能解析到 runtime 里的真身。

**结论**：whalebuddy 包（`whalebuddy/` 目录）声明 `dsh.bundle.patch`，装进
`$DSH_HOME/profiles/node_modules/whalebuddy` + profile `dsh.profile.bundles` 加 `"whalebuddy"`
即可被 DSH 自动加载。社区范式：`dsh-desktop-safe-market`（同样声明 `dsh.bundle.patch`）。

## 2. settings 集成（DSH 设置菜单自动渲染）

- 服务：`ctx.settings`（`@deepseek-ai/dsh-settings`，dsh-base bundle 里 id=`settings`，
  实现 `@deepseek-ai/dsh-settings-file`，文档 `~/.dsh/settings.yaml`，原子写 + 热重载）。
- 注册（宿主平面插件内）：
  ```js
  const z = require('@deepseek-ai/schemastery')   // DSH 内置，有 CJS 出口
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('whalebuddy', z.object({
      autostart: z.boolean().default(false),
      skin: z.string().default('dsh-black-whale'),
    }), { base: { autostart: false, skin: 'dsh-black-whale' } })
    scope.get()            // 解析值：schema 默认 ← base ← 用户层
    scope.watch(cb)        // 变更回调（含外部编辑 settings.yaml）
    scope.update(patch)    // 写用户层（设置菜单的保存路径）
    scope.replace(section) // 整体替换（重置）
  })
  ```
- **GUI 设置页用 `api.settings.describe()` 枚举所有已注册 namespace 并自动渲染表单**——
  任何插件注册 namespace 即自动出现在设置菜单，无需写 UI 包。
- namespace 命名约束：`/^[a-z][a-z0-9-]*$/`（`settingsNamespace()` 校验）。
- schema 必须是 schemastery（可调用函数，`schema(mergeLayers(base, section))` 解析）；
  字段 `role('secret')` 会被 redact（本项目未用）。

## 3. 感知层改动点（host/dsh-pet-host.cjs → whalebuddy/lib/index.cjs）

- 包名 `whalebuddy`，`inject: ['webServer', 'timer']` 不变（settings 用 `ctx.inject` 可选注入）。
- 新增：settings 注册 + `cfg` 合并 + `{type:'config'}` 广播；state 快照与 handshake 内嵌 `config`。
- 桌面壳前端收到 `config`：`document.documentElement.dataset.skin = skin`（换肤）+ `invoke('set_autostart')`。
- 桌面壳 Rust `set_autostart(enabled)`：`reg.exe add/delete HKCU\...\CurrentVersion\Run\whalebuddy`，
  值 `"<exe路径>" --autostart`；幂等；删不存在的键（reg delete 退出码 1）视为成功。
- 向后兼容：WS 路由仍为 `/dsh-pet/*`；`name` 字段从 `dsh-pet` 改为 `whalebuddy`（仅信息性）。

## 4. 安装 / 卸载（任意 DSH）

```bash
# 安装
cp -r whalebuddy ~/.dsh/profiles/node_modules/whalebuddy
# ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 追加 "whalebuddy"
# 重启 DSH（bundle 层在启动时快照，HMR 只热重载 cordis.patch.yml，不热重载 bundle 层）
# 官方 CLI 等价：dsh plugin --profile web add whalebuddy（转发 pnpm）

# 卸载
# dsh.profile.bundles 移除 "whalebuddy" + 删包目录；残留的 settings.yaml whalebuddy 段无害可手动删
```

## 5. 皮肤扩展（预留）

- 设置项 `skin`（string）→ 桌面壳 `html[data-skin]` 属性 → CSS 按 `html[data-skin='<id>']`
  覆盖 `--dsh-whale` 等变量（`app/ui/index.html` 皮肤区有扩展示例）。
- 主题包机制草案见 docs/08 §4（manifest 声明鲸鱼 PNG、场景色、动画参数）。

## 6. 排障

| 症状 | 原因/处理 |
|---|---|
| 设置菜单无 whalebuddy | 见 §7：whalebuddy 不走设置菜单，走 /dsh-pet/config 配置页 |
| 插件日志无 settings | `require('@deepseek-ai/schemastery')` 失败 → 检查 bundle 的 node_modules 解析链 |
| 宠物显示"找 DSH 中…" | 感知层未起：`curl http://127.0.0.1:<port>/dsh-pet/handshake` 看响应是否带 `config` |
| autostart 不生效 | 桌面壳 log（exe 旁 `pet-discover.log`）看 `autostart enabled/disabled` 行 |
| /dsh-pet/config 404 | 感知层还是旧版（无该端点）：重启 DSH 让 bundle 重载 |

## 7. 设置入口：/dsh-pet/config 配置页（轻量集成）

**为什么不做 DSH 设置菜单卡片**：DSH 设置页的"插件" tab 只列举 `settings.plugin.item`
slot 里注册了卡片的 namespace（`dsh-client-ui-settings-plugins` line 969：
`this.entries().flatMap((entry) => entry.options.key !== void 0 && served.has(entry.options.key) ...)`）——
即**每个可配置 namespace 要配一个 client UI 包（React + esbuild）**，主机侧 `settings.register`
只是让 namespace 存在于 describe() 里，不产生 UI。社区范式：`agent-presets` 配
`dsh-client-ui-agent-preset`。本项目选择轻量方案：感知层自带极简 HTML 配置页。

**入口**：
- 桌面壳右键菜单 →「🐋 whalebuddy 设置…」→ 默认浏览器打开 `http://127.0.0.1:<DSH端口>/dsh-pet/config`（需已连上 DSH）
- 或直接浏览器访问 `http://127.0.0.1:<DSH端口>/dsh-pet/config`（`<DSH端口>` 见 DSH Web GUI 地址）

**端点**（感知层 webServer 上，与 handshake 同端口）：
- `GET /dsh-pet/config` → 极简 HTML 表单（autostart checkbox + skin 输入框 + 保存），回显当前值
- `POST /dsh-pet/config` → 解析 `application/x-www-form-urlencoded` → `scope.update(patch)`
  → 303 回 GET（PRG）；settings 不可用时 500

**保存链路**：`scope.update` → settings-file 写 `~/.dsh/settings.yaml` → `scope.watch` 触发
→ 感知层广播 `{type:'config'}` → 桌面壳应用（autostart → 写/删 Run 键；skin → data-skin 换肤）。

**验证步骤（重启 DSH 后）**：
1. `curl http://127.0.0.1:<port>/dsh-pet/handshake` → 响应含 `config`（新感知层）
2. 浏览器打开 `/dsh-pet/config` → 看到表单且 autostart 反映当前值
3. 勾选 autostart → 保存 → 回显 checked；`~/.dsh/settings.yaml` 出现 `whalebuddy:` 段；
   桌面壳 `pet-discover.log` 出现 `autostart enabled`
4. 桌面壳右键「whalebuddy 设置…」→ 浏览器弹出配置页
