# 10 · DSH 2026-09-29 桌面版迁移踩坑实录（whalebuddy 视角）

> 2026-10-03 排障实录。现象是「宠物拉不起来」，实际是四层问题叠加；
> 其中第 2、3 条是 DSH 2026-09-29 更新的**未充分公告的行为变化**，
> 预计影响所有自带 Config schema 的社区 bundle 作者。

## 0. 现象与结论速查

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 设置里填了宠物 exe 路径仍报「未找到宠物程序」 | volatile 引用 bug（见 §2） | `.get()` 解包 + 监听 `loader/volatile-update` |
| GUI「保存」成功、补丁文件里也有值，运行时却全空 | 同上 | 同上 |
| 进程活着、WS 已连，屏幕上看不到窗口 | 写死 x/y 在多屏 + 1.5x DPI 下落到 -32000 离屏（见 §4） | setup 钩子按主屏物理坐标算右下角 |
| `~/.dsh/settings.yaml` 消失 | 官方已移除该文件，静默 rename 为 `.imported`（见 §3） | 无需处理，设置已迁入 profile |

## 1. 排障方法论（这次真正省时间的做法）

- **"文件对但运行时不对"时，第一动作是查运行时**：
  `GET http://127.0.0.1:<port>/dsh-pet/handshake` 里的 `config` 字段就是插件实际拿到的值。
  一发 HTTP 就能证伪/证实"配置没被读到"，比反复翻补丁文件、猜层序快得多。
  端口获取：`($env:DSH_WEB_URL -split ':')[-1]`（在带 DSH 环境的 shell 里）。
- **静默失败比报错危险**：volatile 引用不匹配不抛错、只落默认值。
  插件适配新宿主时应**对 config 入参做形状断言并打日志**（本插件走 `pet-discover.log`）。
- **判断命令是否生效要看副作用，不要看退出码**（DSH 沙箱执行器的老问题，
  见 deploy-kit sandbox-permissions-playbook §6）。

## 2. 【未充分公告】volatile 字段传给插件的是引用，不是值 ⭐ 最大的坑

**变化**：Config schema 里标了 `.volatile()` 的字段，宿主解析后传给 `apply(ctx, config)`
的**不再是裸值**，而是 Volatile 引用对象（快照语义，须 `.get()` 读）。

**文档现状**：`@deepseek-ai/cordis` README 有一句
"Schemas may return `Volatile<T>` references, whose values are read through `.get()`"，
但没有破坏性变更公告；dsh 侧文档只把 volatile 描述为"设置表单投影"所需标记。

**踩坑方式**：插件里按直觉写

```js
cfg.petPath = typeof config.petPath === 'string' ? config.petPath : ''
cfg.autostart = config.autostart === true
```

引用对象永远不匹配 → **cfg 恒为默认值，且不报任何错**。
GUI 保存成功（settings 服务写盘正常）、describe/served 一切正常，
只有 `apply()` 拿到的 config 是"空"的。

**修复模式**（whalebuddy/lib/index.cjs）：

```js
const readV = (v) => (v && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v
const cfg = { /* 默认值 */ }
function refreshCfg() {
  cfg.petPath = typeof readV(config.petPath) === 'string' ? readV(config.petPath) : ''
  cfg.autostart = readV(config.autostart) === true
  // ...
}
refreshCfg()
ctx.on('loader/volatile-update', () => refreshCfg()) // volatile-only 变更就地提交引用，不重启 fiber
```

`readV` 兼容裸值路径（旧宿主 / 测试直传普通对象不坏）。

**附带发现**：bundle patch 的 `config:` 里写 volatile 字段**不生效**
（运行时仍是默认值）；volatile 字段的持久化唯一可靠入口是 **settings 服务**
（GUI 保存 / `settings.update`），落盘位置见 §3。

## 3. 【未充分公告】`settings.yaml` 被移除

**变化**：新版 DSH 启动时把 `~/.dsh/settings.yaml` **静默 rename** 为
`settings.yaml.imported`，并把各段迁入当前 profile 的 composition
（`@deepseek-ai/dsh-settings` 的 `importLegacyDocument()`）。

**文档现状**：只在 dsh-settings 代码注释里有一句 "removed settings.yaml"；
无用户可见的迁移日志。文件"消失"会让人以为设置全丢。

**新事实**：
- GUI「设置」保存的插件配置，落盘位置是
  **`~/.dsh/profiles/<profile>/cordis.patch.yml`** 的对应条目 `config:` 里
  （dsh-web-app README 一笔带过 "saves persist in the profile"）；
  **不是** `~/.dsh/cordis.patch.yml`（home 层是机器级部署补丁，不存设置）。
- `.imported` 是一次性迁移水位标记，可留作证据，不必删。

## 4. 桌面壳窗口定位：永远不要写死坐标

**现象**：进程活着、MainWindowHandle 有效、WS 已连，屏幕上找不到窗口。
`GetWindowRect` → `L=-21333`（即 -32000 按 2/3 DPI 虚拟化换算，Windows 经典离屏位）。

**根因**：tauri.conf.json 写死 `x: 1100, y: 560`（逻辑坐标），
多显示器 + 1.5x DPI 下换算不可靠。

**修复**：conf 里删掉 x/y；`setup` 钩子内运行时计算
（物理像素全程直算，无 DPI 误差）：

```rust
let mon = win.primary_monitor().ok().flatten()
    .or_else(|| win.current_monitor().ok().flatten());
let mp = mon.position(); let ms = mon.size();      // 物理像素
let ws = win.outer_size().unwrap_or_default();      // 物理像素
let margin = (16.0 * mon.scale_factor()) as i32;    // 逻辑边距 → 物理
let x = mp.x + ms.width as i32 - ws.width as i32 - margin;
let y = mp.y + ms.height as i32 - ws.height as i32 - margin;
win.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)))?;
```

**诊断通道**：GUI 进程没有 stdout，所有发现/定位日志落
exe 旁 `pet-discover.log`（失败回落 `%LOCALAPPDATA%\dev.dsh.pet\discover.log`）。

## 5. DSH Desktop 的运行时事实（排查时最容易迷路的部分）

- **Desktop 实际跑的是 `web` profile**，不是 `profiles/desktop`
  （后者存在但不含用户装的 bundle）。确认方法：看进程参数
  `DSH Desktop.exe --expose-internals ...runtime-launcher.mjs web --port 3080`。
  Desktop 端口固定 3080，CLI 才是临时端口。
- **bundle 的模块代码只在进程启动时加载**。改 `node_modules/<bundle>/lib/*.js` 后
  碰 home patch 触发 recomposition 也**不会**重新 require 模块——必须彻底退出
  DSH Desktop（含托盘）重启。HMR 只监视 profile/home patch **文件**的变更。
- **层序**（后写覆盖先写，按 row id 整行 config 替换）：
  `dsh.profile.bundles` 各 bundle 的 patch → `profiles/<profile>/cordis.patch.yml` →
  `~/.dsh/cordis.patch.yml`（home）→ `--patch` overlays。
  volatile 字段例外，见 §2 附带发现。

## 6. 次要坑

- whalebuddy 自带的 `/dsh-pet/config` HTML 配置页，布尔字段 checkbox 约定 `value='1'`；
  以表单 POST `'true'` 会被 `=== '1'` 判成 false **写盘**（本次实测踩中）。
- 排障时把 `profiles/desktop` 当成运行 profile 会白绕一圈（见 §5）。

## 7. 迁移检查清单（给 bundle 作者，DSH ≥ 2026-09-29）

1. Config 里所有 `.volatile()` 字段：改用 `readV().get()` 读取 + 监听
   `loader/volatile-update`；禁止 `===`/`typeof` 直判 config 字段。
2. volatile 字段不要写进 bundle patch 的 `config:`（不生效）；部署默认值走
   settings 服务或接受 schema default。
3. 别再读写 `~/.dsh/settings.yaml`（已不存在）；用户设置在
   `profiles/<profile>/cordis.patch.yml`。
4. 别用 `profiles/desktop` 判断 Desktop 的 bundle 组成；它跑的是 `web`。
5. 改 bundle 代码后必须整机重启 DSH，HMR 不会重载 bundle 模块。
6. GUI 壳窗口初始位置运行时计算，不写死 x/y。
