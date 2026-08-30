/**
 * whalebuddy 浏览器半侧 —— 手写的 client bundle（loader lazy-CJS factory 格式）。
 *
 * 格式契约（与仓库内 tsdown clientBundle 预设输出一致，同 dsh-cron 先例）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { …CJS…; return module.exports } })
 *   require 由 loader 注入，可解析平台模块表（react 等）。
 *
 * 契约面刻意收到最小：
 *   - 只 require('react')（平台模块，永远在场）
 *   - 注入 'slots' + 'settingsScope' 服务：
 *     · settingsScope.bind({ namespace: 'whalebuddy' }) = Host 侧 whalebuddy 设置
 *       命名空间的原生读写通道（保存走 settings.mutate，带 revision 围栏；
 *       覆盖/重置徽标按 user 层字段存在性判定——与官方插件卡片同语义）。
 *   - 注册一张卡片到 settings.plugin.item 插槽，key = 'whalebuddy'
 *     （设置页「插件配置」分页按 Host settings.describe 的 ns 与本 key 配对渲染）。
 *   - 运行状态（宠物在线与否）与「立即启动」走同源 fetch：
 *     GET /dsh-pet/api/status、POST /dsh-pet/api/launch（宿主 webServer 路由）。
 *
 * 卡片内容（启动 + 运行状态设置）：
 *   - 状态行：宠物连接状态 + 立即启动按钮
 *   - autostart        开机自启动宠物（桌面壳写/删 Windows Run 键）
 *   - launchOnDshStart DSH Desktop 启动时自动启动宠物（Host 自动拉起）
 *   - petPath          宠物程序路径（空 = 按注册表 Run 键发现）
 *   - skin             皮肤 id
 *
 * 兼容策略：本文件是插件对 GUI 的唯一依赖点。Desktop 升级后若卡片消失，
 * 按序检查：① window.__ModuleLoader__.load 工厂格式未变；② settings.plugin.item
 * 插槽仍存在且按 entryKey 派发；③ Host 侧设置命名空间 'whalebuddy' 仍被
 * describe() 镜像上报；④ settingsScope.bind 的快照形状（status/value/base/user/
 * writable）未变。任一变化只需改这个小文件，/dsh-pet/config 配置页与感知层不受影响。
 */
window.__ModuleLoader__.load({
	id: "whalebuddy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect } = react;

		// ───────────────────────── 样式（跟随 DSH 主题别名变量） ─────────────────────────

		const ALIAS = {
			textPrimary: "var(--dsw-alias-label-primary)",
			textSecondary: "var(--dsw-alias-label-secondary)",
			textTertiary: "var(--dsw-alias-label-tertiary)",
			border: "var(--dsw-alias-border-l2)",
			bgLayer2: "var(--dsw-alias-bg-layer-2)",
			bgLayer3: "var(--dsw-alias-bg-layer-3)",
			bgPill: "var(--dsw-alias-bg-module-platform)",
			// 主操作按钮（保存/立即启动）用官方保存按钮同款反色组合，跟随主题自适应——
			// 不能硬编码白字（部分主题 brand-primary 是浅色，会变成白底白字不可见）。
			primaryBtnBg: "var(--dsw-alias-label-primary)",
			primaryBtnText: "var(--dsw-alias-bg-layer-3)",
			error: "var(--dsw-alias-label-error)",
			hoverBorder: "var(--dsw-alias-label-dimmed)",
		};

		const NS = "whalebuddy";

		// 字段元数据（顺序即卡片内呈现顺序）
		const BOOL_FIELDS = [
			{
				field: "autostart",
				label: "开机自启动宠物",
				hint: "系统启动时自动运行宠物程序（桌面壳写/删 Windows 注册表 Run 键）",
			},
			{
				field: "launchOnDshStart",
				label: "DSH Desktop 启动时自动启动宠物",
				hint: "DSH 每次启动后观察 2 分钟：宠物进程已在跑就等它重连，进程不在则自动拉起",
			},
		];
		const TEXT_FIELDS = [
			{
				field: "petPath",
				label: "宠物程序路径",
				hint: "dsh-pet.exe 完整路径；留空 = 按注册表开机自启键自动发现",
				placeholder: "例：D:\\tools\\whalebuddy\\dsh-pet.exe",
			},
			{
				field: "skin",
				label: "皮肤",
				hint: "皮肤 id，默认 dsh-black-whale（黑鲸舷窗）",
				placeholder: "dsh-black-whale",
			},
		];

		// ───────────────────────── 表单模型（staged draft，保存才写） ─────────────────────────

		/**
		 * 单命名空间的暂存表单：编辑只进 staged 草稿；save() 才逐字段写 Host。
		 * 写入结果按官方卡片的判定法回读：set 后 user[field] === value 视为落盘，
		 * unset 后 user 无该键视为落盘；任一未落盘 → failed=true 且保留草稿供修改。
		 */
		function createForm(scope) {
			const staged = new Map(); // field -> {kind:'bool',value} | {kind:'text',text} | {kind:'clear'}
			const listeners = new Set();
			const state = { saving: false, failed: false };

			function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
			function publish() { for (const fn of listeners) fn(); }
			function snap() { return scope.getSnapshot(); }
			function stored(field) {
				const u = snap().user;
				return !!u && Object.prototype.hasOwnProperty.call(u, field);
			}
			function sectionValue(field) {
				const s = snap();
				return s.status === "ready" && s.value ? s.value[field] : undefined;
			}
			function baseValue(field) {
				const s = snap();
				return s.base && typeof s.base[field] !== "undefined" ? s.base[field] : undefined;
			}
			// 复选框显示值：草稿优先；clear 草稿回落 base（保存前即所见即所得）
			function checkboxValue(field) {
				const s = staged.get(field);
				if (s && s.kind === "bool") return s.value === true;
				if (s && s.kind === "clear") return baseValue(field) === true;
				return sectionValue(field) === true;
			}
			function textValue(field) {
				const s = staged.get(field);
				if (s && s.kind === "text") return s.text;
				if (s && s.kind === "clear") return "";
				const v = sectionValue(field);
				return typeof v === "string" ? v : "";
			}
			function toggle(field, next) { staged.set(field, { kind: "bool", value: next === true }); state.failed = false; publish(); }
			function editText(field, text) { staged.set(field, { kind: "text", text }); state.failed = false; publish(); }
			function resetField(field) { staged.set(field, { kind: "clear" }); state.failed = false; publish(); }
			function discard() { if (staged.size === 0 && !state.failed) return; staged.clear(); state.failed = false; publish(); }
			function dirty() { return staged.size > 0; }

			async function save() {
				if (staged.size === 0 || state.saving) return;
				state.saving = true; state.failed = false; publish();
				let landed = true;
				for (const [field, s] of [...staged]) {
					try {
						if (s.kind === "bool") {
							await scope.set(field, s.value);
							const u = snap().user;
							if (!(u && Object.prototype.hasOwnProperty.call(u, field) && u[field] === s.value)) landed = false;
						} else if (s.kind === "clear") {
							await scope.unset(field);
							if (stored(field)) landed = false;
						} else {
							const trimmed = s.text.trim();
							if (trimmed === "") {
								await scope.unset(field);
								if (stored(field)) landed = false;
							} else {
								await scope.set(field, trimmed);
								const u = snap().user;
								if (!(u && Object.prototype.hasOwnProperty.call(u, field) && u[field] === trimmed)) landed = false;
							}
						}
					} catch (e) { landed = false; }
				}
				if (landed) staged.clear();
				state.saving = false; state.failed = !landed; publish();
			}

			return { subscribe, stored, checkboxValue, textValue, toggle, editText, resetField, discard, dirty, save, state };
		}

		// ───────────────────────── 卡片组件 ─────────────────────────

		function Row({ children }) {
			return h("div", { style: { display: "flex", alignItems: "center", gap: "10px", padding: "12px 0" } }, children);
		}

		function Badge({ children, muted }) {
			return h("span", {
				style: {
					whiteSpace: "nowrap", borderRadius: "999px", padding: "1px 8px",
					fontSize: "11px", fontWeight: 500, lineHeight: "17px",
					background: muted ? "transparent" : ALIAS.bgPill,
					color: muted ? ALIAS.textTertiary : ALIAS.textSecondary,
				},
			}, children);
		}

		function ResetLink({ onClick }) {
			return h("button", {
				type: "button", onClick,
				style: {
					font: "inherit", background: "none", border: "none", padding: 0, cursor: "pointer",
					fontSize: "12px", lineHeight: 1.5, color: ALIAS.textSecondary,
				},
			}, "恢复默认");
		}

		function WhalebuddyCard({ form, scope }) {
			const [, bumpRender] = useState(0);
			const [scopeSnap, setScopeSnap] = useState(() => scope.getSnapshot());
			const [open, setOpen] = useState(false);
			const [pet, setPet] = useState(undefined); // undefined=未知 true/false=在线与否
			const [launchMsg, setLaunchMsg] = useState(null);

			useEffect(() => form.subscribe(() => bumpRender((v) => v + 1)), [form]);
			useEffect(() => scope.subscribe(() => setScopeSnap(scope.getSnapshot())), [scope]);

			// 运行状态拉取：挂载时 + 每次展开时 + 展开期间 10s 轻轮询
			async function refreshStatus() {
				try {
					const r = await fetch("/dsh-pet/api/status", { cache: "no-store" });
					if (!r.ok) throw new Error("HTTP " + r.status);
					const data = await r.json();
					setPet(!!(data && data.pet && data.pet.connected));
				} catch (e) { setPet(undefined); }
			}
			useEffect(() => { refreshStatus(); }, []);
			useEffect(() => {
				if (!open) return;
				refreshStatus();
				const t = setInterval(refreshStatus, 10000);
				return () => clearInterval(t);
			}, [open]);

			async function launch() {
				setLaunchMsg("启动中…");
				try {
					const r = await fetch("/dsh-pet/api/launch", { method: "POST", cache: "no-store" });
					const data = await r.json().catch(() => ({}));
					if (data && data.reason === "pet-connected") setLaunchMsg("宠物已在线，无需启动");
					else if (data && data.reason === "process-running") setLaunchMsg("宠物进程已在运行（正在重连 DSH，通常几秒内连上）；重复启动会因 WebView2 目录锁失败");
					else if (data && data.launched) setLaunchMsg("已拉起宠物，等待连接…");
					else if (data && data.reason === "exe-not-found") setLaunchMsg("未找到宠物程序：请设置「宠物程序路径」或先开启开机自启");
					else setLaunchMsg("启动失败：" + ((data && (data.reason || data.error)) || "未知错误"));
				} catch (e) {
					setLaunchMsg("启动失败：" + String((e && e.message) || e));
				}
				setTimeout(refreshStatus, 2500);
			}

			const writable = scopeSnap.writable !== false;
			const dirty = form.dirty();
			const saving = form.state.saving;
			const failed = form.state.failed;

			// 设置镜像未就绪（或本部署未服务该命名空间）→ 不渲染，
			// 避免加载窗口期显示回落默认值（与官方插件卡片的 available 语义一致）。
			if (scopeSnap.status !== "ready") return null;

			return h("li", {
				style: {
					listStyle: "none", borderRadius: "12px",
					border: "1px solid " + (open ? ALIAS.hoverBorder : ALIAS.border),
					background: open ? ALIAS.bgLayer2 : ALIAS.bgLayer3,
					transition: "border-color .16s, background .16s",
				},
			},
				h("button", {
					type: "button",
					"aria-expanded": open,
					onClick: () => setOpen(!open),
					style: {
						appearance: "none", width: "100%", font: "inherit", textAlign: "left", cursor: "pointer",
						background: "none", border: 0, borderRadius: "12px",
						display: "flex", alignItems: "center", gap: "12px", padding: "14px 16px",
						color: "inherit",
					},
				},
					h("span", { style: { display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: 0 } },
						h("span", { style: { fontSize: "15px", fontWeight: 600, lineHeight: 1.4, color: ALIAS.textPrimary } },
							"🐋 桌面宠物 whalebuddy"),
						h("span", { style: { fontSize: "13px", lineHeight: 1.5, color: ALIAS.textTertiary } },
							"启动与运行状态设置：开机自启 / DSH 启动自启 / 皮肤"),
					),
					pet === true ? h(Badge, null, "宠物在线") : null,
					dirty ? h(Badge, null, "未保存") : null,
					h("span", {
						style: {
							color: ALIAS.textTertiary, flex: "none",
							display: "inline-block", transition: "transform .16s",
							transform: open ? "rotate(180deg)" : "none",
						},
					}, "▾"),
				),
				open ? h("div", {
					style: {
						borderTop: "1px solid " + ALIAS.border, margin: "0 16px", paddingBottom: "8px",
						display: "flex", flexDirection: "column",
					},
				},
					!writable ? h("p", {
						role: "status",
						style: { color: ALIAS.textTertiary, fontSize: "12px", margin: "12px 0 0" },
					}, "本部署的设置为只读。") : null,

					// ── 运行状态行 ──
					h(Row, null,
						h("span", {
							style: {
								width: "8px", height: "8px", borderRadius: "50%", flex: "none",
								background: pet === true ? "#3fb950" : pet === false ? "#8b93a1" : "transparent",
								boxShadow: pet === true ? "0 0 0 3px rgba(63,185,80,.15)" : "none",
							},
						}),
						h("span", { style: { fontSize: "13px", color: ALIAS.textPrimary } },
							pet === true ? "宠物运行中（已连接 DSH）"
								: pet === false ? "宠物未连接（离线 / 未启动）"
									: "宠物状态未知"),
						h("span", { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
							h("button", {
								type: "button", onClick: refreshStatus,
								style: {
									font: "inherit", fontSize: "12px", cursor: "pointer",
									padding: "3px 10px", borderRadius: "6px",
									background: "none", border: "1px solid " + ALIAS.border,
									color: ALIAS.textSecondary,
								},
							}, "刷新"),
							h("button", {
								type: "button", onClick: launch, disabled: pet === true,
								style: {
									font: "inherit", fontSize: "12px", cursor: pet === true ? "default" : "pointer",
									padding: "3px 10px", borderRadius: "6px",
									background: ALIAS.primaryBtnBg, border: "1px solid transparent",
									color: ALIAS.primaryBtnText, opacity: pet === true ? 0.5 : 1,
								},
							}, "立即启动"),
						),
					),
					launchMsg ? h("p", {
						style: { margin: "0 0 4px", fontSize: "12px", lineHeight: 1.5, color: ALIAS.textTertiary },
					}, launchMsg) : null,

					// ── 布尔字段（checkbox） ──
					BOOL_FIELDS.map((f) => h("div", {
						key: f.field,
						style: { borderTop: "1px solid " + ALIAS.border, padding: "12px 0" },
					},
						h(Row, null,
							h("input", {
								id: "whalebuddy-" + f.field,
								type: "checkbox",
								checked: form.checkboxValue(f.field),
								disabled: !writable,
								onChange: (e) => form.toggle(f.field, e.target.checked),
								style: { width: "18px", height: "18px", margin: 0, flex: "none", cursor: writable ? "pointer" : "default" },
							}),
							h("label", {
								htmlFor: "whalebuddy-" + f.field,
								style: { flex: 1, minWidth: 0, fontSize: "13px", fontWeight: 500, lineHeight: 1.5, color: ALIAS.textPrimary },
							}, f.label),
							form.stored(f.field) ? h(Badge, null, "已覆盖") : null,
							form.stored(f.field) ? h(ResetLink, { onClick: () => form.resetField(f.field) }) : null,
						),
						h("p", { style: { margin: 0, fontSize: "12px", lineHeight: 1.5, color: ALIAS.textTertiary } }, f.hint),
					)),

					// ── 文本字段 ──
					TEXT_FIELDS.map((f) => h("div", {
						key: f.field,
						style: { borderTop: "1px solid " + ALIAS.border, padding: "12px 0", display: "flex", flexDirection: "column", gap: "6px" },
					},
						h(Row, null,
							h("label", {
								htmlFor: "whalebuddy-" + f.field,
								style: { flex: 1, minWidth: 0, fontSize: "13px", fontWeight: 500, lineHeight: 1.5, color: ALIAS.textPrimary },
							}, f.label),
							form.stored(f.field) ? h(Badge, null, "已覆盖") : null,
							form.stored(f.field) ? h(ResetLink, { onClick: () => form.resetField(f.field) }) : null,
						),
						h("input", {
							id: "whalebuddy-" + f.field,
							type: "text",
							value: form.textValue(f.field),
							placeholder: f.placeholder || "",
							disabled: !writable,
							onChange: (e) => form.editText(f.field, e.target.value),
							style: {
								border: "1px solid " + ALIAS.border, background: ALIAS.bgLayer3,
								height: "34px", font: "inherit", color: ALIAS.textPrimary,
								borderRadius: "8px", padding: "0 12px", fontSize: "13px", lineHeight: 1.5,
								boxSizing: "border-box", width: "100%",
							},
						}),
						h("p", { style: { margin: 0, fontSize: "12px", lineHeight: 1.5, color: ALIAS.textTertiary } }, f.hint),
					)),

					// ── 底部动作条 ──
					h("div", {
						style: {
							borderTop: "1px solid " + ALIAS.border, display: "flex",
							justifyContent: "flex-end", alignItems: "center", gap: "8px",
							padding: "12px 0 4px",
						},
					},
						failed ? h("p", {
							role: "status",
							style: { minWidth: 0, flex: 1, margin: 0, fontSize: "12px", lineHeight: 1.5, color: ALIAS.error },
						}, "本部署没有接受这些值，已保留供你修改。") : null,
						h("button", {
							type: "button", onClick: () => form.discard(), disabled: !dirty || saving,
							style: {
								appearance: "none", font: "inherit", cursor: dirty && !saving ? "pointer" : "default",
								border: "1px solid " + ALIAS.border, borderRadius: "8px",
								padding: "5px 14px", fontSize: "13px", lineHeight: 1.5,
								background: "none", color: ALIAS.textSecondary, opacity: dirty && !saving ? 1 : 0.5,
							},
						}, "放弃修改"),
						h("button", {
							type: "button", onClick: () => form.save(), disabled: !dirty || saving,
							style: {
								appearance: "none", font: "inherit", cursor: dirty && !saving ? "pointer" : "default",
								border: "1px solid transparent", borderRadius: "8px",
								padding: "5px 14px", fontSize: "13px", lineHeight: 1.5,
								background: ALIAS.primaryBtnBg, color: ALIAS.primaryBtnText,
								opacity: dirty && !saving ? 1 : 0.5,
							},
						}, saving ? "保存中…" : "保存"),
					),
				) : null,
			);
		}

		// ───────────────────────── 插件装配 ─────────────────────────

		exports.inject = ["slots", "settingsScope"];
		exports.apply = function (ctx) {
			try {
				const scope = ctx.settingsScope.bind({ namespace: NS });
				const form = createForm(scope);
				const ConnectedCard = () => h(WhalebuddyCard, { form, scope });
				ctx.slots.inject("settings.plugin.item", function () {
					return ctx.slots.register({
						name: "settings.plugin.item",
						key: NS,
					}, ConnectedCard);
				});
			} catch (e) {
				// 设置分区缺席或插槽契约变化：静默降级，/dsh-pet/config 配置页与感知层不受影响。
				try { console.warn("[whalebuddy] 设置卡片注册失败（配置页不受影响）：", e) } catch (_) {}
			}
		};
		return module.exports;
	}
});
