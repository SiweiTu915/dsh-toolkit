#!/usr/bin/env node
/**
 * lan-forward.mjs —— 把一个只在回环上监听的服务，暴露到局域网。
 *
 * 为什么不直接让 DSH 用 `--host <LAN IP>`：那要重启 `dsh web`，会打断正在跑的会话；
 * 而这个转发器是独立进程，随时能起停，DSH 自己仍然只听 127.0.0.1。
 *
 * 用法：
 *   node lan-forward.mjs [--listen-host <IP>] [--listen-port 3080]
 *                        [--target-host 127.0.0.1] [--target-port 3080]
 *   node lan-forward.mjs --status
 *
 * 注意：
 *   · 只做 TCP 转发，不解析协议；鉴权仍由 DSH 自己负责（token / cookie）。
 *   · 绑定的是**具体 IP**，DHCP 换地址后会失效（换网段要重启它）。
 *   · 别把它暴露到公网（不要做路由器端口映射）。
 */
import { createConnection, createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

function opt(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
}

/** 取本机主网卡 IPv4（拿不到就报错，不要瞎猜）。 */
function lanIp() {
  for (const ifc of ["en0", "en1", "en2"]) {
    const r = spawnSync("/usr/sbin/ipconfig", ["getifaddr", ifc], { encoding: "utf8" });
    const ip = (r.stdout ?? "").trim();
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(ip)) return ip;
  }
  return null;
}

const argv = process.argv.slice(2);
const listenPort = Number(opt(argv, "listen-port", "3080"));
const targetPort = Number(opt(argv, "target-port", String(listenPort)));
const targetHost = opt(argv, "target-host", "127.0.0.1");
const listenHost = opt(argv, "listen-host", null) ?? lanIp();

const pidFile = join(DSH_HOME, ".state", `lan-forward-${listenPort}.pid`);
const logDir = join(DSH_HOME, "logs");
mkdirSync(logDir, { recursive: true });

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

if (argv.includes("--status")) {
  if (!existsSync(pidFile)) {
    console.log(`  没有在跑（${pidFile} 不存在）`);
    process.exit(0);
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  console.log(`  pid ${pid} ${alive ? "在跑" : "已退出（pid 文件残留）"}`);
  if (alive) {
    const r = spawnSync("lsof", ["-nP", `-iTCP:${listenPort}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    console.log((r.stdout ?? "").split("\n").slice(1).filter(Boolean).map((l) => `  ${l.split(/\s+/u).slice(8).join(" ")}`).join("\n"));
  }
  process.exit(0);
}

if (!listenHost) {
  console.error("✗ 拿不到局域网 IP（en0/en1/en2 都没有地址）。请显式 --listen-host <IP>");
  process.exit(1);
}

/** 统计用。 */
let connections = 0;

const server = createServer((client) => {
  connections += 1;
  const id = connections;
  const upstream = createConnection({ host: targetHost, port: targetPort });
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    client.destroy();
    upstream.destroy();
  };
  client.on("error", () => shutdown());
  upstream.on("error", (error) => {
    log(`#${id} 连不上 ${targetHost}:${targetPort} — ${error.code ?? error.message}`);
    shutdown();
  });
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("close", shutdown);
  upstream.on("close", shutdown);
});

server.on("error", (error) => {
  console.error(`✗ 监听 ${listenHost}:${listenPort} 失败：${error.code ?? error.message}`);
  if (error.code === "EADDRINUSE") console.error("  端口已被占用（可能已经起过一个转发器）");
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  writeFileSync(pidFile, `${process.pid}\n`);
  log(`转发已启动：${listenHost}:${listenPort} → ${targetHost}:${targetPort}（pid ${process.pid}）`);
  log(`从局域网访问：http://${listenHost}:${listenPort}/`);
  log(`停止：kill ${process.pid}（或 node lan-forward.mjs --status 查 pid）`);
});

const bye = () => {
  try { if (existsSync(pidFile)) unlinkSync(pidFile); } catch { /* 尽力 */ }
  process.exit(0);
};
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
