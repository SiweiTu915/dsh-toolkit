#!/usr/bin/env node
/**
 * dsh-remote 控制面板 — 本地管理所有远程 DSH 服务器的 Web 页面
 *
 * 启动: node panel.mjs [--port 4100]
 * 打开: http://127.0.0.1:4100
 *
 * 页面提供: 服务器清单 / 一键建隧道 / 一键打开窗口 / 状态探测 / 添加删除
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.DSH_REMOTE_CONFIG
  ? join(ROOT, process.env.DSH_REMOTE_CONFIG)
  : join(ROOT, "servers.json");
const STATE_DIR = join(ROOT, ".state");
const PIDS_FILE = join(STATE_DIR, "tunnels.json");

const PANEL_PORT = Number(process.argv.find((a, i) => process.argv[i - 1] === "--port") ?? 4100);

function loadServers() {
  const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
  return Array.isArray(raw.servers) ? raw.servers : raw;
}
function saveServers(servers) {
  writeFileSync(CONFIG, JSON.stringify({ servers }, null, 2) + "\n", "utf8");
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
  const child = spawn(process.execPath, [bin, "web", "--port", String(s.dshPort)], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, DSH_HOME: dshHome },
  });
  child.unref();
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
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
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
    send(404, { error: "not found" });
  } catch (e) {
    send(500, { error: String(e?.message ?? e) });
  }
});

server.listen(PANEL_PORT, "127.0.0.1", () => {
  console.log(`dsh-remote 控制面板: http://127.0.0.1:${PANEL_PORT}`);
  console.log("本页面只在本机提供服务，请勿暴露到公网。");
});
