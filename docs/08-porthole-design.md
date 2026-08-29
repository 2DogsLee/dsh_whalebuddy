# 08 · 舷窗 × 鲸鱼：深海主题场景设计

> 状态：M4 设计定稿 + 四层渲染架构已落地（`app/ui/index.html`）
> 前置文档：01（架构）、02（信号源）、03（协议）、05（宠物端）

## 1. 定位与目标

M3 的表现层是「emoji 字形 + 状态改描边色」的单层渲染。本设计把表现层升级为
**场景叙事**：宠物状态不再只是"换动画"，而是**换一个世界**。

- **鲸鱼 = agent**：直接复用 DeepSeek logo 的官方鲸鱼矢量 path，品牌身份零偏差；
- **舷窗 = 用户的观察窗**：用户是深潜器里的观察员，隔着玻璃看鲸鱼干活/睡觉/敲门；
- **"深度求索" = 字面意义的深海下潜**：品牌语义与画面叙事闭环；
- **外框可换主题**：潜艇舷窗（默认）→ 航天器舷窗 → 望远镜目镜 → 异次元裂缝……
  主题只换「外框层 + 场景配色 + 鲸鱼色调」，状态机与协议零改动。

目标：

| 项 | 要求 |
|---|---|
| 状态可读性 | 不悬停也能一眼看出 agent 在干什么（场景本身在变） |
| 品牌一致性 | 鲸鱼 = 官方 logo 矢量，跨主题不变形 |
| 可扩展性 | 换主题 = 加一份 manifest，不改渲染器逻辑 |
| 性能 | 沿用 05 文档预算：sleeping/offline ≈ 0% CPU，working < 2% |

## 2. 叙事映射：状态 → 深海场景

现有状态机（7 状态 + 6 activity）不变，每个状态对应一套「场景+鲸鱼+粒子+玻璃」：

| 状态 | 舷窗外世界 | 鲸鱼 | 细节 |
|---|---|---|---|
| offline | 墨黑死水，无光 | 剪影停在窗边，几不可见 | 连不上是正常状态，不是错误 |
| sleeping | 深蓝，光线暗，海底沙地可见 | 卧在海底，缓慢呼吸 | 气泡极稀（~6s/个） |
| thinking | 中蓝，浮游生物光点 | 悬浮，头顶冒泡 | 气泡密度 = thinking intensity |
| coding | 亮蓝，珊瑚礁 | 游向珊瑚 | 珊瑚只在 coding 出现 |
| cmd | 深蓝，沉船残骸 | 对着发光终端 | 终端屏只在 cmd 出现 |
| search | 亮蓝 | 声呐 ping 波纹扩散 | 波纹扫过远处光点 |
| spawning | 亮蓝 | 吹哨，小弟游来集结 | 小鲸鱼 = 缩小版 logo |
| needYou | 更亮，水面近 | **顶撞舷窗玻璃** | 玻璃震纹 + 气泡急促，最高优先级 |
| panic | 浊水湍流 | 慌张乱游 | 浑浊流层 + 急促气泡 |
| celebrating | 极光光柱 | 跃出水面翻腾 | 极光丝带 + 鱼群光点 |

## 3. 四层渲染架构

```
┌─ ① frame 外框层（SVG：铜环 + 铆钉 + 内阴影）── 主题化，可整体替换
│   ┌─ ② scene 场景层（水色 / 光线 / 海底 / 道具 / 粒子）── 随状态变
│   │   ┌─ ③ whale 角色层（官方 logo path，<use> 复用）──── 状态驱动姿态
│   │   └─ whale-pos（定位容器：位移/旋转/跳跃动画）
│   └─ ④ glass 前景层（高光 / 焦散 / 结雾 / 敲击震纹）── 盖在鲸鱼之上
```

DOM 结构（`app/ui/index.html` 内 `.pet`）：

```html
<div class="pet" id="pet" data-state data-activity data-intensity>
  <div class="viewport">
    <div class="scene">      <!-- ② 水色渐变 + 光线 + 海底 + 珊瑚/终端/声呐/极光 -->
      <div class="rays"></div>
      <div class="seabed"></div>
      <div class="coral"></div>
      <div class="terminal"></div>
      <div class="sonar"></div>
      <div class="babies"></div>
      <div class="murk"></div>
      <div class="aurora"></div>
      <div class="bubbles"></div>   <!-- 共享粒子池，JS 调 --spd/--op -->
    </div>
    <div class="whale-pos"><svg class="whale"><use href="#whalePath"/></svg></div>
    <div class="glass">      <!-- ④ 高光/焦散/雾/震纹 -->
      <div class="glint"></div><div class="caustics"></div>
      <div class="fog"></div><span class="knock"></span>
    </div>
  </div>
  <svg class="frame">…铜环铆钉…</svg>
  <span class="count"></span>
</div>
<svg width="0" height="0"><defs><path id="whalePath" …/></defs></svg>  <!-- 单例定义 -->
```

**驱动规则**（渲染器只做三件事）：

| 属性 | 取值 | 消费方 |
|---|---|---|
| `pet[data-state]` | offline/sleeping/needYou/panic/celebrating/working | 场景底色、鲸鱼姿态、粒子速率 |
| `pet[data-activity]` | thinking/coding/cmd/search/spawning/idle | 道具显隐（珊瑚/终端/声呐/小弟）、鲸鱼位移 |
| `pet[data-intensity]` | 0–3 | 思考气泡密度 |

CSS 选择器顺序约定：**activity 规则在前，state 规则在后**——working 期间
activity 决定细节；needYou/panic/celebrating 等全局状态覆盖 activity。

**层间关系**：

- `frame` 在 `viewport` 之上（z-index 3），视觉上"包住"玻璃；
- `glass` 在 `scene` 之上、`frame` 之下，制造"透过玻璃看"的纵深；
- 装饰层全部 `pointer-events: none`，命中/拖拽只发生在 `.pet` 本体（沿用 M3 hit-test）。

## 4. 主题包机制（manifest）

换主题 = 换 `frame` SVG + 一组场景参数。manifest 草案：

```json
{
  "id": "submarine",
  "frame": "submarine.svg",
  "glass": { "tint": "rgba(30,80,120,.25)", "condensation": 0.4 },
  "scene": { "base": "#06283f", "rays": true, "particles": "plankton" },
  "whale": { "src": "dsh_logo.png", "glow": "rgba(190,220,255,.35)" },
  "fx": { "needYou": "headbutt-glass", "search": "sonar-ping" }
}
```

**主题矩阵**（跨主题复用的"行为语义"不变：needYou=顶玻璃、search=波纹定位）：

| 主题 | 外框 | 世界 | 鲸鱼 |
|---|---|---|---|
| 潜艇舷窗（v1，本次实现） | 黄铜圆环+铆钉 | 深海、海底 | 品牌蓝，原始设定 |
| 航天器舷窗 | 方形舱窗+舷梯 | 失重星空、地球弧线 | 同款，太空"游" |
| 望远镜目镜 | 圆形+十字刻度 | 远处极小 | 缩小 + 暗角 |
| 异次元裂缝 | 碎裂玻璃+故障帧 | 色偏/glitch | 轻微故障撕裂 |

> 当前实现把 manifest 内联在 `index.html` 的 `THEME` 常量里（单文件约束）；
> 多主题落地时再拆成 `app/ui/themes/<id>.json` + 运行时加载。

## 5. 鲸鱼造型规范

- **真源**：`logo/dsh_logo.png`（DSH 黑色鲸鱼徽标，1760×2352 原图，经
  .NET System.Drawing 缩到 240×320 保存在 `logo/dsh_logo_sm.png`），
  base64 编码后嵌入 `<defs><image id="whaleImg" width="240" height="320">`，
  `<use href="#whaleImg">` 复用于本体与小弟（不再是矢量 path）。
- **宽高比**：0.75（高瘦型），svg viewBox `0 0 30 40` 等比缩放。
- **展示尺寸**：`--whale-w: 84px` → 高 ≈ 112px，在 150 圆形 viewport
  内撑住主体又不顶到边框。姿态位移相对原蓝鲸版本整体收回
  （breach 顶位 −26px 等），避免上下出框。
- **可读性**：黑色实心在深蓝水里靠**冷白双层 `drop-shadow`**
  （`rgba(190,220,255,.35)` + `.18`）做边缘光晕，模拟深潜器灯光打在
  鲸鱼身上的轮廓光；offline 态降透明度到 .55。
- **不可变形原则**：PNG 位图，整体姿态表达走**位移 / 旋转 / 缩放
  / 透明度**（见 §7），不做部件级骨骼动画——刻意的取舍，
  避免骨骼变形让品牌徽标失真。

## 6. 场景驱动细则

### 6.1 水色（smooth transition）

`scene` 用 `background-color`（可过渡）+ 恒定径向暗角 `::after` +
`sceneGlow` 顶部光晕（opacity 过渡）。**避免渐变背景直接换**——CSS 无法插值
渐变，会跳变。三层合成后颜色过渡是平滑的。

### 6.2 气泡（共享粒子池）

- 10 个 `<i>` 常驻，CSS 变量驱动：`--spd`（周期）、`--op`（峰值透明度）、
  `--x`（水平位置）、`--dx`（漂移）、`--d`（错峰延迟）；
- JS 按 (state, activity, intensity) 算参数，只写两个变量：
  - sleeping：`spd 6s, op .34`；offline：`spd 9s, op .16`；
  - thinking：`spd = 3.4 - 0.55·n`，`op = .5 + .12·n`（intensity 0–3）；
  - needYou：`spd 1.7, op .8`；panic：`spd 1.1, op .85`；
  - 其余 working：`spd 2.6, op .5`。
- sleeping/offline 场景其余动画全部 CSS-only，JS 循环不跑（沿用 05 预算）。

### 6.3 玻璃（无 backdrop-filter）

透明窗口里 backdrop-filter 模糊不了桌面且烧 GPU，三层伪造：
`glint`（径向高光弧）+ `caustics`（预渲染 tile 平移，工作态加强）+
`fog`（hover 结雾）。needYou 时 `knock` 震环扩散 + viewport 抖动。

## 7. 状态 → 表现细节清单（v1 实现）

| 状态/activity | scene 底色 | whale-pos | whale | 道具/特效 |
|---|---|---|---|---|
| offline | #05131d | 下移 8px | 去饱和 + 半透明 | 光线关、气泡极稀 |
| sleeping | #07232f | 下移 36px | 慢速摇摆 | 海底可见、气泡稀 |
| thinking | #0a3d5e | 居中 | 左右摇摆 | 气泡随 intensity |
| coding | #0f4e75 | 左下移 24px 旋转 | — | 珊瑚出现 |
| cmd | #0b3a58 | 右下移 26px | — | 终端屏出现 |
| search | #0e4c6e | 下移 14px | — | 声呐波纹 |
| spawning | #0d4a70 | 右移 24px | — | 2 只小弟游来 |
| needYou | #0b4a68 | 上移 32px | 静止 | 玻璃震环 + 抖动 |
| panic | #0a2434 | 乱窜动画 | 静止 | 浑浊流层 |
| celebrating | #0c3d57 | 跃水动画 | 静止 | 极光丝带 |

## 8. 实现要点（与 05 文档预算对齐）

1. **SVG + CSS 动画，无 Lottie**：整套 < 60KB，比每状态一份 Lottie JSON 便宜；
   鲸鱼仅一个 `<use>`，零重复。
2. **性能**：decorative 层 `pointer-events:none`；sleeping/offline 停 rAF；
   粒子是 CSS 动画，不占 JS 循环。
3. **窗口几何不变**：220×300（BASE）/340（批准）/470（悬停详情）；
   `.pet` 150×150，frame SVG 160×160 外扩 5px。
4. **命中/拖拽不变**：`.pet` 本体 mousedown → startDragging；圆外透明区行为同 M3。
5. **逻辑层零改动**：连接/端口发现/批准/拖拽/位置记忆/窗口高度逻辑原样保留，
   只替换 `.pet` 内部渲染与 `render()` 的视觉部分。

## 9. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M4a | 本设计落档 + 四层架构 + 全部状态场景 | ✅ 本文档 + `app/ui/index.html` |
| M4b | 过渡打磨（状态切换 200ms）、needYou 音效、实机视觉走查 | 待做 |
| M5 | 主题包 manifest 抽象 + 航天器舷窗主题验证可扩展性 | 待做 |
| 二期 | 点击喷水彩蛋、舷窗刻度仪表盘（深度=turn、水温=token 速率）、通讯面板式批准按钮 | 待做 |

## 10. 遗留与注意事项

- **标识符必须独立**：`tauri.conf.json` 的 `identifier` 不能是 `dev.dsh.pet`——
  宿主 DSH Desktop 就是用它，两个应用的 WebView2 用户数据目录（
  `%LOCALAPPDATA%\<identifier>\EBWebView`）会互锁：宠物进程存活、窗口存在、
  但 WebView 永远初始化不了（表现为空白窗口、无 msedgewebview2 子进程）。
  本仓库已改为 `dev.dsh.pet.app`。从沙箱/受限环境启动时，应用需要能
  创建该目录，否则 setup 报 `拒绝访问 (os error 5)`。

- **点击彩蛋冲突**：`.pet` mousedown 即 startDragging，click 事件不可靠；
  需区分 click/drag（位移阈值）后再做"点击鲸鱼喷水"。
- **鲸鱼比例**：DSH 黑色 PNG 宽高比 0.75，默认 `--whale-w: 84px` → 高 ≈ 112px，
  占舷窗大部分高度；如需更"小只"可调 `--whale-w` 变量。
- **`<use>` 换色**：`whalePath` 不写 fill，由 `<use>` 的 fill 属性传入，
  小弟/未来主题才能换色。
- **浏览体验证**：`node proto/serve.mjs` 只服务 proto 页；舷窗渲染要在
  Tauri 里跑 `cargo run` 看实机效果（或临时把 `app/ui/index.html` 喂给
  任意静态服务器，但缺 `window.__TAURI__` 会走"请用 cargo run"分支）。
