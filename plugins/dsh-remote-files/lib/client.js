/**
 * dsh-remote-files —— 浏览器侧插件(手写 bundle,遵循宿主 __ModuleLoader__ 约定)
 *
 * UI 形态:**工作台右侧栏的一个标签页**(不是浮层抽屉)。
 *   · ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide })
 *     —— 官方侧栏留了扩展口子,`priority: 'extension'` 是"产品外部类型"档,最高。
 *   · ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <同一个 id> }, Body)
 *     —— 标签正文注册在同一个 key 下。
 *
 * 数据通道:本机 dsh-remote 面板的 HTTP API(默认 127.0.0.1:4100,CORS 已放行),
 * 由面板经 ssh2/SFTP 就地读写远程文件。机器身份按**当前工作台端口**反查
 * (/api/rw/whoami),所以同一个插件装进任何分区都能对上自己的那台机器。
 *
 * 能力:目录树(懒加载/可展开)、新建文件与文件夹、重命名、删除、拖拽上传、
 *       下载、编辑保存(⌘S);编辑器按扩展名分派:JSON(校验+格式化)、
 *       Markdown(预览/编辑)、CSV(表格)、图片(预览)、Jupyter notebook
 *       (渲染 cells/输出/内嵌图,可切源码)、其余按文本。
 */
window.__ModuleLoader__.load({
	id: "dsh-remote-files",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/** 面板默认端口;可用 localStorage["dshRemotePanel"] 覆盖。 */
		const panelBase = () => localStorage.getItem("dshRemotePanel") || "http://127.0.0.1:4100";
		// 每个请求都带上本工作台的端口 —— 面板据此在**服务端**算出访问范围
		// (本工作台登记的工作区),客户端说不了算,也不会退化成整台机器。
		const WS_PORT = Number(location.port || 80);
		const SCOPE = `port=${WS_PORT}`;
		const TAB_ID = "dsh-remote-files";
		const TAB_KIND = "dsh-remote-files";

		/* ------------------------------------------------------------------ 样式 --- */
		const CSS = `
.drf{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.drf-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.drf-title{font-weight:600;font-size:13px}
.drf-scope{font-size:10px;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:help;white-space:nowrap}
.drf-crumb{flex:1;display:flex;gap:2px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,Menlo,monospace);overflow:hidden}
.drf-crumb a{color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:none}
.drf-bar{display:flex;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.drf-btn{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;border-radius:7px;padding:4px 9px;white-space:nowrap}
.drf-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.drf-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
.drf-btn:disabled{opacity:.45;cursor:default}
.drf-tree{flex:1 1 42%;min-height:90px;overflow:auto;padding:4px 0}
.drf-tree.drag{outline:2px dashed var(--dsw-alias-state-business-primary);outline-offset:-3px}
.drf-row{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;border-radius:6px;white-space:nowrap}
.drf-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.drf-row[data-sel=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}
.drf-caret{width:11px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.drf-nm{flex:1;overflow:hidden;text-overflow:ellipsis;font-family:var(--ds-font-family-code,Menlo,monospace)}
.drf-mt{color:var(--dsw-alias-label-tertiary);font-size:10px}
.drf-acts{display:none;gap:3px}
.drf-row:hover .drf-acts{display:flex}
.drf-acts button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:11px;opacity:.6;padding:1px 3px}
.drf-acts button:hover{opacity:1}
.drf-editor{flex:1 1 58%;display:flex;flex-direction:column;min-height:0;border-top:.5px solid var(--dsw-alias-border-l2)}
.drf-ehead{display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.drf-ehead .sp{flex:1}
.drf-ta{flex:1;min-height:120px;border:0;outline:none;resize:none;background:transparent;color:var(--dsw-alias-label-primary);
  font-family:var(--ds-font-family-code,Menlo,monospace);font-size:12.5px;line-height:1.55;padding:8px 10px;white-space:pre;tab-size:4}
.drf-prev{flex:1;overflow:auto;padding:8px 12px;font-size:13px;line-height:1.65}
.drf-prev pre{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;overflow:auto;font-size:11.5px}
.drf-prev img,.drf-img{max-width:100%}
.drf-cell{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;margin-bottom:8px;overflow:hidden}
.drf-cell .tag{font-size:10px;color:var(--dsw-alias-label-tertiary);padding:2px 8px;background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.drf-cell pre{margin:0;border:0;border-radius:0}
.drf-out{border-top:.5px dashed var(--dsw-alias-border-l2)}
.drf-tbl{border-collapse:collapse;font-size:11px;width:100%}
.drf-tbl th,.drf-tbl td{border:.5px solid var(--dsw-alias-border-l2);padding:2px 5px;text-align:left}
.drf-msg{padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l2);min-height:18px}
.drf-err{color:var(--dsw-alias-state-error-primary,#e5484d)}
.drf-warn{color:var(--dsw-alias-state-warning-primary,#f5a524)}
.drf-empty{color:var(--dsw-alias-label-tertiary);padding:10px 12px;font-size:12px}
`;
		function injectCss() {
			if (document.querySelector('style[data-plugin-css="dsh-remote-files"]')) return;
			const el = document.createElement("style");
			el.dataset.pluginCss = "dsh-remote-files";
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		/* ---------------------------------------------------------------- 数据层 --- */
		function qs(obj) {
			return Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
		}
		async function api(path, opts) {
			const r = await fetch(panelBase() + path, opts);
			const j = await r.json().catch(() => ({}));
			if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
			return j;
		}
		const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const join = (dir, name) => `${dir === "/" ? "" : dir.replace(/\/$/, "")}/${name}`;
		function parent(p) { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); }
		function fmtSize(n) {
			if (n == null || n === 0) return n === 0 ? "0" : "";
			const u = ["B", "K", "M", "G", "T"]; let i = 0; let v = n;
			while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1 }
			return `${i === 0 ? v : v.toFixed(1)}${u[i]}`;
		}
		const isImg = (n) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(n);
		const isNb = (n) => /\.ipynb$/i.test(n);
		const isJson = (n) => /\.(json|geojson)$/i.test(n);
		const isMd = (n) => /\.(md|markdown)$/i.test(n);
		const isCsv = (n) => /\.(csv|tsv)$/i.test(n);
		const dlUrl = (path) => `${panelBase()}/api/rw/download?${SCOPE}&${qs({ path })}`;

		function mdToHtml(src) {
			let s = String(src).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
			const blocks = [];
			s = s.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, c) => { blocks.push(c); return `\u0000${blocks.length - 1}\u0000` });
			s = s.replace(/^###### (.*)$/gm, "<h6>$1</h6>").replace(/^##### (.*)$/gm, "<h5>$1</h5>")
				.replace(/^#### (.*)$/gm, "<h4>$1</h4>").replace(/^### (.*)$/gm, "<h3>$1</h3>")
				.replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>");
			s = s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
				.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
			s = s.replace(/^(?:- |\* )(.*)$/gm, "<li>$1</li>").replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
			s = s.split(/\n{2,}/).map((p) => (/^\s*<(h\d|ul|pre)/.test(p) ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`)).join("");
			return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${blocks[+i].replace(/^\n/, "")}</pre>`);
		}

		/* ---------------------------------------------------------------- 组件 --- */
		function Icon({ children }) { return h("span", { className: "ico" }, children) }

		function Pane() {
			const [machine, setMachine] = react.useState(null);   // whoami 的 machine:{name,label,scope,roots,titles,note}
			const [roots, setRoots] = react.useState([]);         // 允许访问的根(服务端按端口算出,最窄 = 本工作台的工作区)
			const [titles, setTitles] = react.useState({});
			const [err, setErr] = react.useState("");
			const [msg, setMsg] = react.useState("");
			const [kids, setKids] = react.useState({});     // path → entries[]
			const [open, setOpen] = react.useState({});
			const [dir, setDir] = react.useState("");       // 新建/上传落点
			const [sel, setSel] = react.useState(null);     // 选中的文件路径
			const [file, setFile] = react.useState(null);   // {name,path,text,original,size,binary}
			const [prev, setPrev] = react.useState(false);  // markdown 预览开关
			const [busy, setBusy] = react.useState(false);
			const [rev, setRev] = react.useState(0);        // 缓存变更计数(强制重渲染)
			const upRef = react.useRef(null);
			const dragRef = react.useRef(null);

			react.useEffect(() => {
				let alive = true;
				api(`/api/rw/whoami?port=${WS_PORT}`)
					.then((r) => {
						if (!alive) return;
						if (!r.machine) { setErr(r.error || "这个端口没有对应的机器(先在 dsh-remote 面板里登记)"); return }
						setMachine(r.machine);
						const rs = r.machine.roots || [];
						setRoots(rs);
						setTitles(r.machine.titles || {});
						if (!rs.length) { setErr(r.machine.note || "这个工作台还没登记工作区,没有可访问的范围"); return }
						setDir(rs[0]);
						setOpen({ [rs[0]]: true });
						return load(rs[0]);
					})
					.catch((e) => alive && setErr(`连不上面板 ${panelBase()}:${e.message}`));
				return () => { alive = false };
			}, []);

			async function load(path) {
				const j = await api(`/api/rw/list?${SCOPE}&${qs({ path })}`);
				const entries = j.entries || [];
				setKids((k) => ({ ...k, [path]: entries }));
				setRev((r) => r + 1);
				return entries;
			}
			function toast(text, cls = "") { setMsg({ text, cls }) }

			async function toggle(path) {
				setDir(path);
				if (open[path]) { setOpen((o) => ({ ...o, [path]: false })); return }
				setOpen((o) => ({ ...o, [path]: true }));
				if (!kids[path]) { try { await load(path) } catch (e) { setErr(e.message) } }
			}
			async function openFile(path, name) {
				setSel(path); setDir(parent(path)); setPrev(false); setBusy(true);
				try {
					if (isImg(name)) { setFile({ name, path, kind: "image" }); return }
					const j = await api(`/api/rw/read?${SCOPE}&${qs({ path })}`);
					if (j.binary) { setFile({ name, path, kind: "binary", size: j.size }); return }
					setFile({ name, path, kind: "text", text: j.text, original: j.text, size: j.size });
				} catch (e) { setErr(e.message) } finally { setBusy(false) }
			}
			async function save() {
				if (!file || file.kind !== "text") return;
				setBusy(true);
				try {
					await post("/api/rw/write", { port: WS_PORT, path: file.path, text: file.text });
					setFile({ ...file, original: file.text });
					toast(`✓ 已保存 ${file.path}`);
					load(parent(file.path));
				} catch (e) { setErr(`保存失败: ${e.message}`) } finally { setBusy(false) }
			}
			async function uploadTo(targetDir, files) {
				const list = Array.from(files || []);
				if (!list.length) return;
				setBusy(true);
				try {
					for (const f of list) {
						const dest = join(targetDir, f.name);
						toast(`⬆ 上传 ${f.name}(${fmtSize(f.size)})…`);
						const r = await fetch(`${panelBase()}/api/rw/upload?${SCOPE}&${qs({ path: dest })}`, { method: "POST", body: f });
						const j = await r.json().catch(() => ({}));
						if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
						toast(`✓ 已上传 ${dest}(${fmtSize(j.bytes)})`);
					}
					await load(targetDir);
				} catch (e) { setErr(`上传失败: ${e.message}`) } finally { setBusy(false) }
			}
			function download(path) {
				const a = document.createElement("a");
				a.href = dlUrl(path);
				a.download = path.split("/").pop() || "";
				document.body.appendChild(a); a.click(); a.remove();
				toast(`⬇ 开始下载 ${path}`);
			}
			async function newFile() {
				const name = prompt(`在 ${dir} 下新建文件名`);
				if (!name) return;
				try { await post("/api/rw/write", { port: WS_PORT, path: join(dir, name), text: "" }); await load(dir); openFile(join(dir, name), name) }
				catch (e) { setErr(e.message) }
			}
			async function newDir() {
				const name = prompt(`在 ${dir} 下新建文件夹名`);
				if (!name) return;
				try { await post("/api/rw/mkdir", { port: WS_PORT, path: join(dir, name) }); await load(dir); setOpen((o) => ({ ...o, [dir]: true })) }
				catch (e) { setErr(e.message) }
			}
			async function rename(path) {
				const name = path.split("/").pop();
				const to = prompt(`重命名 ${name} →`, name);
				if (!to || to === name) return;
				try { await post("/api/rw/mv", { port: WS_PORT, from: path, to: join(parent(path), to) }); delete kids[parent(path)]; await load(parent(path)) }
				catch (e) { setErr(e.message) }
			}
			async function del(path, isDir) {
				if (!confirm(`删除 ${path}${isDir ? "(目录,递归)" : ""}?`)) return;
				try {
					await post("/api/rw/rm", { port: WS_PORT, path, recursive: isDir });
					if (sel === path) { setSel(null); setFile(null) }
					delete kids[parent(path)]; await load(parent(path));
				} catch (e) { setErr(e.message) }
			}

			/* ---- 渲染:树 ---- */
			// 顶层不是 "/" 而是**服务端给的范围根**(本工作台登记的工作区)。
			// 树只在范围之内展开;越界的路径服务端一律 403,这里根本走不到。
			function node(entry, parentPath, depth, isRoot) {
				const path = isRoot ? entry.path : join(parentPath, entry.name);
				const isDir = isRoot ? true : entry.dir;
				const label = isRoot ? (titles[path] || path.split("/").filter(Boolean).pop() || path) : entry.name;
				const expanded = isDir && open[path];
				const caret = isDir ? (expanded ? "▾" : "▸") : "";
				const ico = isRoot ? "🏠" : isDir ? "📁" : isImg(entry.name) ? "🖼" : isNb(entry.name) ? "📓" : "📄";
				const row = h("div", {
					key: path,
					className: "drf-row",
					"data-sel": sel === path,
					style: { paddingLeft: `${4 + depth * 12}px` },
					draggable: !isDir,
					onClick: () => (isDir ? toggle(path) : openFile(path, entry.name)),
					onDragStart: (e) => e.dataTransfer.setData("text/drf-move", path),
					onDragOver: isDir ? (e) => { e.preventDefault(); e.currentTarget.classList.add("drag") } : undefined,
					onDragLeave: isDir ? (e) => e.currentTarget.classList.remove("drag") : undefined,
					onDrop: isDir ? async (e) => {
						e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("drag");
						const files = e.dataTransfer.files;
						if (files && files.length) { setOpen((o) => ({ ...o, [path]: true })); return uploadTo(path, files) }
						const from = e.dataTransfer.getData("text/drf-move");
						if (from && parent(from) !== path) { try { await post("/api/rw/mv", { port: WS_PORT, from, to: join(path, from.split("/").pop()) }); delete kids[parent(from)]; delete kids[path]; await load(path) } catch (er) { setErr(er.message) } }
					} : undefined,
				},
					h("span", { className: "drf-caret" }, caret),
					h("span", {}, ico),
					h("span", { className: "drf-nm", title: isRoot ? path : undefined }, label),
					h("span", { className: "drf-mt" }, isDir ? "" : `${fmtSize(entry.size)}`),
					h("span", { className: "drf-acts" },
						isDir ? null : h("button", { title: "下载", onClick: (e) => { e.stopPropagation(); download(path) } }, "⬇"),
						// 范围根不给重命名/删除:服务端也会拒,不如一开始就不摆出来
						isRoot ? null : h("button", { title: "重命名", onClick: (e) => { e.stopPropagation(); rename(path) } }, "✏️"),
						isRoot ? null : h("button", { title: "删除", onClick: (e) => { e.stopPropagation(); del(path, isDir) } }, "🗑"),
					),
				);
				const box = [row];
				if (expanded) {
					const items = kids[path];
					if (!items) box.push(h("div", { key: `${path}:loading`, className: "drf-empty" }, "读取中…"));
					else if (!items.length) box.push(h("div", { key: `${path}:empty`, className: "drf-empty" }, "空目录 —— 拖文件进来即可上传"));
					else {
						for (const it of items.slice(0, 500)) box.push(node(it, path, depth + 1, false));
						if (items.length > 500) box.push(h("div", { key: `${path}:more`, className: "drf-empty" }, `…还有 ${items.length - 500} 项`));
					}
				}
				return h(react.Fragment, { key: `${path}:frag` }, box);
			}

			/* ---- 渲染:编辑器 / 预览 ---- */
			function editor() {
				if (!file) return h("div", { className: "drf-empty" }, "← 点一个文件查看/编辑;拖文件进树里上传");
				if (file.kind === "image") return h("div", { className: "drf-prev" }, h("img", { className: "drf-img", src: dlUrl(file.path), alt: file.name }));
				if (file.kind === "binary") return h("div", { className: "drf-empty" }, `二进制文件(${fmtSize(file.size)}),点右上角下载`);
				const dirty = file.text !== file.original;
				const head = h("div", { className: "drf-ehead" },
					h("b", {}, file.name),
					h("span", {}, dirty ? "● 未保存" : ""),
					h("span", { className: "sp" }),
					isJson(file.name) ? h("button", { className: "drf-btn", onClick: () => {
						try { setFile({ ...file, text: `${JSON.stringify(JSON.parse(file.text), null, 2)}\n` }); toast("已格式化(未保存)", "drf-warn") }
						catch (e) { setErr(`JSON 不合法: ${e.message}`) }
					} }, "格式化") : null,
					isMd(file.name) ? h("button", { className: "drf-btn", onClick: () => setPrev(!prev) }, prev ? "编辑" : "预览") : null,
					isNb(file.name) ? h("button", { className: "drf-btn", onClick: () => setPrev(!prev) }, prev ? "源码" : "notebook") : null,
					isCsv(file.name) ? h("button", { className: "drf-btn", onClick: () => setPrev(!prev) }, prev ? "源码" : "表格") : null,
					h("button", { className: "drf-btn", onClick: () => download(file.path) }, "⬇"),
					h("button", { className: "drf-btn", "data-primary": true, disabled: busy, onClick: save }, "💾 保存"),
				);
				let body;
				if (prev && isMd(file.name)) {
					body = h("div", { className: "drf-prev", dangerouslySetInnerHTML: { __html: mdToHtml(file.text) } });
				} else if (prev && isNb(file.name)) {
					body = h("div", { className: "drf-prev" }, notebookBody(file));
				} else if (prev && isCsv(file.name)) {
					body = h("div", { className: "drf-prev" }, tableBody(file));
				} else {
					body = h("textarea", {
						className: "drf-ta", spellCheck: false, value: file.text,
						onChange: (e) => setFile({ ...file, text: e.target.value }),
						onKeyDown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save() } },
					});
				}
				const state = isJson(file.name) ? (() => { try { JSON.parse(file.text); return h("span", {}, "✓ JSON") } catch (e) { return h("span", { className: "drf-err" }, `✗ ${e.message}`) } })() : null;
				return [head, state ? h("div", { className: "drf-ehead" }, state) : null, body];
			}
			function notebookBody(f) {
				let nb; try { nb = JSON.parse(f.text) } catch (e) { return h("div", { className: "drf-err" }, `解析失败: ${e.message}`) }
				return (nb.cells || []).map((c, i) => {
					const raw = Array.isArray(c.source) ? c.source.join("") : String(c.source ?? "");
					const isM = c.cell_type === "markdown";
					const outs = (c.outputs || []).map((o, j) => {
						const d = o.data || {};
						const pick = (k) => { const v = d[k]; return v == null ? null : (Array.isArray(v) ? v.join("") : String(v)) };
						const img = pick("image/png") || pick("image/jpeg");
						const txt = o.text ? (Array.isArray(o.text) ? o.text.join("") : String(o.text)) : pick("text/plain");
						if (img) return h("div", { className: "drf-out", key: j }, h("img", { className: "drf-img", src: `data:image/png;base64,${img}` }));
						if (txt && txt.trim()) return h("div", { className: "drf-out", key: j }, h("pre", {}, txt));
						return null;
					});
					return h("div", { className: "drf-cell", key: i },
						h("div", { className: "tag" }, `${isM ? "markdown" : c.cell_type} #${i + 1}`),
						isM ? h("div", { className: "drf-prev", dangerouslySetInnerHTML: { __html: mdToHtml(raw) } }) : h("pre", {}, raw),
						outs,
					);
				});
			}
			function tableBody(f) {
				const sep = /\.tsv$/i.test(f.name) ? "\t" : ",";
				const rows = f.text.split(/\r?\n/).filter(Boolean).slice(0, 300);
				const head = (rows[0] || "").split(sep);
				return h("table", { className: "drf-tbl" },
					h("thead", {}, h("tr", {}, head.map((x, i) => h("th", { key: i }, x)))),
					h("tbody", {}, rows.slice(1).map((r, i) => h("tr", { key: i }, r.split(sep).map((c, j) => h("td", { key: j }, c))))),
				);
			}

			// 面包屑从**所在范围根**起算 —— 根之上没有可达路径,所以不显示"/"
			const homeRoot = roots.filter((r) => dir === r || dir.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] || roots[0] || "";
			const crumbs = (() => {
				if (!homeRoot) return [];
				const rel = dir === homeRoot ? "" : dir.slice(homeRoot.length + 1);
				const out = [h("a", { key: homeRoot, title: homeRoot, onClick: () => setDir(homeRoot) },
					`🏠 ${titles[homeRoot] || homeRoot.split("/").filter(Boolean).pop() || homeRoot}`)];
				let acc = homeRoot;
				for (const p of rel.split("/").filter(Boolean)) {
					acc += `/${p}`;
					const target = acc;
					out.push(h("span", { key: `${target}:s` }, "›"), h("a", { key: target, onClick: () => setDir(target) }, p));
				}
				return out;
			})();
			const scoped = machine && machine.scope === "workspace";

			return h("div", { className: "drf" },
				h("div", { className: "drf-head" },
					h("span", { className: "drf-title" }, `📁 ${machine ? (machine.label || machine.name) : "远程文件"}`),
					machine ? h("span", {
						className: "drf-scope",
						title: scoped
							? `只能访问本工作台登记的工作区:\n${roots.join("\n")}`
							: `只能访问该机器的挂载根:\n${roots.join("\n")}`,
					}, scoped ? `🔒 仅工作区 ×${roots.length}` : "🔓 挂载根") : null,
					h("span", { className: "drf-crumb" }, crumbs),
				),
				h("div", { className: "drf-bar" },
					h("button", { className: "drf-btn", onClick: () => { setKids({}); roots.forEach((r) => load(r).catch(() => null)) } }, "🔄 刷新"),
					h("button", { className: "drf-btn", disabled: !roots.length, onClick: newFile }, "📄 新建文件"),
					h("button", { className: "drf-btn", disabled: !roots.length, onClick: newDir }, "📁 新建文件夹"),
					h("button", { className: "drf-btn", "data-primary": true, disabled: !roots.length, onClick: () => upRef.current && upRef.current.click() }, "⬆ 上传"),
					h("input", { ref: upRef, type: "file", multiple: true, style: { display: "none" }, onChange: (e) => { uploadTo(dir, e.target.files); e.target.value = "" } }),
				),
				h("div", {
					className: "drf-tree",
					onDragOver: (e) => { e.preventDefault(); dragRef.current = true; e.currentTarget.classList.add("drag") },
					onDragLeave: (e) => { e.currentTarget.classList.remove("drag") },
					onDrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("drag"); if (e.dataTransfer.files && e.dataTransfer.files.length) uploadTo(dir, e.dataTransfer.files) },
				}, machine
					? (roots.length
						? roots.map((r) => node({ path: r, name: r, dir: true, size: 0 }, "", 0, true))
						: h("div", { className: "drf-empty" }, err || "这个工作台没有可访问的工作区"))
					: h("div", { className: "drf-empty" }, err || "正在解析这台工作台的机器…")),
				h("div", { className: "drf-editor" }, editor()),
				h("div", { className: `drf-msg ${msg && msg.cls ? msg.cls : ""}` }, err ? h("span", { className: "drf-err" }, err) : (msg ? msg.text : "")),
			);
		}

		/* -------------------------------------------------------------- 注册 --- */
		const inject = ["slots", "sidebarRightTabs"];
		function apply(ctx) {
			injectCss();
			ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				priority: "extension",
				title: () => "文件(仅工作区)",
				guide: [{
					order: 30,
					title: () => "远程文件(仅工作区)",
					description: () => "浏览 / 编辑 / 上传 / 下载 —— 只能碰本工作台登记的工作区",
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
