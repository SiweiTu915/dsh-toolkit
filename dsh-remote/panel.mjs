#!/usr/bin/env node
/**
 * dsh-remote 控制面板 — 本地管理所有远程 DSH 服务器的 Web 页面
 *
 * 启动: node panel.mjs [--port 4100]
 * 打开: http://127.0.0.1:4100
 *
 * 页面提供: 服务器清单 / 一键建隧道 / 一键打开窗口 / 状态探测 / 添加删除
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, openSync, closeSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect as sftpConnect } from "./lib/sftp.mjs";
import { resolveConn, DSH_HOME } from "./lib/hosts.mjs";
import { readWorkbenchRoots, machineRoots, fencePath, describeScope } from "./lib/scope.mjs";
import { createWorkbench, planWorkbench, rollbackWorkbench, pickFreePort } from "./workbench.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.DSH_REMOTE_CONFIG
  ? join(ROOT, process.env.DSH_REMOTE_CONFIG)
  : join(ROOT, "servers.json");
const STATE_DIR = join(ROOT, ".state");
const PIDS_FILE = join(STATE_DIR, "tunnels.json");

const PANEL_PORT = Number(process.argv.find((a, i) => process.argv[i - 1] === "--port") ?? 4100);

// ── 远程文件浏览:SFTP 连接缓存(60 秒空闲自动断开) ──────────────────────
const fileConns = new Map(); // 机器名 → { conn, timer }

function dropFileConn(name) {
  const c = fileConns.get(name);
  if (!c) return;
  clearTimeout(c.timer);
  try { c.conn.end(); } catch { /* ignore */ }
  fileConns.delete(name);
}

async function getFileConn(name) {
  const hit = fileConns.get(name);
  if (hit) {
    clearTimeout(hit.timer);
    hit.timer = setTimeout(() => dropFileConn(name), 60000);
    hit.timer.unref?.();
    return hit.conn;
  }
  const s = loadServers().find((x) => x.name === name);
  if (!s) throw new Error(`未找到机器 "${name}"`);
  const cfg = resolveConn(s, {});
  const conn = await sftpConnect({ ...cfg, machineId: name });
  const timer = setTimeout(() => dropFileConn(name), 60000);
  timer.unref?.();
  fileConns.set(name, { conn, timer });
  return conn;
}

/** 只列出配置了 SSH 连接信息的机器(供文件浏览器使用)。 */
function machinesWithConn() {
  const out = [];
  for (const s of loadServers()) {
    try {
      const c = resolveConn(s, {});
      out.push({ name: s.name, label: s.label || s.name, host: c.host, port: c.port, user: c.user, roots: machineRoots(s) });
    } catch { /* 无连接信息,跳过 */ }
  }
  return out;
}

const MAX_READ_BYTES = 512 * 1024;

function loadServers() {
  const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
  return Array.isArray(raw.servers) ? raw.servers : raw;
}
function saveServers(servers) {
  writeFileSync(CONFIG, JSON.stringify({ servers }, null, 2) + "\n", "utf8");
}

/* ── /api/rw/* 的访问范围(围栏)───────────────────────────────────────────
 * 面板这条路径持有 SSH 凭据,原先对它来说「能打开页面」=「能读写远程整台机器」,
 * 而且完全绕开 fs provider 上那三档权限(那三档只管模型的文件工具)。这里按调用方
 * 分两种范围,并在服务端强制(客户端给的路径一律不信任):
 *   带 port → 该工作台**注册的工作区**(最窄;侧栏插件走这条)
 *   带 name → 该机器声明的**挂载根**(面板自己的文件管理器;不是 /)
 * 想在某台机器上调整,在 servers.json 条目上写显式 `roots: [...]`。
 */
function resolveScope(params) {
  const servers = loadServers();
  const port = Number(params.port || 0);
  if (port) {
    const s = servers.find((x) => Number(x.localPort ?? x.dshPort) === port || Number(x.dshPort) === port);
    if (!s) return { error: `端口 ${port} 没有对应的机器(先在面板里登记)` };
    const base = { name: s.name, label: s.label || s.name };
    const ws = readWorkbenchRoots(s.name);
    if (ws.roots.length) return { ...base, kind: "workspace", roots: ws.roots, titles: ws.titles, note: ws.note };
    return { ...base, kind: "machine", roots: machineRoots(s), note: "该工作台还没登记工作区,暂按机器挂载根" };
  }
  const name = params.name;
  if (!name) return { error: "缺少 port(工作台)或 name(机器)" };
  const s = servers.find((x) => x.name === name);
  if (!s) return { error: `未找到机器 "${name}"` };
  return { name: s.name, label: s.label || s.name, kind: "machine", roots: machineRoots(s) };
}

class OutOfScope extends Error {
  constructor(scope, resolved) {
    super(`越界:${resolved} 不在允许范围内(${describeScope(scope)})` +
      (scope.kind === "workspace"
        ? " —— 这个文件管理器只能读写本工作台登记的工作区"
        : " —— 面板只能读写该机器的挂载根"));
    this.code = "RW_OUT_OF_SCOPE";
  }
}

/** 过围栏并把 symlink 解析掉;返回可以真正落盘/读取的路径。越界抛 OutOfScope。 */
async function permitted(conn, scope, target) {
  const r = await fencePath(conn, target, scope.roots);
  if (!r.ok) throw new OutOfScope(scope, r.resolved || target);
  return r.resolved;
}

function fail(e, what) {
  if (e?.code === "RW_OUT_OF_SCOPE") return [403, { error: e.message, code: e.code }];
  return [400, { error: `${what}: ${e.message}` }];
}

/** 取范围里的机器连接(带 port 时机器名由服务端定,客户端说了不算)。 */
async function connFor(scope) {
  return getFileConn(scope.name);
}

/** 读取请求体（JSON）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

/** 校验并规范化一个服务器条目；返回 { value } 或 { error }。 */
function validateServer(input, { existingNames = [], selfName = null } = {}) {
  const s = { ...(input ?? {}) };
  const errors = [];
  const name = String(s.name ?? "").trim();
  if (!name) errors.push("名称不能为空");
  else if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) errors.push("名称只能含字母/数字/下划线/连字符，且不能以符号开头");
  else if (selfName !== name && existingNames.includes(name)) errors.push(`名称 "${name}" 已存在`);
  const host = String(s.host ?? "").trim();
  if (!s.direct && !host) errors.push("非 direct 模式必须填写服务器地址");
  const port = Number(s.dshPort ?? 3080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("dsh 端口无效");
  const localPort = Number(s.localPort ?? port);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) errors.push("本地端口无效");
  const sshPort = Number(s.sshPort ?? 22);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) errors.push("SSH 端口无效");
  if (errors.length) return { error: errors.join("；") };
  return {
    value: {
      ...s,                      // 保留扩展字段(conn / mirror / 以后新增的),避免面板保存时被剥掉
      name,
      label: String(s.label ?? "").trim() || name,
      direct: Boolean(s.direct),
      host: s.direct ? (host || "127.0.0.1") : host,
      user: String(s.user ?? "").trim() || (s.direct ? "local" : ""),
      sshPort,
      dshPort: port,
      localPort,
      platform: String(s.platform ?? "").trim() || (s.direct ? "local" : "linux"),
      home: String(s.home ?? "").trim() || undefined,
      note: String(s.note ?? "").trim() || undefined,
    },
  };
}

/** 编辑后若 name 变了，把 pid 记录迁到新 name 下。 */
function renamePid(oldName, newName) {
  if (oldName === newName) return;
  const pids = loadPids();
  if (pids[oldName] !== undefined) {
    pids[newName] = pids[oldName];
    delete pids[oldName];
    savePids(pids);
  }
}
function loadPids() {
  if (!existsSync(PIDS_FILE)) return {};
  try { return JSON.parse(readFileSync(PIDS_FILE, "utf8")); } catch { return {}; }
}
function savePids(pids) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PIDS_FILE, JSON.stringify(pids, null, 2) + "\n", "utf8");
}

// ── SSH 密钥一键部署(纯 OpenSSH,无外部依赖) ──────────────────────────────
const SSH_DIR = join(homedir(), ".ssh");
const KEY_FILE = join(SSH_DIR, "id_ed25519");

function ensureLocalKey() {
  if (existsSync(KEY_FILE) && existsSync(KEY_FILE + ".pub")) return;
  try { mkdirSync(SSH_DIR, { recursive: true }); } catch { /* ignore */ }
  const r = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", KEY_FILE], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ssh-keygen 失败: ${r.stderr || ""}`);
}

/** 让 ssh 无 tty 时也能拿密码的 askpass 环境(OpenSSH ≥8.4)。密码只存在于临时脚本,用完即删。 */
function askpassEnv(password) {
  const script = join(SSH_DIR, ".dsh-askpass.sh");
  const safe = String(password).replace(/'/g, `'\\''`);
  writeFileSync(script, `#!/bin/sh\necho '${safe}'\n`, { mode: 0o700 });
  return { ...process.env, SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: "force" };
}
function cleanupAskpass() {
  try { rmSync(join(SSH_DIR, ".dsh-askpass.sh"), { force: true }); } catch { /* ignore */ }
}
function sshCommon(s, extra = []) {
  return ["-p", String(s.sshPort ?? 22), "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", ...extra];
}
function sshTarget(s) { return `${s.user}@${s.host}`; }

/** 免密是否可用(BatchMode 下快速探测)。 */
function keyAuthWorks(s) {
  const r = spawnSync("ssh", [...sshCommon(s, ["-o", "BatchMode=yes"]), sshTarget(s), "echo key-ok"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0;
}
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function isPortOpen(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

/** 轮询等待端口就绪，最多 waitMs 毫秒。 */
async function waitForPort(port, waitMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function startTunnel(s) {
  const pids = loadPids();
  const port = s.localPort ?? s.dshPort;
  if (pids[s.name] && isPidAlive(pids[s.name])) {
    // PID 可能被系统复用:本地隧道端口通才算真的在
    if (await isPortOpen(port)) return { ok: true, msg: "已在运行" };
    console.log(`○ ${s.name} 隧道记录过期(pid ${pids[s.name]}),清理并重连`);
    delete pids[s.name];
    savePids(pids);
  }
  const args = [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `${s.localPort ?? s.dshPort}:127.0.0.1:${s.dshPort}`,
    "-p", String(s.sshPort ?? 22),
    `${s.user}@${s.host}`,
  ];
  const child = spawn("ssh", args, { stdio: "ignore", detached: true });
  child.unref();
  pids[s.name] = child.pid;
  savePids(pids);
  return { ok: true, msg: `隧道启动 (pid ${child.pid})` };
}

/** 比较版本号数字段（忽略预发布标识，用于挑最高版本目录）。 */
function cmpVersionKey(a, b) {
  const A = String(a ?? "").match(/\d+/g)?.map(Number) ?? [0];
  const B = String(b ?? "").match(/\d+/g)?.map(Number) ?? [0];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 查找本机可用的 dsh bin 路径（direct 模式用）。优先级：
 *  DSH_BIN 环境变量 → 受管安装 harness/current（update-dsh.mjs 维护）→ PATH → npx 缓存（取版本最高）。 */
function findDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  // 1) 受管安装 current（update-dsh.mjs 切换/回滚后自动跟随）
  const managed = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "harness", "current", "node_modules", ".bin", "dsh");
  if (existsSync(managed)) return managed;
  // 2) PATH 上的 dsh
  const which = spawnSync("which", ["dsh"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  // 3) npx 缓存里的 @deepseek-ai/dsh（多个缓存目录时取版本最高）
  const npxRoot = join(homedir(), ".npm", "_npx");
  let best = null, bestVer = null;
  try {
    for (const dir of readdirSync(npxRoot)) {
      const base = join(npxRoot, dir, "node_modules", "@deepseek-ai", "dsh");
      if (!existsSync(join(base, "lib", "bin.js"))) continue;
      let ver = null;
      try { ver = JSON.parse(readFileSync(join(base, "package.json"), "utf8")).version; } catch { /* ignore */ }
      if (!best || cmpVersionKey(ver, bestVer) > 0) { best = join(base, "lib", "bin.js"); bestVer = ver; }
    }
  } catch { /* ignore */ }
  if (best) return best;
  return "dsh"; // 最后兜底，让 spawn 报错更直观
}

/** 启动输出落盘:实例崩溃时才有得查(以前 stdio:'ignore' 完全看不到原因)。 */
function bootLogPath(name) { return join(STATE_DIR, `boot-${name}.log`); }
function bootLogTail(name, lines = 14) {
  const file = bootLogPath(name);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch { return ""; }
}

/** direct 模式：本机直接启动/管理一个 dsh web 实例。 */
async function startDirect(s) {
  const pids = loadPids();
  const existing = pids[s.name];
  if (existing && isPidAlive(existing)) {
    // PID 可能被系统复用(重启后旧记录指向别的进程):必须端口也通才算真的在运行
    if (await isPortOpen(s.dshPort)) return { ok: true, msg: "实例已在运行" };
    console.log(`○ ${s.name} 记录过期(pid ${existing}),重新启动`);
    delete pids[s.name];
    savePids(pids);
  }
  const bin = findDshBin();
  const dshHome = s.home || join(homedir(), ".dsh");
  mkdirSync(STATE_DIR, { recursive: true });
  let stdio = "ignore";
  let fd = null;
  try {
    fd = openSync(bootLogPath(s.name), "a");
    stdio = ["ignore", fd, fd];
  } catch { /* 打不开日志就退回 ignore */ }
  const child = spawn(process.execPath, [bin, "web", "--port", String(s.dshPort)], {
    stdio,
    detached: true,
    env: { ...process.env, DSH_HOME: dshHome },
  });
  child.unref();
  if (fd !== null) { try { closeSync(fd); } catch { /* 已关 */ } }
  pids[s.name] = child.pid;
  savePids(pids);
  return { ok: true, msg: `实例启动 (pid ${child.pid}, DSH_HOME=${dshHome})` };
}
async function stopTunnel(name) {
  const pids = loadPids();
  const pid = pids[name];
  const server = loadServers().find((s) => s.name === name);
  const port = server ? (server.localPort ?? server.dshPort) : null;
  const serving = pid && isPidAlive(pid) && port && (await isPortOpen(port));
  if (serving) { try { process.kill(pid, "SIGTERM"); } catch {} }
  else if (pid && isPidAlive(pid)) { console.log(`○ ${name} 记录过期(pid 已不属于本实例),未执行 kill`); }
  delete pids[name];
  savePids(pids);
}
async function serverStatus(s) {
  const pids = loadPids();
  const tunnelUp = Boolean(pids[s.name] && isPidAlive(pids[s.name]));
  const port = s.localPort ?? s.dshPort;
  const portOpen = await isPortOpen(port);
  return {
    ...s,
    tunnelUp,
    portOpen,
    state: tunnelUp && portOpen ? "online" : tunnelUp ? "tunneling" : "offline",
    url: `http://127.0.0.1:${port}`,
  };
}

/** 测试一台服务器的连通性：ssh 端口（远程）与本地隧道端口。 */
async function testServer(s) {
  const checks = [];
  if (!s.direct) {
    const sshOk = await isPortOpen(s.sshPort ?? 22, s.host, 2500);
    checks.push({ name: "SSH", host: s.host, port: s.sshPort ?? 22, ok: sshOk,
      detail: sshOk ? "端口可达（未验证认证）" : "端口不可达：检查网络/防火墙/sshd 是否开启" });
  }
  const port = s.localPort ?? s.dshPort;
  const localOk = await isPortOpen(port, "127.0.0.1", 1200);
  checks.push({ name: s.direct ? "实例" : "隧道", host: "127.0.0.1", port, ok: localOk,
    detail: localOk ? "端口就绪" : "未就绪：先连接，或检查实例/隧道" });
  return { name: s.name, checks };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PANEL_PORT}`);
  // 允许本机工作台(3080/3090 等)的页面直接调用本面板的 /api/rw/*(仅监听回环,风险可控)
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...cors });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(ROOT, "panel.html")));
      return;
    }
    if (url.pathname === "/api/meta") {
      send(200, { configFile: CONFIG, panelPort: PANEL_PORT });
      return;
    }
    if (url.pathname === "/api/servers" && req.method === "GET") {
      const servers = loadServers();
      const withStatus = await Promise.all(servers.map(serverStatus));
      send(200, { servers: withStatus });
      return;
    }
    if (url.pathname === "/api/servers" && req.method === "POST") {
      const body = await readBody(req);
      const servers = loadServers();
      const { value, error } = validateServer(body, { existingNames: servers.map((x) => x.name) });
      if (error) return send(400, { error });
      servers.push(value);
      saveServers(servers);
      send(200, { ok: true, server: value });
      return;
    }
    if (url.pathname === "/api/servers" && req.method === "PUT") {
      const body = await readBody(req);
      const servers = loadServers();
      const idx = servers.findIndex((x) => x.name === body.name);
      if (idx < 0) return send(404, { error: `未找到服务器 "${body.name}"` });
      const { value, error } = validateServer({ ...servers[idx], ...body, name: body.name },
        { existingNames: servers.map((x) => x.name), selfName: body.name });
      if (error) return send(400, { error });
      renamePid(servers[idx].name, value.name);
      servers[idx] = value;
      saveServers(servers);
      send(200, { ok: true, server: await serverStatus(value) });
      return;
    }
    if (url.pathname === "/api/connect") {
      const name = url.searchParams.get("name");
      const servers = loadServers();
      const s = servers.find((x) => x.name === name);
      if (!s) return send(404, { error: "not found" });
      const r = s.direct ? await startDirect(s) : await startTunnel(s);
      // 等端口就绪（direct 首次初始化最长 30s），再返回最新状态
      const port = s.localPort ?? s.dshPort;
      const ok = await waitForPort(port);
      const status = await serverStatus(s);
      if (!ok) return send(200, { result: { ...r, ready: false }, server: status });
      send(200, { result: { ...r, ready: true }, server: status });
      return;
    }
    if (url.pathname === "/api/connect-all") {
      const servers = loadServers();
      const results = [];
      for (const s of servers) {
        const r = s.direct ? await startDirect(s) : await startTunnel(s);
        const port = s.localPort ?? s.dshPort;
        const ok = await waitForPort(port, 30000);
        results.push({ name: s.name, ready: ok, msg: r.msg });
      }
      send(200, { results });
      return;
    }
    if (url.pathname === "/api/disconnect-all") {
      for (const s of loadServers()) await stopTunnel(s.name);
      send(200, { ok: true });
      return;
    }
    if (url.pathname === "/api/disconnect") {
      const name = url.searchParams.get("name");
      await stopTunnel(name);
      const servers = loadServers();
      const s = servers.find((x) => x.name === name);
      send(200, { server: s ? await serverStatus(s) : null });
      return;
    }
    if (url.pathname === "/api/open") {
      const name = url.searchParams.get("name");
      const servers = loadServers();
      const s = servers.find((x) => x.name === name);
      if (!s) return send(404, { error: "not found" });
      const target = `http://127.0.0.1:${s.localPort ?? s.dshPort}`;
      const p = process.platform === "darwin" ? spawn("open", [target], { stdio: "ignore", detached: true })
        : process.platform === "win32" ? spawn("cmd", ["/c", "start", "", target], { stdio: "ignore", detached: true })
        : spawn("xdg-open", [target], { stdio: "ignore", detached: true });
      p.unref();
      send(200, { opened: target });
      return;
    }
    if (url.pathname === "/api/test") {
      const name = url.searchParams.get("name");
      const servers = loadServers();
      const s = servers.find((x) => x.name === name);
      if (!s) return send(404, { error: "not found" });
      send(200, await testServer(s));
      return;
    }
    if (url.pathname === "/api/remove") {
      const name = url.searchParams.get("name");
      await stopTunnel(name);
      const servers = loadServers().filter((x) => x.name !== name);
      saveServers(servers);
      send(200, { ok: true });
      return;
    }
    // ── 一键部署 SSH 公钥:输入一次性实例密码,自动生成/推送本机 key ──
    if (url.pathname === "/api/setup-key" && req.method === "POST") {
      const body = await readBody(req);
      const s = loadServers().find((x) => x.name === body.name);
      if (!s) return send(404, { error: "not found" });
      if (s.direct) return send(400, { error: "direct 模式不需要 SSH 密钥" });
      const password = String(body.password ?? "");
      if (!password) return send(400, { error: "需要实例的一次性 SSH 密码（只用于本次部署，不保存）" });
      try {
        ensureLocalKey();
        if (keyAuthWorks(s)) return send(200, { ok: true, note: "免密已可用，无需部署" });
        const pub = readFileSync(KEY_FILE + ".pub", "utf8").trim();
        const env = askpassEnv(password);
        const push = spawnSync("ssh", [...sshCommon(s), sshTarget(s), "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"],
          { input: pub + "\n", encoding: "utf8", env, timeout: 30000 });
        cleanupAskpass();
        if (push.status !== 0) {
          const err = (push.stderr || "").split("\n").filter(Boolean).slice(-2).join(" ");
          return send(400, { error: `公钥推送失败: ${err}（密码错误或用户名不对？）` });
        }
        if (!keyAuthWorks(s)) return send(400, { error: "公钥已推送但免密验证失败，请重试" });
        send(200, { ok: true, note: "密钥已部署，免密连接已就绪" });
      } catch (e) {
        cleanupAskpass();
        send(400, { error: String(e?.message ?? e) });
      }
      return;
    }
    // ── 一键初始化服务器:scp install-remote.sh 并远程执行(装 dsh + 注册常驻服务)──
    if (url.pathname === "/api/init-server" && req.method === "POST") {
      const body = await readBody(req);
      const s = loadServers().find((x) => x.name === body.name);
      if (!s) return send(404, { error: "not found" });
      if (s.direct) return send(400, { error: "direct 模式不需要远程初始化" });
      try {
        if (!keyAuthWorks(s)) return send(400, { error: "免密未就绪，请先点「🔑 部署密钥」" });
        const script = join(ROOT, "install-remote.sh");
        const scp = spawnSync("scp", ["-P", String(s.sshPort ?? 22), "-o", "BatchMode=yes", script, `${sshTarget(s)}:~/dsh-remote-install.sh`], { encoding: "utf8", timeout: 30000 });
        if (scp.status !== 0) return send(400, { error: `scp 失败: ${(scp.stderr || "").split("\n").slice(-2).join(" ")}` });
        const run = spawnSync("ssh", [...sshCommon(s, ["-o", "BatchMode=yes"]), sshTarget(s), `bash ~/dsh-remote-install.sh ${s.dshPort ?? 3080}`],
          { encoding: "utf8", timeout: 8 * 60 * 1000 });
        const tail = [...(run.stdout || "").split("\n"), ...(run.stderr || "").split("\n")].filter(Boolean).slice(-20).join("\n");
        if (run.status !== 0) return send(400, { error: `初始化失败:\n${tail}` });
        send(200, { ok: true, output: tail || "初始化完成" });
      } catch (e) {
        send(400, { error: String(e?.message ?? e) });
      }
      return;
    }

    // ── 一键创建「远程挂载工作台」─────────────────────────────────────────
    // 一个工作台 = 独立 DSH_HOME + web profile + 三个远程 provider(fs/subprocess/bash)
    // + 挂载配置 + 本机端口。建完这个分区的 read/write/edit/bash/glob/grep 全在远程跑。
    if (url.pathname === "/api/workbench/plan") {
      const servers = loadServers();
      const used = servers.flatMap((s) => [s.dshPort, s.localPort]).filter(Boolean);
      const source = url.searchParams.get("source") || "";
      const base = source.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "remote";
      const name = (url.searchParams.get("name") || `${base}-ws`).trim();
      try {
        const plan = await planWorkbench({
          name,
          remoteRoot: url.searchParams.get("remoteRoot") || "/root",
        }, { mainHome: DSH_HOME });
        send(200, {
          plan: { name: plan.name, home: plan.home, mountRoot: plan.mountRoot, plugins: plan.plugins, remoteRoot: plan.remoteRoot },
          suggestedPort: await pickFreePort(used),
          // 能当远程目标的条件:知道 SSH 连接(conn),或者是非 direct 且有 host 的条目
          // —— 后者靠 ~/.ssh/config 的别名也能连,不一定非填 conn。
          servers: servers.map((s) => ({
            name: s.name,
            label: s.label,
            dshPort: s.dshPort,
            hasConn: Boolean(s.conn ?? s.mirror),
            remote: Boolean(s.conn ?? s.mirror) || (!s.direct && Boolean(s.host) && s.host !== "127.0.0.1"),
          })),
        });
      } catch (e) {
        send(400, { error: String(e?.message ?? e) });
      }
      return;
    }
    if (url.pathname === "/api/workbench" && req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { return send(400, { error: String(e?.message ?? e) }); }
      const servers = loadServers();
      const source = servers.find((s) => s.name === body.source);
      if (!source) return send(400, { error: `清单里没有机器 "${body.source}",先把那台服务器添加上` });
      if (servers.some((s) => s.name === body.name)) return send(400, { error: `已有同名工作台 "${body.name}"` });
      const used = servers.flatMap((s) => [s.dshPort, s.localPort]).filter(Boolean);
      let created = null;
      try {
        created = await createWorkbench({
          name: body.name,
          label: body.label,
          note: body.note,
          remoteRoot: body.remoteRoot || "/root",
          port: body.port ? Number(body.port) : undefined,
          sourceServer: source.name,
          sourceEntry: source,
          conn: source.conn ?? source.mirror,
        }, {
          mainHome: DSH_HOME,
          templateHome: DSH_HOME,
          dshBin: findDshBin(),
          usedPorts: used,
        }, (msg) => console.log(`  [workbench] ${msg}`));
      } catch (error) {
        return send(500, { error: String(error?.message ?? error), steps: error?.steps ?? [] });
      }

      // 注册进清单 → 启动 → 等端口 → 再确认进程没有立刻死掉
      // 注意 validateServer 是「返回 {error}」而不是抛错,不能靠 try/catch。
      const checked = validateServer(created.serverRecord, { existingNames: servers.map((s) => s.name) });
      if (checked.error) {
        rollbackWorkbench(created.home);
        return send(500, { error: `生成的条目未通过校验,已回滚: ${checked.error}`, steps: created.steps });
      }
      const record = checked.value;
      saveServers([...servers, record]);
      created.steps.push({ title: "注册进清单", ok: true, detail: `${record.name} → :${record.dshPort}` });

      const started = await startDirect(record);
      const ready = await waitForPort(record.dshPort);
      await new Promise((r) => setTimeout(r, 2500)); // 端口开放 ≠ 启动成功:崩溃前端口也会短暂打开
      const alive = isPidAlive(loadPids()[record.name]);
      const stable = ready && alive && (await isPortOpen(record.dshPort));
      const diagnosis = stable ? "" : bootLogTail(record.name);
      created.steps.push({
        title: "启动实例",
        ok: stable,
        detail: stable ? `:${record.dshPort} 就绪且进程存活` : `启动失败(${started.msg})${diagnosis ? " — 见下方诊断" : ""}`,
      });
      send(stable ? 200 : 500, {
        steps: created.steps,
        ok: stable,
        error: stable ? undefined : "实例启动后未能稳定存活",
        server: await serverStatus(record),
        url: `http://127.0.0.1:${record.dshPort}`,
        home: created.home,
        mountRoot: created.mountRoot,
        bootLog: bootLogPath(record.name),
        diagnosis,
      });
      return;
    }

    // ── 远程文件浏览(SFTP 就地读写,不落本地副本) ─────────────────────────
    if (url.pathname === "/api/rw/machines") {
      send(200, { machines: machinesWithConn() });
      return;
    }
    // 「我是谁」:按工作台端口反查它属于哪台机器 **以及它的访问范围** ——
    // 每个分区工作台只服务自己那台;范围由服务端按端口算出,客户端改不了。
    if (url.pathname === "/api/rw/whoami") {
      const port = Number(url.searchParams.get("port") || 0);
      const name = url.searchParams.get("name");
      const all = machinesWithConn();
      const scope = resolveScope({ port, name });
      let machine = null;
      if (!scope.error) {
        const hit = loadServers().find((s) => s.name === scope.name);
        try {
          const c = resolveConn(hit, {});
          machine = {
            name: hit.name, label: hit.label || hit.name,
            host: c.host, port: c.port, user: c.user,
            scope: scope.kind,                 // "workspace" = 只能碰本工作台登记的工作区
            roots: scope.roots,                // 允许的根(远程拼写)
            titles: scope.titles || {},        // 工作区标题,给树当节点名
            note: scope.note,
            defaultPath: scope.roots[0] || null,
          };
        } catch { /* 无连接信息则视为未匹配 */ }
      }
      send(200, { port, machine, error: scope.error, machines: all });
      return;
    }
    if (url.pathname === "/api/rw/list") {
      const scope = resolveScope({ port: url.searchParams.get("port"), name: url.searchParams.get("name") });
      if (scope.error) return send(400, { error: scope.error });
      const path = url.searchParams.get("path") || scope.roots[0];
      try {
        const conn = await connFor(scope);
        const target = await permitted(conn, scope, path);
        const st = await conn.stat(target).catch(() => null);
        if (st && !st.isDirectory()) return send(400, { error: `${target} 不是目录` });
        const entries = await conn.readdir(target);
        const list = entries.map((e) => ({
          name: e.filename,
          dir: Boolean(e.attrs.isDirectory?.()),
          size: e.attrs.size ?? 0,
          mtime: (e.attrs.mtime ?? 0) * 1000,
        })).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        send(200, { path: target, scope: scope.kind, roots: scope.roots, entries: list });
      } catch (e) {
        send(...fail(e, "读取目录失败"));
      }
      return;
    }
    if (url.pathname === "/api/rw/read") {
      const scope = resolveScope({ port: url.searchParams.get("port"), name: url.searchParams.get("name") });
      if (scope.error) return send(400, { error: scope.error });
      const path = url.searchParams.get("path");
      try {
        const conn = await connFor(scope);
        const target = await permitted(conn, scope, path);
        const st = await conn.stat(target);
        if (st.size > MAX_READ_BYTES) {
          return send(200, { path: target, size: st.size, truncated: true, text: "" , note: `文件 ${st.size} 字节,超过 ${MAX_READ_BYTES} 字节上限,请用命令行 rw.mjs read --head/--tail` });
        }
        const buf = await conn.readFile(target);
        const binary = buf.includes(0);
        send(200, {
          path: target, size: st.size, truncated: false,
          binary,
          text: binary ? "" : buf.toString("utf8"),
          note: binary ? "二进制文件,不显示内容" : undefined,
        });
      } catch (e) {
        send(...fail(e, "读取文件失败"));
      }
      return;
    }
    if (url.pathname === "/api/rw/write" && req.method === "POST") {
      const body = await readBody(req);
      const scope = resolveScope(body);
      if (scope.error) return send(400, { error: scope.error });
      try {
        const conn = await connFor(scope);
        const target = await permitted(conn, scope, body.path);
        const existed = await conn.stat(target).then(() => true).catch(() => false);
        await conn.writeFile(target, Buffer.from(String(body.text ?? "")));
        send(200, { ok: true, path: target, existed });
      } catch (e) {
        send(...fail(e, "保存失败"));
      }
      return;
    }
    if (url.pathname === "/api/rw/mkdir" && req.method === "POST") {
      const body = await readBody(req);
      const scope = resolveScope(body);
      if (scope.error) return send(400, { error: scope.error });
      try {
        const conn = await connFor(scope);
        const target = await permitted(conn, scope, body.path);
        await conn.mkdirp(target);
        send(200, { ok: true, path: target });
      } catch (e) {
        send(...fail(e, "建目录失败"));
      }
      return;
    }
    if (url.pathname === "/api/rw/rm" && req.method === "POST") {
      const body = await readBody(req);
      const scope = resolveScope(body);
      if (scope.error) return send(400, { error: scope.error });
      try {
        const conn = await connFor(scope);
        const target = await permitted(conn, scope, body.path);
        const st = await conn.stat(target).catch(() => null);
        if (!st) return send(404, { error: "路径不存在" });
        // 额外一道:不许把范围根本身删掉(否则一次误点就清空整个工作区)
        if (scope.roots.some((r) => r === target)) {
          return send(403, { error: `拒绝删除范围根 ${target} —— 一次误点会清掉整个${scope.kind === "workspace" ? "工作区" : "挂载根"}` });
        }
        if (st.isDirectory()) {
          if (!body.recursive) return send(400, { error: "目录需要勾选递归删除" });
          const r = await conn.exec(`rm -rf '${String(target).replace(/'/g, "'\\''")}'`);
          if (r.code !== 0) return send(400, { error: r.stderr || "删除失败" });
        } else {
          await conn.unlink(target);
        }
        send(200, { ok: true, path: target });
      } catch (e) {
        send(...fail(e, "删除失败"));
      }
      return;
    }
    if (url.pathname === "/api/rw/mv" && req.method === "POST") {
      const body = await readBody(req);
      const scope = resolveScope(body);
      if (scope.error) return send(400, { error: scope.error });
      try {
        const conn = await connFor(scope);
        // 两端都要过围栏:否则「范围内 → 范围外」就是一条把文件搬出工作区的路
        const from = await permitted(conn, scope, body.from);
        const to = await permitted(conn, scope, body.to);
        if (scope.roots.some((r) => r === from)) return send(403, { error: `拒绝移动范围根 ${from}` });
        await conn.rename(from, to);
        send(200, { ok: true, from, to });
      } catch (e) {
        send(...fail(e, "重命名失败"));
      }
      return;
    }
    // ── 下载:把远程文件以附件流回浏览器(二进制安全,浏览器自己落盘)──────
    if (url.pathname === "/api/rw/download") {
      const scope = resolveScope({ port: url.searchParams.get("port"), name: url.searchParams.get("name") });
      if (scope.error) return send(400, { error: scope.error });
      const remote = url.searchParams.get("path");
      if (!remote) return send(400, { error: "缺少 path" });
      let conn;
      try {
        conn = await connFor(scope);
      } catch (e) {
        return send(400, { error: `连接失败: ${e.message}` });
      }
      let target;
      try {
        target = await permitted(conn, scope, remote);
      } catch (e) {
        return send(403, { error: e.message, code: e.code });
      }
      let st;
      try {
        st = await conn.stat(target);
        if (st.isDirectory?.()) return send(400, { error: "目录不能直接下载(先打包,或用 rw.mjs tree 看结构)" });
      } catch (e) {
        return send(404, { error: `文件不存在: ${e.message}` });
      }
      const base = target.split("/").pop() || "download";
      const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(st.size ?? 0),
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
        "Cache-Control": "no-store",
        ...cors,
      });
      const stream = conn.sftp.createReadStream(target);
      stream.on("error", () => { try { res.destroy(); } catch { /* 已断 */ } });
      res.on("close", () => { try { stream.destroy(); } catch { /* 已结束 */ } });
      stream.pipe(res);
      return;
    }
    // ── 上传:请求体就是原始字节,直接管道进 SFTP(不走 JSON,不限大小)──
    if (url.pathname === "/api/rw/upload" && req.method === "POST") {
      const scope = resolveScope({ port: url.searchParams.get("port"), name: url.searchParams.get("name") });
      if (scope.error) return send(400, { error: scope.error });
      const destParam = url.searchParams.get("path");
      if (!destParam) return send(400, { error: "缺少 path" });
      let conn;
      try {
        conn = await connFor(scope);
      } catch (e) {
        return send(400, { error: `连接失败: ${e.message}` });
      }
      let dest;
      try {
        dest = await permitted(conn, scope, destParam);
      } catch (e) {
        return send(403, { error: e.message, code: e.code });
      }
      const parent = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : ".";
      try {
        await conn.mkdirp(parent);
      } catch (e) {
        return send(400, { error: `建父目录失败: ${e.message}` });
      }
      let received = 0;
      let done = false;
      const sink = conn.sftp.createWriteStream(dest);
      req.on("data", (chunk) => { received += chunk.length; });
      sink.on("close", () => { if (!done) { done = true; send(200, { ok: true, path: dest, bytes: received }); } });
      sink.on("error", (e) => { if (!done) { done = true; send(400, { error: `写入失败: ${e.message}` }); } });
      req.on("error", (e) => { try { sink.destroy(); } catch { /* 已断 */ } if (!done) { done = true; send(400, { error: `接收失败: ${e.message}` }); } });
      req.pipe(sink);
      return;
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(500, { error: String(e?.message ?? e) });
  }
});

server.listen(PANEL_PORT, "127.0.0.1", () => {
  console.log(`dsh-remote 控制面板: http://127.0.0.1:${PANEL_PORT}`);
  console.log("本页面只在本机提供服务，请勿暴露到公网。");
});
