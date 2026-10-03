# 13 · 社区跟帖草稿：volatile 引用三连坑（#8438 续篇）

> 发布位置：https://github.com/deepseek-ai/deepseek-harness/discussions/8438（回复）
> 状态：待发布

---

**续篇：迁移后设置契约的第二个坑——`.volatile()` 字段在 `apply()` 里是引用不是值（附排障清单）**

上一篇 (#8438 主帖) 讲了设置入口的迁移。插件按新契约改完（导出 `Config`、字段全部
`.volatile()`、客户端走 `configForms`）之后，还有一个**更隐蔽的坑**会让设置值
"保存成功但插件永远读不到默认值"，零报错。whalebuddy 这两天完整踩了一遍，在此补充。

## 坑 1（最重要）：`apply(ctx, config)` 里 volatile 字段是 Volatile 引用，不是裸值

主帖里"设置值直接从 config 读"这句要修正：**带 `.volatile()` 的字段传进来是
引用对象，须 `.get()` 读快照**（cordis README 一句带过，但没有破坏性变更提示）。

失效写法（不报错，cfg 恒为默认值）：

```js
cfg.petPath = typeof config.petPath === 'string' ? config.petPath : ''   // 引用 ≠ string，永远走默认
cfg.autostart = config.autostart === true                                 // 永远 false
```

修复模式（兼容裸值，旧宿主/测试直传不坏）：

```js
const readV = (v) => (v && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v
function refreshCfg() {
  cfg.petPath = typeof readV(config.petPath) === 'string' ? readV(config.petPath) : ''
  cfg.autostart = readV(config.autostart) === true
}
refreshCfg()
ctx.on('loader/volatile-update', () => refreshCfg())
// volatile-only 变更 cordis 不重入 apply、不重启 fiber，只就地提交引用并发此事件
```

**另外两个反直觉点**：

- volatile-only 的变更**不会重入 apply**（loader 就地提交引用 + `loader/volatile-update`
  事件），主帖"用户改配置时 cordis 会以新 config 重入 apply"只对非 volatile 字段成立。
- **bundle patch 的 `config:` 里写 volatile 字段不生效**（运行时仍是默认值）。
  volatile 字段的持久化唯一可靠入口是 settings 服务（GUI 保存 / `settings.update`），
  落盘在 `profiles/<profile>/cordis.patch.yml` 的对应条目里。

## 坑 2：`~/.dsh/settings.yaml` 已被静默移除

新版启动时把 `~/.dsh/settings.yaml` rename 成 `settings.yaml.imported`，各段迁入
当前 profile（`dsh-settings` 的 `importLegacyDocument()`）。**没有任何用户可见日志**，
文件消失容易让人以为设置丢了；`.imported` 留着即可，是迁移水位标记。

## 坑 3：Desktop 实际跑的是 `web` profile，不是 `profiles/desktop`

`profiles/desktop` 目录存在但不含用户装的 bundle，排查时极易被带偏。
确认方法：看进程参数——`DSH Desktop.exe ... runtime-launcher.mjs web --port 3080`。
（Desktop 的 web 端口固定 3080；这同时影响端口发现逻辑，别只扫临时端口段。）

## 坑 4：bundle 模块代码只在进程启动时加载

改了 `node_modules/<bundle>/lib/*.js` 之后，即使碰 home patch 触发 recomposition
也**不会**重新 require 模块（HMR 只监视 profile/home patch 文件）。调试 bundle
宿主代码必须彻底退出 DSH Desktop（含托盘）重启。

## 排障建议：给自己留一个免鉴权诊断路由

插件自带一个 `GET /xxx/handshake` 之类的免鉴权路由，把**运行时实际拿到的 config**
直接塞进 JSON 响应——这次全靠它一层层证伪："文件里有、GUI 显示已覆盖、运行时是空"，
一发 HTTP 就定位到插件读取层，而不是继续猜层序/缓存。

## 给官方的建议（追加）

3. `.volatile()` 字段从裸值改引用是破坏性语义变化，建议在 changelog 明示，
   或在 loader 对"插件用 `===`/`typeof` 直判 volatile 字段"这种常见误用给出
   debug 日志提示。
4. `importLegacyDocument()` 的 rename 建议打一条 info 日志（"settings.yaml 已迁移
   至 profile"），否则用户会以为设置丢失。
5. bundle 层 patch 对 volatile 字段的 config 是否应该生效，建议明确定义并文档化
   （当前实测不生效）。

---
完整踩坑实录（含代码片段与检查清单）：
[whalebuddy 仓库 docs/10](https://github.com/2DogsLee/dsh_whalebuddy/blob/main/docs/10-dsh-20260929-migration-lessons.md)
