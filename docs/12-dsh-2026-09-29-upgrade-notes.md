# DSH Desktop 2026-09-29 升级：插件设置集成断裂复盘

> 本次 whalebuddy 设置菜单入口在 Desktop 升级后消失的完整排查记录。
> 面向：给 DSH 写插件（尤其是带设置 UI 的 bundle 插件）的作者。

## 一句话结论

新版 DSH 把「插件的设置 UI」从 **"插件自注册 namespace + 自由插槽卡片"**
改成了 **"插件 Config schema 即命名空间 + configForms 通道 + 官方伴生包模式"**。
旧代码不是报错挂掉，而是**静默失效**——这是本次排查拖长的根本原因。

## 断点清单（按依赖顺序）

### 1. 宿主半侧：`settings.register(ns, schema)` 移除

- 旧：`ctx.inject(['settings'], (s) => s.settings.register('ns', z.object({...})))`
- 新：插件的设置命名空间 = **插件导出的 `Config` schema**（cordis 惯例，
  `runtime.Config`）。settings 服务从 loader entry 的 `fiber.runtime.Config`
  生成表单并在 describe 镜像里以 `entry.options.id` 为 ns 服务。
- **没有任何迁移报错**：旧 API 调用抛 TypeError 被插件 try/catch 吞掉，
  表现为"一切正常但设置不见了"。

### 2. Config 字段必须 `.volatile()`

这是**最隐蔽**的一条，官方文档基本没讲清楚：

- `dsh-settings` 的 `volatileForm()` 只把带 `meta.volatile` 的字段投影进
  设置表单；**不带 `.volatile()` 的普通字段被逐个丢弃**，丢弃完 dict 为空
  → `volatileForm` 返回 undefined → **整个命名空间不出现在 describe 里**。
- 症状极具迷惑性：entry 一切正常（active、Config 被识别、通过 entries()
  过滤），describe 就是没你。我们为此做了 loader 全量 entry 诊断才定位。
- 正确写法（对照 `dsh-agent-loop` 源码 line 1534）：
  ```js
  Config: z.object({
    autostart: z.boolean().default(false).volatile(),
    ...
  })
  ```
- 语义注解：volatile = "改这个字段不用重挂载插件"。settings 写入路径
  （`settings/write`）对非 volatile 字段会直接拒绝。

### 3. 客户端半侧：`settingsScope` 服务整体移除

- 旧：`ctx.settingsScope.bind({ namespace })` 读写插件设置。
- 新：`ctx.configForms.get(ns)`：
  - 快照 `{ status:"ready"|"unavailable", value, base, user, revision, writable }`
  - 写入 `form.set(field, value)` / `form.unset(field)`，**返回 Promise<boolean>**
    （Host 是否接受），不再需要自己回读 user 层比对。
- `settingsScope` 在 runtime 里已零残留；`bind()` 抛 TypeError。若卡片注册
  和 bind 在同一个 try 块（我们的写法），整个注册被跳过。

### 4. 设置 UI 落点：插槽体系重组

- 旧：`settings.plugin.item` 插槽 + `key` 配对。
- 新：
  - **`plugins.item`**：插件管理面板的官方插件卡片（web-search / subagent /
    shell / agent-loop 伴生包都注册这里）；
  - **`settings.plugins.tab`**：设置 →「内置插件」分页（list 插槽，options
    需 `{ name, id, order, label }`，按 id 派发 `renderSlot({ only: id })`）；
  - 旧的 `settings.plugin.item`/「插件配置」分区不存在了；桌面端设置侧边栏
    只有：通用设置 / 桌面设置 / 模型 / 内置插件 / Agent 预设。
- 第三方插件页面注册的**官方姿势**（照抄 agent-loop 伴生包）：
  ```js
  inject: ["slots", "locale", "configForms"]
  apply(ctx) {
    const form = ctx.configForms.get(NS);
    ctx.effect(() => ctx.configForms.whileServed([NS], () =>
      ctx.slots.inject("plugins.item", () => ctx.slots.register({
        name: "plugins.item", id: "whalebuddy", order: 50, label: "…",
      }, Card))));
  }
  ```
  `whileServed` = 宿主服务该命名空间时挂载、停服时自动撤下。

### 5. `dsh.client.inject` 声明不是可选的"建议"

最浪费时间的断点：

- 客户端模块（`dsh.client` 声明的包）会被送进浏览器，但模块加载组合按
  **声明依赖**编排。不声明 `inject`，你的 bundle 可能先于依赖模块加载，
  apply 时 `ctx.configForms` 未就位 → **apply 根本不执行，且零报错**。
- 修复：package.json
  ```json
  "dsh": { "client": { "platform": "web",
           "inject": ["@deepseek-ai/dsh-client-ui-settings"] } }
  ```
- 官方伴生包全都声明了（agent-loop 还声明了 locale 和 plugin-manager），
  但没有任何文档说第三方 bundle 也必须这么做。

### 6. profile patch 里的重复定义行会把你从配置行里踢出去

- `configEditor.entries()` 有去重：同 id 的 entry 若出现多次，**全部剔除**
  （`counts.get(id) === 1` 过滤）。
- 老版 `settings.register` 的 `scope.update` 往 profile `cordis.patch.yml`
  写了带 `name:` 的完整定义行；bundle 自己又 insert 了一次 → 重复 → 被剔。
- 修复：profile patch 里只保留**纯 config 覆盖行**（`- id: whalebuddy /
  config: {...}`，不带 `name:`）。

## 排查方法论（本次真正值钱的部分）

1. **不要信退出码/表面正常，要找副作用证据**。感知层 handshake 一直 200，
   误判过"插件加载正常"。
2. **免费/免鉴权口是金矿**：`/dsh-pet/handshake` 这类插件自带路由可以在
   JSON 里塞任意诊断字段（我们塞了 served ns 列表、loader entry 清单、
   客户端信标时间戳），比求用户开 DevTools 靠谱得多。
3. **客户端是否真的在跑，用服务端证据判定**：`lastFocusPostAt` 信标
   （apply 一执行就 POST）区分了"模块没加载/加载了没执行/执行了没注册"三段。
4. **对照官方同构物**：`dsh-client-ui-settings-agent-loop` 等伴生包就是
   官方给出的"第三方插件设置页"参考实现，逐行抄它的 inject/apply/register。
5. **读构建产物**（dsh-runtime node_modules 的 lib/*.js）是唯一权威文档，
   README 严重滞后。
6. 必要时可以直接铸会话 cookie（密钥在 `~/.dsh/.credentials.yaml` 的
   browser-session 记录，HMAC-SHA256 v1 cookie）抓取登录后才能看的
   index/模块组合——只读诊断用。

## 给插件作者的升级清单（2026-09-29 Desktop）

- [ ] 宿主：删 `settings.register`，导出 `Config`，字段全部 `.volatile()`
- [ ] 宿主：设置值改从 `apply(ctx, config)` 读；变更感知靠 fiber 重入
- [ ] 客户端：`settingsScope` → `configForms.get(ns)`；`set/unset` 返回值即落盘结果
- [ ] 客户端：卡片经 `configForms.whileServed([ns])` 注册进 `plugins.item`
      和/或 `settings.plugins.tab`
- [ ] package.json：`dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-settings`
- [ ] profile patch：清理带 `name:` 的重复定义行，只留 config 覆盖
- [ ] 重启 DSH Desktop（宿主/manifest 改动不热载）；web 页面刷新即可拿新 client bundle
