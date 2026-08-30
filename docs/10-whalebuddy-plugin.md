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
- **GUI 设置页用 `api.settings.describe()` 枚举已注册 namespace，但「插件配置」tab 只渲染
  同时在 `settings.plugin.item` slot 注册了卡片的 namespace**（交集，见 §7）——
  Host 侧 `settings.register` 只让 namespace 进入 describe()，不产生 UI。
- namespace 命名约束：`/^[a-z][a-z0-9-]*$/`（`settingsNamespace()` 校验）。
- schema 必须是 schemastery（可调用函数，`schema(mergeLayers(base, section))` 解析）；
  字段 `role('secret')` 会被 redact（本项目未用）。

## 3. 感知层改动点（host/dsh-pet-host.cjs → whalebuddy/lib/index.cjs）

- 包名 `whalebuddy`，`inject: ['webServer', 'timer']` 不变（settings 用 `ctx.inject` 可选注入）。
- 新增：settings 注册（四字段：autostart / launchOnDshStart / petPath / skin）+ `cfg` 合并
  + `{type:'config'}` 广播；state 快照与 handshake 内嵌 `config`。
- **DSH 启动自启拉起**（v0.2.1）：`launchOnDshStart=true` 时启动**观察器**（每 5s 检查，最多 2 分钟）：
  已连接即结束；**宠物进程存活但未连接则等它自行重连**（`tasklist /FO CSV /NH` 按 exe 名检测，
  重复拉起会因 WebView2 用户数据目录互锁立即退出——v0.2 的 4s 单次拉起正是踩了这个坑：
  DSH 重启瞬间旧宠物还在重连，spawn 的新实例被旧实例锁死，表现为"自启没生效"）；
  进程不在则拉起一次（15s 防抖）。路径发现 `petPath` 设置 → 注册表 Run 键
  （`reg.exe query` 解析带引号 exe 路径，兜底无引号形态）；手动
  `/dsh-pet/api/launch` force 绕过防抖不绕过在线/存活检查（存活时返回 `process-running`）；
  `WHALEBUDDY_DRY_RUN=1` 只解析不 spawn（测试钩子）。
- 桌面壳前端收到 `config`：`document.documentElement.dataset.skin = skin`（换肤）+ `invoke('set_autostart')`。
- 桌面壳 Rust `set_autostart(enabled)`：`reg.exe add/delete HKCU\...\CurrentVersion\Run\whalebuddy`，
  值 `"<exe路径>" --autostart`；幂等；删不存在的键（reg delete 退出码 1）视为成功。
- 向后兼容：WS 路由仍为 `/dsh-pet/*`；`name` 字段从 `dsh-pet` 改为 `whalebuddy`（仅信息性）；
  config 广播新增字段对旧壳透明（旧壳只读 autostart/skin）。

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
| 设置菜单无 whalebuddy 卡片 | ① 需重启 DSH（client bundle 图在启动时快照，包元数据缓存不刷新）；② 检查部署包里 `client/client.js` 存在且 package.json 有 `dsh.client` 声明与 `exports["./client"]`；③ Host 侧 settings namespace 注册失败看插件日志 |
| 插件日志无 settings | `require('@deepseek-ai/schemastery')` 失败 → 检查 bundle 的 node_modules 解析链 |
| 宠物显示"找 DSH 中…" | 感知层未起：`curl http://127.0.0.1:<port>/dsh-pet/handshake` 看响应是否带 `config` |
| autostart 不生效 | 桌面壳 log（exe 旁 `pet-discover.log`）看 `autostart enabled/disabled` 行 |
| launchOnDshStart 不拉起 | 宠物在线则不拉（设计）；否则看插件日志 `宠物已拉起` / `未找到宠物程序`；确认 petPath 或 Run 键 |
| /dsh-pet/config 404 | 感知层还是旧版（无该端点）：重启 DSH 让 bundle 重载 |

## 7. 设置入口：「插件配置」卡片（v0.2）+ /dsh-pet/config 配置页（备用）

**机制**：DSH 设置页「插件」→「插件配置」tab 列举的是**交集**——`settings.describe()`
服务的 namespace ∩ `settings.plugin.item` slot 里以 `options.key === namespace` 注册的卡片
（`dsh-client-ui-settings-plugins` 的 `ConfigurablePluginsTabController.publish`）。
Host 侧 `settings.register` 只是入场券，卡片要客户端半边自己注册。

**客户端半边（v0.2 起，`whalebuddy/client/client.js`）**：

- 发现链：package.json 声明 `dsh.client: { platform: 'web' }` + `exports['./client']` →
  `dsh-client-modules` 按 loader entry 名（`whalebuddy`）扫描 → boot 图加行
  `/plugins/whalebuddy/client.js?rev=<hash>` → 浏览器执行 → `window.__ModuleLoader__.load`
  注册工厂 → cordis 物化（注入 `slots` + `settingsScope`）→ `slots.register` 进
  `settings.plugin.item`（key=`whalebuddy`）。
- 格式：手写 loader lazy-CJS factory（同 dsh-cron 先例），只 `require('react')`（平台模块）。
- 数据面：读写走官方 `ctx.settingsScope.bind({ namespace: 'whalebuddy' })`（保存 =
  `settings.mutate` 带 revision 围栏；「已覆盖/恢复默认」按 user 层字段存在性判定，
  与官方卡片同语义）；运行状态行与「立即启动」走同源 fetch `/dsh-pet/api/status|launch`。
- 卡片内容：标题「🐋 桌面宠物 whalebuddy」；运行状态行（● 在线/离线 + 刷新 + 立即启动）；
  四个设置字段（两个 checkbox + 两个文本）；放弃/保存按钮；只读部署提示。

**备用入口**（无 GUI / 卡片契约漂移时）：
- 桌面壳右键菜单 →「🐋 whalebuddy 设置…」→ 默认浏览器打开 `http://127.0.0.1:<DSH端口>/dsh-pet/config`
- 或直接浏览器访问该地址（四个字段同步支持）

**端点**（感知层 webServer 上，与 handshake 同端口）：
- `GET /dsh-pet/api/status` → `{ ok, config, pet: { connected, clients } }`（卡片运行状态行）
- `POST /dsh-pet/api/launch` → `{ ok, launched, reason }`（`reason`: `pet-connected`/`exe-not-found`/…）
- `GET /dsh-pet/config` → 极简 HTML 表单（四字段，回显当前值）
- `POST /dsh-pet/config` → 解析 `application/x-www-form-urlencoded` → `scope.update(patch)`
  → 303 回 GET（PRG）；settings 不可用时 500

**保存链路**：`scope.update` / `settings.mutate` → settings-file 写 `~/.dsh/settings.yaml`
→ `scope.watch` 触发 → 感知层广播 `{type:'config'}` → 桌面壳应用（autostart → 写/删 Run 键；
skin → data-skin 换肤）+ `maybeLaunchPet`（launchOnDshStart 打开时启动观察器）。

**验证步骤（重启 DSH 后）**：
1. `curl http://127.0.0.1:<port>/dsh-pet/handshake` → 响应含 `config` 四字段且 `hostVersion: "1.2"`
2. DSH GUI →「设置 → 插件 → 插件配置」→ 出现「🐋 桌面宠物 whalebuddy」卡片，
   状态行显示宠物在线/离线；**保存按钮文字清晰可读**（v0.2.1 起用官方反色 token）
3. 勾选 `launchOnDshStart` → 保存 → 徽标变「已覆盖」；`~/.dsh/settings.yaml` 的
   `whalebuddy:` 段出现该字段；观察器日志见 `宠物进程已在运行，等待重连` 或 `宠物已拉起`
4. 点「立即启动」→ 提示结果（宠物在线 / 进程存活等重连 / 已拉起 / 未找到程序）
5. 浏览器打开 `/dsh-pet/config` → 同样四字段（备用入口一致性）
