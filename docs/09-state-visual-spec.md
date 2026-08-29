# 09 · 状态与画面规格追踪

> 用途：宠物所有状态/活动的**画面规格**与**动画参数**的唯一追踪文档，
> 后续任何动效调整都在这里更新 + 追加变更记录。
> 状态机与协议见 docs/02、05；视觉架构见 docs/08。

## 1. 总览

```
priority: needYou > panic > working* > celebrating > sleeping > offline
```

| 状态 | 场景底色 | 顶部光晕 | 海底可见 | 气泡 (周期/峰值) | 鲸鱼姿态 |
|---|---|---|---|---|---|
| offline | `#05131d` | 0.08 | 0.12 | 9s / 0.16 | 剪影降饱和 50% |
| sleeping | `#07232f` | 0.20 | 0.85 | 6s / 0.34 | 卧海底，慢摆 8s |
| working | `#0a3d5e`+activity | 0.35 起 | 0.85 | 2.2–3.4s | 中央 5.5s 摇摆 |
| needYou | `#0b4a68` | 0.55 | 0.30 | 1.7s / 0.80 | 上移顶玻璃+震纹 |
| panic | `#0a2434` | 0.12 | 0.35 | 1.1s / 0.85 | 乱窜 0.32s |
| celebrating | `#0c3d57` | 0.50 | 0.40 | 1.9s / 0.75 | 跃水翻腾 1.5s |

> 场景底色用 `background-color` 过渡（1s），渐变色差由恒定暗角 `::after`
> + 顶部光晕 `::before` 合成（渐变底色不可插值，故不直接换渐变）。

## 2. working 的 activity 细分

| activity | 场景底色 | 光晕 | 场景道具 | 鲸鱼位移 |
|---|---|---|---|---|
| thinking | `#0a3d5e` | 0.35 | 浮游光点 | 中央悬浮 |
| coding | `#0f4e75` | 0.50 | 珊瑚礁（左下） | `(-14px, 16px) rotate 6°` |
| cmd | `#0b3a58` | 0.38 | 发光终端屏（右下） | `(14px, 18px) rotate -5°` |
| search | `#0e4c6e` | 0.45 | 声呐波纹 | `(0, 8px)` |
| spawning | `#0d4a70` | 0.42 | 小弟鲸鱼 ×2 | `(18px, -4px)` |
| idle | 基底 | 0.35 | — | 中央 |

## 3. 四层渲染结构

```
① frame  黄铜舷窗（stroke 圆环 r74±6 + 8 铆钉 + 内阴影）——主题化
② scene  水色 + 光晕 + 暗角 + 道具 + 气泡池
③ whale  DSH 黑鲸（240×320 PNG，黑体+眼/腹白），whale-pos 定位
④ glass  焦散/结雾/敲击震环
```

**鲸鱼本体**（`--whale-w: 84px` → 高 ≈ 112px）：
- 冷白双层光晕：`drop-shadow(0 0 7px rgba(190,220,255,.35)) + drop-shadow(0 0 14px rgba(190,220,255,.18))`
- offline：`opacity(.55) drop-shadow(0 0 4px rgba(190,220,255,.15))`，透明度 .55

## 4. 动画参数（CSS keyframes）

| 动画 | 参数 | 用途 |
|---|---|---|
| sway | rotate ±3°，5.5s（sleeping 8s） | 鲸鱼漂浮摆 |
| dart | translate ±9px / rotate ±5°，0.32s | panic 乱窜 |
| breach | 0→-26px→-14px→8px，rotate -9/5/-3°，1.5s loop | celebrating 跃水 |
| sonar | scale .4→2.8，opacity .75→0，2.4s ×3 错峰 .8s | search 声呐 |
| knockRipple | scale .35→1.9，0.6s | needYou 玻璃震环 |
| portholeKnock | translate ±2px，0.5s | needYou 窗口抖动 |
| babySwim | translate 14px/-10px rotate，4.5s ×2 错峰 | spawning 小弟 |
| murkDrift | translateX ±6%，4.6s ×3 错峰 | panic 浊流 |
| auroraSway | translateX 26% rotate，4.5/5.5s | celebrating 极光 |
| causticPan | 背景图平移，16s | 玻璃焦散 |
| raysSway | rotate ±3°，9s | 顶部光线 |
| rise | 气泡上浮 -152px，drift ±6px | 气泡粒子池（10 个） |

**气泡速率**（JS `bubbleParams` → CSS 变量 `--spd/--op`）：

```
offline:     9.0s / 0.16
sleeping:    6.0s / 0.34
needYou:     1.7s / 0.80
panic:       1.1s / 0.85
celebrating: 1.9s / 0.75
thinking:    3.4 - 0.55×intensity  (intensity 0–3) / 0.5 + 0.12×intensity
search:      2.2s / 0.55
其他 working: 2.6s / 0.50
```

## 5. 调试模式（右键菜单）

**右键宠物** → 弹出状态切换菜单（覆盖窗口内，不影响舷窗）：
- `真实模式`：恢复 DSH 事件驱动
- `offline / sleeping / needYou / panic / celebrating`
- `working·思考0 / 思考2 / coding / cmd / search / spawning`

点击锁定该状态（`debugMode` 覆盖 `deriveState/Activity`），标签显示 `🔧 xxx`；
点菜单外关闭。选中项高亮。用途：**不依赖 DSH 实际事件，直接看某个动效**。

## 6. 变更记录

| 日期 | 修改 | 原因 |
|---|---|---|
| 2026-08-28 | 初版清单落档 | 建立规格追踪 |
| 2026-08-29 | whalebuddy 品牌化：感知层升级为 DSH bundle 插件包（whalebuddy/），注册 whalebuddy 设置 namespace（autostart/skin）；state 快照与 handshake 内嵌 config，设置变更经 WS {type:'config'} 即时推送；皮肤经 html[data-skin] 换肤（默认 dsh-black-whale）。机制与安装见 docs/10 | 需求：DSH 设置菜单配置开机自启动 + 皮肤扩展 + 可安装到其他 DSH 开源分享 |
| — | （待补充） | — |
