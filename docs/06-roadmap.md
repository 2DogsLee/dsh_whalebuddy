# 06 · 实施路线图

三个里程碑，每个都有可独立验收的产出。M1 完成即可看到真实数据流，
M2 完成即是完整可用的纯展示宠物，M3 让它常驻并打开交互大门。

## M1 — 感知层动态插件（数据流验证）✅ 2026-08-24 完成

**产出**：动态 Cordis 插件 `pet-1`（运行 pet-1/pkg-3，v0.7），state 流可被任何 WS 客户端观察。

完成内容：
1. ✅ 契约复核（inspect 工具 input 通道故障，改读发行版源码——见 07 文档）
2. ✅ WsHub：handshake（含 CORS `access-control-allow-origin: *`）+ 手写 RFC6455 WS
3. ✅ StateAggregator：500ms 节流 + JSON diff 抑制
4. ✅ 全部采集器（agent/status、tools、llm/stream、approval、subagent、workflow、goal、jobs）
5. ✅ 心跳 10s、dispose 清理
6. ✅ 多会话聚合：per-agent Map + `sessions:{running,list[]}`（v0.7）
7. ✅ approval 计数修复（多会话并发批准不误清）

**验收结果**：
- [x] WS 收到全量 state 且随真实会话活动更新（冒烟 + proto 页实战验证）
- [x] approval 置位/复位（计数版实现；端到端真实批准待 M3 固化后回归）
- [x] 透传红线：所有工具/流式/批准行为无变化（llm/stream 曾炸过一次，v0.2 修复）
- [ ] `cordis_stop` 后路由释放——**已知限制**：webServer 路由不随插件 stop/undefine
      释放，同路径重注册报 duplicate（见 07 文档 §4）；开发期靠重启进程，M3 固化消除

踩坑实录见 `07-m1-lessons.md`（llm/stream await、btoa UTF-8、路由泄漏、端口发现三层坑）。

## M2 — Tauri 宠物壳（第一版成品）✅ 2026-08-24 完成

**产出**：透明置顶宠物，实时反映 DSH 状态；纯展示。运行：`cd app/src-tauri && cargo run`。

任务：
1. ✅ Tauri v2 工程骨架（透明/置顶/无边框/跳任务栏/不可缩放）
2. ✅ 端口发现 Rust 侧 `discover_port` 命令：DSH_WEB_URL → 8 线程扫描 49152–65535
3. ✅ 状态机：approval > panic > celebrating > working > sleeping > offline 仲裁
4. ✅ emoji 动画集（Lottie 后置）
5. ✅ 窗口行为：拖拽（startDragging 显式调用）、位置记忆（localStorage 物理像素）、
   悬停详情卡（窗口动态加高——透明窗裁剪发生在窗口边界，详情必须留在窗口内）、
   hover 关闭按钮
6. ✅ 多会话 ×N 角标
7. 工具链落地：rustup（rsproxy 镜像）+ VS Build Tools（仅 MSVC + Win11 SDK 组件）

**验收结果**：
- [x] 实时联动：宠物抓到 `waiting` 活动（用户回答问题的动作本身被实时反映）
- [x] 内存 83MB（<100MB 预算）
- [x] 拖拽/详情卡/关闭按钮用户实测通过
- [ ] DSH 重启自动重连恢复——断线重连循环已实现，待真实 DSH 重启检验
- [ ] sleeping 态 CPU ≈ 0% 定量测量（后续用任务管理器观察）

**M2 踩坑**：
- `tauri-build` 在 Windows 必须有 `icons/icon.ico`（资源文件生成），缺失直接构建失败
- drag-region 属性会被 emoji 子元素命中拦截 → 显式 `startDragging()` 替代
- 透明窗口内元素的可见边界 = 窗口边界，`overflow:visible` 无济于事 →
  悬停详情改为窗口 setSize 动态加高
- 沙箱上下文 schannel TLS 不可用（SEC_E_NO_CREDENTIALS），下载需提权运行
- rustup/cargo 官方 CDN 国内极慢（14KB/s），rsproxy.cn 镜像后正常

## M3 — 固化与交互（常驻 + 双向）✅ 2026-08-25 完成

**产出**：DSH 启动即有感知层（宿主组合用户补丁层）；宠物上可直接批准/拒绝。

完成内容：
1. ✅ 固化——但用的是 **`$DSH_HOME/cordis.patch.yml` 宿主用户补丁层**（比"复制整份
   composition"更轻：不改发行版文件、作用于所有 profile、热重载；见 07 教训 8）。
   行内容：`{ id: dsh-pet-perception, name: 'file:///D:/…/host/dsh-pet-host.cjs' }`
   （`file:///` 前缀教训见 07 教训 7——写错盘符路径整个插件树起不来）
2. ✅ `host/dsh-pet-host.cjs`（v1.1）：M1 全部感知 + 领导权守卫（路由撞 duplicate 则
   follower 零副作用）+ approval/request 回答者（`prepend:true` 插队链头；宠物在线截流
   自答，离线/断开/超时 5min → `next()` 交回 GUI 卡片；`safeNext` 兜同步异常）
3. ✅ 协议 v1.1：`approval/asked` / `approval/settled`（DSH→宠物）、
   `approval/respond`（宠物→DSH，outcome ∈ allowed-once|rejected）——03 文档已同步
4. ✅ 宠物端按钮：待批时 tip 让位（`.approving`）+ 窗口定高 340 + ws 顶层作用域
   （三个 UI 坑见 07 教训 9-11）
5. 安全：批准只走 ApprovalService waterfall（同 GUI 卡片同一审计链），
   不新增绕权面；Origin 校验仍留积压

**验收结果**：
- [x] 重启 DSH 后握手 200 + WS 状态流（composition 挂载，无动态插件）——2026-08-25 实测
- [x] 宠物实时抓到 `waiting`（用户答题动作被反映）——固化链路活体证明
- [x] 断开回退：关宠物 → 待批自动交回 GUI 卡片（第 2 轮测试实证）
- [x] 端到端批准：宠物弹按钮 → 点击 → 批准落定 → 操作继续（第 4 轮用户实测通过）
- [x] 尾巴已处理（2026-08-25）：宠物悬停详情显示 host 版本（`已连接 :端口 · host v1.1`），
      下次任意重启瞥一眼即验；命令行验证 `node scripts/check-host.mjs`；
      本轮进程仍跑 v1.0（截流逻辑同款，prepend 为确定性加固，随下次自然重启生效，
      **无需专门重启**）；桌面测试残留文件已清理

## 里程碑之外（积压）

- 多宠物/每会话一只（协议 `agents[]` 已预留）
- Live2D 皮肤（Web SDK 路径）
- token 长胖/瘦身趣味数值动画
- 宠物之间/宠物内多皮肤切换

## 里程碑依赖关系

```
M1 ──▶ M2 ──▶ M3
 │            ▲
 └── 协议冻结 ┘（M2 开始前 03 文档定稿为 v1；改协议必须走版本协商）
```
