/**
 * dsh-work —— 浏览器侧插件（手写 bundle，遵循宿主 __ModuleLoader__ 约定）
 *
 * 形态：右侧栏一个「需要你」标签页。
 * 数据：本机 dsh-remote 面板的 HTTP 接口 `GET /api/work`（回环免 token，
 *       因为它只读本地台账、不碰远程）。每 20 秒轮询一次 —— 实验结束时
 *       面板上的台账已经变了，这里最多晚 20 秒看到。
 *
 * 为什么不用 WebSocket：这一层只需要"定期看一眼"，轮询最省事、坏了也好查；
 * 事件推送等真需要毫秒级再说。
 */
window.__ModuleLoader__.load({
	id: "dsh-work",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/** 面板默认端口；可用 localStorage["dshRemotePanel"] 覆盖（与 remote-files 共用）。 */
		const panelBase = () => localStorage.getItem("dshRemotePanel") || "http://127.0.0.1:4100";
		const TAB_ID = "dsh-work";
		const TAB_KIND = "dsh-work";
		const POLL_MS = 20000;

		const S = {
			wrap: { display: "flex", flexDirection: "column", height: "100%", fontSize: 13 },
			bar: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--dsh-border, #e5e5e5)" },
			count: { flex: 1, opacity: 0.75 },
			btn: { fontSize: 12, padding: "2px 8px", borderRadius: 6, border: "1px solid var(--dsh-border, #d8d8d8)", background: "transparent", cursor: "pointer" },
			list: { flex: 1, overflow: "auto", padding: "8px 10px" },
			card: { border: "1px solid var(--dsh-border, #e8e8e8)", borderRadius: 8, padding: "8px 10px", marginBottom: 8 },
			state: { fontSize: 11, fontWeight: 600, opacity: 0.8, marginBottom: 4 },
			sum: { lineHeight: 1.5, wordBreak: "break-word" },
			advice: { marginTop: 6, fontSize: 12, opacity: 0.8, whiteSpace: "pre-wrap" },
			judge: { marginTop: 6, fontSize: 12, whiteSpace: "pre-wrap", borderLeft: "2px solid #7aa2f7", paddingLeft: 8 },
			empty: { padding: 16, opacity: 0.7, lineHeight: 1.6 },
			err: { color: "#c0392b", padding: "8px 10px", fontSize: 12, whiteSpace: "pre-wrap" },
			runningCard: { display: "flex", alignItems: "baseline", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--dsh-border, #f0f0f0)", fontSize: 12 },
			dot: { width: 7, height: 7, borderRadius: 4, background: "#2e9e5b", flex: "none" },
			dotStalled: { width: 7, height: 7, borderRadius: 4, background: "#d38b00", flex: "none" },
			runningMeta: { opacity: 0.7, flex: "none" },
			runningId: { fontFamily: "ui-monospace, monospace", fontSize: 11, opacity: 0.9 },
			stalledTag: { color: "#b9770e", fontWeight: 600 },
			barTrack: { height: 4, borderRadius: 2, background: "var(--dsh-border, #ececec)", margin: "4px 0 2px", overflow: "hidden" },
			barFill: { height: 4, background: "#2e9e5b", borderRadius: 2 },
			barRow: { padding: "0 10px 6px" },
			pctText: { fontSize: 11, opacity: 0.7 },
		};

		/** 毫秒 → 可读时长。 */
		function humanMs(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "?";
			const min = Math.round(ms / 60000);
			if (min < 1) return "<1m";
			return min >= 60 ? Math.floor(min / 60) + "h" + (min % 60) + "m" : min + "m";
		}

		/** 拉一次台账。 */
		async function fetchWork() {
			const res = await fetch(`${panelBase()}/api/work`, { cache: "no-store" });
			const data = await res.json().catch(() => ({}));
			if (data.error) throw new Error(data.error);
			return data;
		}

		function Card({ item, onClose }) {
			return h("div", { style: S.card },
				h("div", { style: S.state }, `${item.state} · 等:${item.waiting ?? "你"}`),
				h("div", { style: S.sum }, item.summary ?? ""),
				item.advice ? h("div", { style: S.advice }, item.advice) : null,
				item.judgment ? h("div", { style: S.judge }, `★ ${item.judgment}`) : null,
				h("div", { style: { marginTop: 8, textAlign: "right" } },
					h("button", { style: S.btn, onClick: () => onClose(item.id) }, "标记已处理"),
				),
			);
		}

		function Pane() {
			const [data, setData] = react.useState({ pending: [], total: 0 });
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);

			const load = react.useCallback(async () => {
				try {
					setData(await fetchWork());
					setError("");
				} catch (err) {
					setError(String(err?.message ?? err));
				}
			}, []);

			react.useEffect(() => {
				let alive = true;
				const tick = () => { if (alive) load(); };
				tick();
				const timer = setInterval(tick, POLL_MS);
				return () => { alive = false; clearInterval(timer); };
			}, [load]);

			const close = async (id) => {
				setBusy(true);
				try {
					await fetch(`${panelBase()}/api/work/close`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id, note: "侧栏关闭" }),
					});
					await load();
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setBusy(false);
				}
			};

			const pending = data.pending ?? [];
			const running = data.running ?? [];

			return h("div", { style: S.wrap },
				h("div", { style: S.bar },
					h("span", { style: S.count },
						[running.length ? `${running.length} 个在跑` : null, pending.length ? `${pending.length} 项在等你` : null]
							.filter(Boolean).join(" · ") || "没有在跑，也没有待处理项"),
					h("button", { style: S.btn, disabled: busy, onClick: load }, "刷新"),
				),
				error ? h("div", { style: S.err }, `面板不可达：${error}\n（dsh-remote 面板没起？在 ~/.dsh/dsh-remote 里 launchctl kickstart 一下）`) : null,
				h("div", { style: S.list },
					running.length > 0
						? h("div", null,
							h("div", { style: { fontSize: 11, fontWeight: 600, opacity: 0.6, padding: "2px 0 6px" } }, `在跑（${running.length}）`),
							running.map((job) => h("div", { key: job.id, style: { marginBottom: 6 } },
								h("div", { key: "row", style: S.runningCard },
								h("span", { style: job.stalled ? S.dotStalled : S.dot }),
								h("span", { style: S.runningMeta }, humanMs(job.elapsedMs)),
								h("span", { style: S.runningId }, job.id),
									job.stalled
										? h("span", { style: S.stalledTag }, `⚠ ${humanMs(job.quietMs)} 无新输出`)
										: h("span", { style: S.runningMeta }, job.quietMs > 60000 ? `${humanMs(job.quietMs)} 无输出` : "有输出"),
								),
								// 有分母才画条:作业自己报 PROGRESS/epoch 才有,不编假进度
								job.progress
									? h("div", { key: "bar", style: S.barRow },
										h("div", { style: S.barTrack },
											h("div", { style: { ...S.barFill, width: `${job.progress.pct}%` } }),
										),
										h("div", { style: S.pctText }, `${job.progress.done}/${job.progress.total} · ${job.progress.pct}%`),
									)
									: null,
							)),
							h("div", { style: { height: 10 } }),
						)
						: null,
					pending.length === 0
						? h("div", { style: S.empty },
							"这里只显示**需要你动手**的事：\n\n",
							"· 实验失败/跑完（由 dsh-remote/work.mjs 自动写入）\n",
							"· 等你做决定的事\n\n",
							"健康状态不占位置。")
						: pending.map((item) => h(Card, { key: item.id, item, onClose: close })),
				),
			);
		}

		const inject = ["slots", "sidebarRightTabs"];

		function apply(ctx) {
			ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				priority: "extension",
				title: () => "需要你",
				guide: [{
					order: 40,
					title: () => "需要你（工作项）",
					description: () => "实验失败/跑完、等你决定的事 —— 只列需要人动手的，健康态不占位置",
				}],
			});
			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
			}, Pane));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
