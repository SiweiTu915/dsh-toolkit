/**
 * dsh-remote-ui — 浏览器侧插件(手写 bundle,遵循宿主 __ModuleLoader__ 约定)
 *
 * UI 形态:工作台侧边栏底部一个「📁 远程文件」按钮;点开在**右侧滑出抽拉栏**,
 *          在里面浏览 / 查看 / 编辑 / 增删远程文件。
 * 数据来源:本机 dsh-remote 面板的 HTTP API(127.0.0.1:4100),底层 ssh2 + SFTP,
 *          就地读写,不把远程文件拉到本机。
 *
 * 挂载点说明:
 *   · sidebar.footer.action —— kind:list,放开关按钮
 *   · shell.overlay        —— kind:list,放抽拉栏本体(覆盖层,右侧固定定位)
 *   (details 槽是 kind:single 且已被 chat 占用,不能用来放抽屉。)
 *
 * 注意(踩过的坑):这里导出的 `inject` 是 **cordis 运行时服务名**,不是包名;
 * 包名写在 package.json 的 `dsh.client.inject` 里,两者语义不同。
 */
window.__ModuleLoader__.load({
	id: "dsh-remote-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region 样式(全部用 --dsw-alias-* 变量,自动跟随工作台主题)
		const css = `
.dru-btn{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:6px 12px}
.dru-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dru-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
.dru-btn[data-primary=true]:disabled{opacity:.45;cursor:default}
.dru-trigger{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:7px 10px;text-align:left}
.dru-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dru-trigger[data-open=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dru-trigger .dru-ico{font-size:15px;line-height:1}
.dru-trigger .dru-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dru-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:60}
.dru-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);z-index:61;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));border-left:.5px solid var(--dsw-alias-border-l2);
  box-shadow:-16px 0 40px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:13px}
.dru-dhead{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dru-dtitle{flex:1;font-size:14px;font-weight:600}
.dru-body{flex:1;display:flex;flex-direction:column;gap:10px;padding:12px 14px;overflow:auto}
.dru-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dru-bar select,.dru-bar input{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;outline:none;max-width:100%}
.dru-bar input{flex:1;min-width:170px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}
.dru-bound{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dru-crumb{font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,Menlo,monospace);display:flex;gap:4px;flex-wrap:wrap}
.dru-crumb a{color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:none}
.dru-list,.dru-editor{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}
.dru-list{max-height:36vh;overflow:auto}
.dru-row{display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:13px;cursor:pointer;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dru-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dru-row[data-active=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.dru-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,Menlo,monospace)}
.dru-sz{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dru-del{opacity:.35;background:none;border:0;cursor:pointer;color:inherit}
.dru-row:hover .dru-del{opacity:1}
.dru-ehead{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px}
.dru-ehead .dru-pth{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,Menlo,monospace)}
.dru-ta{width:100%;min-height:24vh;border:0;outline:none;resize:vertical;background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,Menlo,monospace);font-size:13px;line-height:1.55;padding:10px;box-sizing:border-box}
.dru-msg{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dru-err{font-size:12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
`;
		const tagId = "dsh-remote-ui/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-remote-ui";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		const API = "http://127.0.0.1:4100";
		const DEFAULT_PATH = "/root";
		const h = react.createElement;

		async function api(path, opts) {
			const res = await fetch(API + path, opts);
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
			return data;
		}
		function humanSize(n) {
			const u = ["B", "K", "M", "G", "T"];
			let i = 0, v = Number(n) || 0;
			while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
			return v.toFixed(v < 10 && i > 0 ? 1 : 0) + u[i];
		}
		const join = (base, name) => (base.endsWith("/") ? base : base + "/") + name;

		// ── 工作台绑定:按端口认领机器;未绑定(如主工作台 / 面板)则整个 UI 不渲染 ──
		let bindingPromise = null;
		function resolveBinding() {
			if (bindingPromise === null) {
				const port = Number(window.location.port || 0);
				bindingPromise = api("/api/rw/whoami?port=" + port)
					.then((r) => r.machine || null)
					.catch(() => null);
			}
			return bindingPromise;
		}
		function useBinding() {
			const [machine, setMachine] = react.useState(undefined); // undefined=解析中, null=未绑定
			react.useEffect(() => {
				let alive = true;
				resolveBinding().then((m) => { if (alive) setMachine(m) });
				return () => { alive = false };
			}, []);
			return machine;
		}

		// ── 抽拉栏开关:同一模块内的极简订阅(按钮与抽屉共享状态) ─────────────
		const drawer = { open: false, listeners: new Set() };
		function setDrawerOpen(next) {
			drawer.open = next;
			for (const l of [...drawer.listeners]) l(next);
		}
		function useDrawerOpen() {
			const [open, setOpen] = react.useState(drawer.open);
			react.useEffect(() => {
				const l = (v) => setOpen(v);
				drawer.listeners.add(l);
				return () => { drawer.listeners.delete(l) };
			}, []);
			return open;
		}

		// ── 侧边栏底部按钮 ────────────────────────────────────────────────────
		function RemoteFilesTrigger(props) {
			const open = useDrawerOpen();
			const binding = useBinding();
			if (binding === null) return null;          // 未绑定服务器的普通工作台:不出现入口
			if (binding === undefined) return null;     // 解析中:先不占位
			const wide = !(props && props.wide === false);
			return h("button", {
				className: "dru-trigger", title: "远程文件(打开右侧抽拉栏)",
				"data-open": open ? "true" : "false",
				onClick: () => setDrawerOpen(!drawer.open),
			}, [
				h("span", { key: "i", className: "dru-ico" }, "📁"),
				wide ? h("span", { key: "l", className: "dru-lbl" }, "远程文件") : null,
			]);
		}

		// ── 文件浏览器主体(在抽拉栏内) ───────────────────────────────────────
		function RemoteFilesPanel() {
			const [machines, setMachines] = react.useState([]);
			const [bound, setBound] = react.useState(null);
			const [machine, setMachine] = react.useState("");
			const [path, setPath] = react.useState(DEFAULT_PATH);
			const [pathInput, setPathInput] = react.useState(DEFAULT_PATH);
			const [entries, setEntries] = react.useState([]);
			const [info, setInfo] = react.useState("");
			const [err, setErr] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [file, setFile] = react.useState(null);
			const [text, setText] = react.useState("");
			const [dirty, setDirty] = react.useState(false);

			async function load(m, p) {
				setErr(""); setBusy(true);
				try {
					const r = await api("/api/rw/list?name=" + encodeURIComponent(m) + "&path=" + encodeURIComponent(p));
					setEntries(r.entries || []); setPath(r.path); setPathInput(r.path);
					setInfo((r.entries || []).length + " 项");
				} catch (e) { setErr(String(e.message || e)); setEntries([]) }
				finally { setBusy(false) }
			}

			react.useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const m = await resolveBinding();   // 与入口按钮同一份绑定结果
						if (cancelled) return;
						if (!m) { setErr("这个工作台没有绑定到服务器"); return; }
						setBound(m); setMachine(m.name);
						await load(m.name, m.defaultPath || "/root");
					} catch (e) {
						if (!cancelled) setErr("连不上本机 dsh-remote 面板(127.0.0.1:4100)。终端里可跑:\nnode ~/.dsh/dsh-remote/panel.mjs\n\n" + String(e.message || e));
					}
				})();
				return () => { cancelled = true };
			}, []);

			async function openEntry(full, name) {
				setErr("");
				try {
					const r = await api("/api/rw/read?name=" + encodeURIComponent(machine) + "&path=" + encodeURIComponent(full));
					setFile({ path: full, name, size: r.size, binary: r.binary, note: r.note });
					setText(r.text || "");
					setDirty(false);
				} catch (e) { setErr("打开失败:" + String(e.message || e)) }
			}

			async function save() {
				if (!file) return;
				setErr("");
				try {
					const r = await api("/api/rw/write", {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: machine, path: file.path, text }),
					});
					setDirty(false);
					setInfo((r.existed ? "已保存 " : "已创建 ") + file.path);
					await load(machine, path);
				} catch (e) { setErr("保存失败:" + String(e.message || e)) }
			}

			async function removeEntry(full, isDir) {
				if (!window.confirm("删除远程" + (isDir ? "目录(含内容)" : "文件") + "\n" + full + "\n\n不可撤销,确认?")) return;
				setErr("");
				try {
					await api("/api/rw/rm", {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: machine, path: full, recursive: isDir }),
					});
					setInfo("已删除 " + full);
					await load(machine, path);
				} catch (e) { setErr("删除失败:" + String(e.message || e)) }
			}

			async function newEntry(kind) {
				const name = window.prompt(kind === "dir" ? "新建目录名:" : "新建文件名(如 train.py):");
				if (!name) return;
				const full = join(path, name);
				try {
					if (kind === "dir") {
						await api("/api/rw/mkdir", { method: "POST", headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ name: machine, path: full }) });
					} else {
						await api("/api/rw/write", { method: "POST", headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ name: machine, path: full, text: "" }) });
					}
					await load(machine, path);
					if (kind !== "dir") await openEntry(full, name);
				} catch (e) { setErr("创建失败:" + String(e.message || e)) }
			}

			const crumbs = [];
			{
				let acc = "";
				crumbs.push(h("a", { key: "root", onClick: () => load(machine, "/") }, "/"));
				for (const seg of path.split("/").filter(Boolean)) {
					acc += "/" + seg;
					const target = acc;
					crumbs.push(h("span", { key: target + "s" }, " / "));
					crumbs.push(h("a", { key: target, onClick: () => load(machine, target) }, seg));
				}
			}

			return h("div", { className: "dru-body" }, [
				h("div", { key: "bar", className: "dru-bar" }, [
					bound
						? h("span", { key: "m", className: "dru-bound", title: bound.user + "@" + bound.host },
							"📡 " + bound.label + " · " + bound.user + "@" + bound.host)
						: h("select", {
							key: "m", value: machine,
							onChange: (e) => { const m = e.target.value; setMachine(m); load(m, path) },
						}, machines.map((m) => h("option", { key: m.name, value: m.name }, m.label + " · " + m.user + "@" + m.host))),
					h("input", {
						key: "p", value: pathInput, spellCheck: false,
						onChange: (e) => setPathInput(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") load(machine, pathInput) },
					}),
					h("button", { key: "go", className: "dru-btn", onClick: () => load(machine, pathInput) }, "前往"),
					h("button", { key: "up", className: "dru-btn", title: "上一级", onClick: () => load(machine, path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/") }, "⬆"),
					h("button", { key: "rf", className: "dru-btn", title: "刷新", onClick: () => load(machine, path) }, "🔄"),
					h("button", { key: "nf", className: "dru-btn", title: "新建文件", onClick: () => newEntry("file") }, "📄+"),
					h("button", { key: "nd", className: "dru-btn", title: "新建目录", onClick: () => newEntry("dir") }, "📁+"),
				]),
				h("div", { key: "crumb", className: "dru-crumb" }, crumbs),
				err ? h("div", { key: "err", className: "dru-err" }, err) : null,
				h("div", { key: "list", className: "dru-list" },
					busy && !entries.length
						? [h("div", { key: "loading", className: "dru-row" }, "加载中…")]
						: entries.length === 0
							? [h("div", { key: "empty", className: "dru-row" }, "(空目录)")]
							: entries.map((e) => {
								const full = join(path, e.name);
								const pick = () => e.dir ? load(machine, full) : openEntry(full, e.name);
								return h("div", {
									key: e.name, className: "dru-row",
									"data-active": file && file.path === full ? "true" : "false",
								}, [
									h("span", { key: "i", style: { cursor: "pointer" }, onClick: pick }, e.dir ? "📁" : "📄"),
									h("span", { key: "n", className: "dru-nm", title: e.name, onClick: pick }, e.name),
									h("span", { key: "s", className: "dru-sz" }, e.dir ? "" : humanSize(e.size)),
									h("button", {
										key: "d", className: "dru-del", title: "删除",
										onClick: (ev) => { ev.stopPropagation(); removeEntry(full, e.dir) },
									}, "🗑"),
								]);
							})),
				h("div", { key: "editor", className: "dru-editor" }, [
					h("div", { key: "head", className: "dru-ehead" }, [
						h("span", { key: "p", className: "dru-pth" }, file ? file.path : "未打开文件"),
						h("button", {
							key: "s", className: "dru-btn", "data-primary": "true",
							disabled: !file || !dirty, onClick: save,
						}, dirty ? "💾 保存*" : "💾 保存"),
					]),
					h("textarea", {
						key: "ta", className: "dru-ta", value: text, spellCheck: false,
						placeholder: file ? (file.binary ? "二进制文件,不显示内容" : "") : "点上方文件查看 / 编辑;⌘S 保存",
						onChange: (e) => { setText(e.target.value); setDirty(true) },
						onKeyDown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save() } },
					}),
				]),
				h("div", { key: "msg", className: "dru-msg" },
					info + (file && file.size !== undefined ? " · 当前文件 " + humanSize(file.size) + (file.binary ? "(二进制)" : "") : "")),
			]);
		}

		// ── 抽拉栏外壳(覆盖层里) ─────────────────────────────────────────────
		function RemoteFilesDrawer() {
			const open = useDrawerOpen();
			const binding = useBinding();
			if (!open) return null;
			if (binding === null || binding === undefined) return null;
			react.useEffect(() => {
				if (!open) return;
				const onKey = (e) => { if (e.key === "Escape") setDrawerOpen(false) };
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open]);
			if (!open) return null;
			return h("div", null, [
				h("div", { key: "bd", className: "dru-backdrop", onClick: () => setDrawerOpen(false) }),
				h("aside", { key: "dw", className: "dru-drawer" }, [
					h("div", { key: "hd", className: "dru-dhead" }, [
						h("span", { key: "t", className: "dru-dtitle" }, "📁 远程文件"),
						h("button", { key: "c", className: "dru-btn", onClick: () => setDrawerOpen(false), title: "关闭 (Esc)" }, "✕"),
					]),
					h(RemoteFilesPanel, { key: "body" }),
				]),
			]);
		}

		// cordis 纤维注入表写的是"运行时服务名"(slots 由 dsh-client-ui-renderer 提供),
		// 不是 package.json 里 dsh.client.inject 的包名 —— 后者只管模块图装载顺序。
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "remote-files",
				order: 40,
			}, RemoteFilesTrigger));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "remote-files-drawer",
				order: 40,
			}, RemoteFilesDrawer));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
