#!/usr/bin/env node
/**
 * dsh-remote — DSH 多服务器连接管理器（CLI）
 *
 * 每台远程服务器跑一个独立的 `dsh web --port <dshPort>` 实例；
 * 本地通过 SSH 隧道把服务器的 127.0.0.1:<dshPort> 映射到本机 <localPort>，
 * 浏览器打开 http://127.0.0.1:<localPort> 就是那台服务器的 Web 窗口。
 *
 * 用法:
 *   node cli.mjs list                     # 列出所有服务器
 *   node cli.mjs connect <name>           # 建立该服务器的 SSH 隧道
 *   node cli.mjs connect --all            # 建立所有服务器的隧道
 *   node cli.mjs open <name>              # 打开该服务器的 Web 窗口（浏览器）
 *   node cli.mjs status                   # 检查所有隧道连通性
 *   node cli.mjs disconnect <name>        # 关闭该服务器的隧道
 *   node cli.mjs disconnect --all         # 关闭所有隧道
 *   node cli.mjs add                      # 交互式添加一台服务器到清单
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.DSH_REMOTE_CONFIG
  ? join(ROOT, process.env.DSH_REMOTE_CONFIG)
  : join(ROOT, "servers.json");
const STATE_DIR = join(ROOT, ".state");
const PIDS_FILE = join(STATE_DIR, "tunnels.json");

const DSH_DEFAULT_PORT = 3080;

function loadServers() {
  const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
  return Array.isArray(raw.servers) ? raw.servers : raw;
}

function saveServers(servers) {
  writeFileSync(CONFIG, JSON.stringify({ servers }, null, 2) + "\n", "utf8");
}

function loadPids() {
  if (!existsSync(PIDS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PIDS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePids(pids) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PIDS_FILE, JSON.stringify(pids, null, 2) + "\n", "utf8");
}

function findServer(servers, name) {
  const s = servers.find((x) => x.name === name);
  if (!s) {
    console.error(`✗ 未找到服务器 "${name}"。可用: ${servers.map((x) => x.name).join(", ")}`);
    process.exit(1);
  }
  return s;
}

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(ok);
      }
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询等待端口就绪，最多 waitMs 毫秒。 */
async function waitForPort(port, waitMs = 6000, intervalMs = 500) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** 建立一条 SSH 隧道：ssh -N -L localPort:127.0.0.1:dshPort user@host -p sshPort */
async function startTunnel(s) {
  const pids = loadPids();
  const existing = pids[s.name];
  const port = s.localPort ?? s.dshPort;
  if (existing && isPidAlive(existing)) {
    // PID 可能被系统复用:本地隧道端口通才算真的在
    if (await isPortOpen(port)) {
      console.log(`○ ${s.name} 隧道已在运行 (pid ${existing})`);
      return { ok: true, pid: existing };
    }
    console.log(`○ ${s.name} 隧道记录过期(pid ${existing} 未在服务 :${port}),清理并重连`);
    delete pids[s.name];
    savePids(pids);
  }
  const args = [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `${port}:127.0.0.1:${s.dshPort}`,
    "-p", String(s.sshPort ?? 22),
    `${s.user}@${s.host}`,
  ];
  console.log(`🔌 连接 ${s.name} → ${s.user}@${s.host}:${s.sshPort ?? 22} (本地 :${port} → 远程 :${s.dshPort})`);
  const child = spawn("ssh", args, { stdio: "ignore", detached: true });
  child.unref();
  pids[s.name] = child.pid;
  savePids(pids);
  const ok = await waitForPort(port);
  if (!ok) {
    console.error(`✗ ${s.name} 连接失败：本地端口 :${port} 未在等待时间内打开。`);
    console.error(`  可能原因：ssh 无法连通 ${s.user}@${s.host}（网络/密钥/sshd 未开）、远程 dsh 未启动、或端口被占用。`);
    console.error(`  手动验证: ssh -L ${port}:127.0.0.1:${s.dshPort} -p ${s.sshPort ?? 22} ${s.user}@${s.host}`);
    return { ok: false, pid: child.pid };
  }
  console.log(`✓ ${s.name} 就绪 → http://127.0.0.1:${port}`);
  return { ok: true, pid: child.pid };
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

/** direct 模式：本机直接启动/管理一个 dsh web 实例（模拟远程服务器，或本机多窗口）。 */
async function startDirect(s) {
  const pids = loadPids();
  const existing = pids[s.name];
  if (existing && isPidAlive(existing)) {
    // PID 可能被系统复用(重启后旧记录指向别的进程):必须端口也通才算真的在运行
    if (await isPortOpen(s.dshPort)) {
      console.log(`○ ${s.name} 实例已在运行 (pid ${existing})`);
      return { ok: true, pid: existing };
    }
    console.log(`○ ${s.name} 记录过期(pid ${existing} 未在服务 :${s.dshPort}),清理并重新启动`);
    delete pids[s.name];
    savePids(pids);
  }
  const bin = findDshBin();
  const dshHome = s.home || join(homedir(), ".dsh");
  const port = s.localPort ?? s.dshPort;
  const args = [bin, "web", "--port", String(s.dshPort)];
  console.log(`🚀 启动 ${s.name} → ${bin} web --port ${s.dshPort} (DSH_HOME=${dshHome})`);
  const child = spawn(process.execPath, args, {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, DSH_HOME: dshHome },
  });
  child.unref();
  pids[s.name] = child.pid;
  savePids(pids);
  // 首次启动会初始化 profile，等待更久
  const ok = await waitForPort(port, 30000);
  if (!ok) {
    console.error(`✗ ${s.name} 启动失败：端口 :${port} 未在 30 秒内打开。`);
    console.error(`  可能原因：dsh 未找到（DSH_BIN 或 PATH）、DSH_HOME 目录不可写、端口被占用、或 profile 初始化出错。`);
    console.error(`  手动验证: DSH_HOME=${dshHome} ${process.execPath} ${bin} web --port ${s.dshPort}`);
    return { ok: false, pid: child.pid };
  }
  console.log(`✓ ${s.name} 就绪 → http://127.0.0.1:${port}`);
  return { ok: true, pid: child.pid };
}

async function stopTunnel(name) {
  const pids = loadPids();
  const pid = pids[name];
  const servers = loadServers();
  const server = servers.find((s) => s.name === name);
  const port = server ? (server.localPort ?? server.dshPort) : null;
  const serving = pid && isPidAlive(pid) && port && (await isPortOpen(port));
  if (serving) {
    try {
      process.kill(pid, "SIGTERM");
    } catch { /* already gone */ }
    console.log(`✗ ${name} 已关闭 (pid ${pid})`);
  } else if (pid && isPidAlive(pid)) {
    // PID 属于别的进程(重启后被复用):绝不误杀,只清记录
    console.log(`○ ${name} 记录过期(pid ${pid} 已不属于本实例,未执行 kill),已清理`);
  } else {
    console.log(`○ ${name} 没有运行中的实例`);
  }
  delete pids[name];
  savePids(pids);
}

async function cmdList() {
  const servers = loadServers();
  if (servers.length === 0) {
    console.log("清单为空。运行 `node cli.mjs add` 添加第一台服务器。");
    return;
  }
  const pids = loadPids();
  console.log("服务器清单:\n");
  for (const s of servers) {
    const running = pids[s.name] && isPidAlive(pids[s.name]);
    const port = s.localPort ?? s.dshPort;
    const portOk = await isPortOpen(port);
    const state = running && portOk ? "● 在线" : running ? "◐ 连接中(端口未开)" : "○ 离线";
    console.log(`  ${s.name.padEnd(16)} ${state.padEnd(16)} http://127.0.0.1:${port}  (${s.label ?? ""})`);
    if (s.note) console.log(`    ${"".padEnd(16)} ${s.note}`);
  }
  console.log("\n用法: node cli.mjs connect <name> | open <name> | disconnect <name>");
}

async function cmdStatus() {
  const servers = loadServers();
  for (const s of servers) {
    const port = s.localPort ?? s.dshPort;
    const ok = await isPortOpen(port);
    console.log(`${ok ? "●" : "○"} ${s.name.padEnd(16)} :${port} ${ok ? "可达" : "不可达"}`);
  }
}

async function cmdConnect(names, all) {
  const servers = loadServers();
  let failures = 0;
  if (all) {
    for (const s of servers) {
      const r = s.direct ? await startDirect(s) : await startTunnel(s);
      if (!r.ok) failures++;
    }
  } else if (names.length === 0) {
    console.error("用法: node cli.mjs connect <name> 或 --all");
    process.exit(1);
  } else {
    for (const name of names) {
      const s = findServer(servers, name);
      const r = s.direct ? await startDirect(s) : await startTunnel(s);
      if (!r.ok) failures++;
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} 个连接失败。`);
    process.exit(1);
  }
}

async function cmdDisconnect(names, all) {
  const servers = loadServers();
  if (all) {
    for (const s of servers) await stopTunnel(s.name);
    return;
  }
  if (names.length === 0) {
    console.error("用法: node cli.mjs disconnect <name> 或 --all");
    process.exit(1);
  }
  for (const name of names) {
    const s = findServer(servers, name);
    await stopTunnel(s.name);
  }
}

function cmdOpen(name) {
  const servers = loadServers();
  const s = findServer(servers, name);
  const url = `http://127.0.0.1:${s.localPort ?? s.dshPort}`;
  const platform = process.platform;
  const child = platform === "darwin"
    ? spawn("open", [url], { stdio: "ignore", detached: true })
    : platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
      : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.unref();
  console.log(`🌐 已打开 ${s.name} → ${url}`);
  console.log(`   （若页面空白，先运行: node cli.mjs connect ${s.name}）`);
}

async function cmdAdd() {
  const rl = readline.createInterface({ input, output });
  const ask = async (q, def) => {
    const ans = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return ans || def;
  };
  const servers = loadServers();
  console.log("添加服务器（Ctrl+C 取消）\n");
  const s = {
    name: await ask("名称 (英文 id，如 research-gpu)"),
    label: await ask("显示名（可选）", ""),
    host: await ask("服务器地址 (IP 或域名)"),
    user: await ask("SSH 用户名"),
    sshPort: Number(await ask("SSH 端口", "22")),
    dshPort: Number(await ask("远程 dsh web 端口", String(DSH_DEFAULT_PORT))),
    localPort: Number(await ask("本地隧道端口", String(DSH_DEFAULT_PORT))),
    platform: await ask("平台 (linux/windows/macos)", "linux"),
    note: await ask("备注（可选）", ""),
  };
  if (servers.some((x) => x.name === s.name)) {
    console.error(`✗ 名称 "${s.name}" 已存在`);
    rl.close();
    process.exit(1);
  }
  servers.push(s);
  saveServers(servers);
  rl.close();
  console.log(`✓ 已添加 ${s.name}。连接: node cli.mjs connect ${s.name}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const names = rest.filter((x) => !x.startsWith("-"));
const all = rest.includes("--all");

switch (cmd) {
  case "list": await cmdList(); break;
  case "status": await cmdStatus(); break;
  case "connect": await cmdConnect(names, all); break;
  case "disconnect": await cmdDisconnect(names, all); break;
  case "open": cmdOpen(names[0]); break;
  case "add": await cmdAdd(); break;
  default:
    console.log(`dsh-remote 连接管理器

用法:
  node cli.mjs list                    列出所有服务器
  node cli.mjs connect <name>|--all    建立 SSH 隧道
  node cli.mjs open <name>             打开该服务器的 Web 窗口
  node cli.mjs status                  检查隧道连通性
  node cli.mjs disconnect <name>|--all 关闭隧道
  node cli.mjs add                     交互式添加服务器
`);
}
