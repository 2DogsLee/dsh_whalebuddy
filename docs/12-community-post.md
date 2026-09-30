# 【插件作者必读】2026-09-29 Desktop 升级：带设置 UI 的插件会静默失效 —— 迁移指南

> 来源：whalebuddy（桌面宠物插件）在本次升级后设置入口消失的完整排查。
> 受影响对象：所有使用旧版设置集成的 bundle 插件（`settings.register` +
> `settingsScope` / `settings.plugin.item` 写法）。
> 症状统一且恶劣：**插件功能一切正常、零报错，只有设置入口消失。**

## 变化总览（4 个断点 + 1 个组合拳）

| # | 旧行为 | 新契约 | 失效方式 |
|---|---|---|---|
| 1 | `ctx.inject(['settings'], s => s.settings.register(ns, schema))` | 插件导出 **`Config` schema** 即命名空间 | TypeError 被吞，命名空间不再被服务 |
| 2 | Config 字段普通声明即可 | 字段必须 **`.volatile()`**，否则被 `volatileForm` 逐个丢弃，丢空后**整个命名空间消失** | 最隐蔽：entry 一切正常，describe 里就是没你 |
| 3 | 客户端 `ctx.settingsScope.bind({ namespace })` 读写 | `ctx.configForms.get(ns)`（`set/unset` 返回是否落盘） | 服务零残留，`bind()` 抛 TypeError |
| 4 | 卡片注册进 `settings.plugin.item` | **`plugins.item`**（插件管理面板）与 **`settings.plugins.tab`**（设置→内置插件分页）经 `configForms.whileServed([ns])` 注册 | 旧插槽已不存在 |
| 5 | `dsh.client.inject` 可不声明 | **必须声明依赖的客户端模块**，否则加载顺序无保证，`ctx.configForms` 未就位 → **apply 根本不执行**（零报错） | 最难定位 |
| 6 | （组合拳）老版写配置会在 profile patch 留下带 `name:` 的定义行 | 与 bundle 的 insert 重复 → `entries()` 去重把同 id entry **全部剔除** | 命名空间时有时无 |

## 迁移清单（照抄即可）

### 宿主半侧

```js
// 旧：settings.register('my-ns', z.object({...}))
// 新：导出 Config，字段全部 .volatile()
module.exports.Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  path: z.string().default('').volatile(),
})
module.exports = {
  name: 'my-plugin',
  inject: ['webServer'],
  Config: module.exports.Config,
  apply(ctx, config) { /* 设置值直接从 config 读；变更靠 fiber 重入 */ },
}
```

要点：
- 设置值从 `apply(ctx, config)` 第二参读；用户改配置时 cordis 会以新 config
  重入 apply（volatile 字段不重挂载，其余字段变更会重启 fiber）。
- 程序化写回用 `sctx.settings.update(ns, patch)`。

### 客户端半侧

```js
exports.inject = ["slots", "configForms"];
exports.apply = function (ctx) {
  const form = ctx.configForms.get("my-ns");
  // 快照: { status: "ready", value, base, user, revision, writable }
  // 写入: await form.set(field, value) → boolean（Host 是否接受）
  ctx.effect(() => ctx.configForms.whileServed(["my-ns"], () =>
    ctx.slots.inject("plugins.item", () => ctx.slots.register({
      name: "plugins.item", id: "my-plugin", order: 50, label: "…",
    }, Card))));
};
```

要点：
- `whileServed` = 宿主服务该命名空间时挂载、停服自动撤下（官方
  agent-loop / web-search / shell 伴生包都是这个写法，可直接对照源码：
  `@deepseek-ai/dsh-client-ui-settings-agent-loop` 等）。
- 设置侧导航现在只有：通用设置 / 桌面设置 / 模型 / **内置插件** / Agent 预设；
  `settings.plugins.tab` 插槽对应「内置插件」分页。

### package.json（最容易漏的一步）

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-settings"]
  }
}
```

不声明的话客户端模块虽会被送进浏览器，但加载顺序无保证：
apply 执行时 `configForms` 服务未就位 → **apply 根本不执行，且控制台零输出**。

### 收尾

- 检查用户 profile 的 `cordis.patch.yml`：老版本写配置可能留下了带 `name:` 的
  重复定义行，改成纯 config 覆盖行（只有 `id` + `config`）。
- 宿主/manifest 改动**必须重启 DSH**；客户端 bundle 页面刷新即可拿到新的。

## 排查技巧（给要定位的人）

- 插件自带的免鉴权路由（如 handshake）是理想的诊断口：把
  `settings.describe()` 的 ns 列表、loader entry 信息塞进响应直接看。
- 判断客户端模块 apply 是否真的执行：让它 apply 时向宿主发一个信标请求，
  宿主记录时间戳——可以区分「没加载 / 加载了没执行 / 执行了没注册」。
- `configEditor.entries()` 过滤条件（同 id 去重 + 父树根必须是 `include`）
  和 `volatileForm` 只投影 volatile 字段，是两个最反直觉的静默剔除点。

## 给官方的两点建议

1. 移除 `settings.register` 这类 API 时，希望至少打一条 deprecation 日志，
   而不是让旧调用无痕失效。
2. `volatileForm` 丢弃全部非 volatile 字段导致整个命名空间被跳过时，建议在
   describe 响应或日志中提示（例如 "ns X has no volatile fields, skipped"），
   否则插件作者无从下手。

---
完整排查记录（含本机诊断过程）见
[whalebuddy 仓库 docs/12](https://github.com/2DogsLee/dsh_whalebuddy/blob/main/docs/12-dsh-2026-09-29-upgrade-notes.md)。
