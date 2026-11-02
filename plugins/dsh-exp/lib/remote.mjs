/**
 * remote.mjs —— 找到"往哪台机器跑"，并执行一段 shell。
 *
 * 连接信息复用**已有的**三处配置，不新增第二套凭据：
 *   1. `$DSH_HOME/remote-mount.json`（工作台分区，字段 sshTarget/sshExtraArgs）
 *   2. `~/.dsh/dsh-remote/servers.json`（主 GUI；取第一个 direct=false 且有 conn 的）
 *   3. `DSH_EXP_SSH_TARGET` + `DSH_EXP_SSH_ARGS`（显式覆盖，排查用）
 *
 * 为什么不用 ctx.subprocess：那套要经过 fs/subprocess provider 的路径映射，
 * 而这里只要"在远端跑一段 shell"。直接 ssh 更短、更透明，也不要求装了 provider。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;

/** 读 JSON，坏了就返回 null（配置不该让工具直接崩）。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 解析 SSH 目标与参数。
 * @returns {{target: string, args: string[], source: string} | null}
 */
export function resolveSsh() {
  if (process.env.DSH_EXP_SSH_TARGET) {
    const args = (process.env.DSH_EXP_SSH_ARGS ?? "").split(/\s+/u).filter(Boolean);
    return { target: process.env.DSH_EXP_SSH_TARGET, args, source: "env" };
  }

  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");

  // 1) 工作台的挂载配置
  for (const name of ["remote-mount.json", "fs-sftp.json"]) {
    const file = join(home, name);
    if (!existsSync(file)) continue;
    const cfg = readJson(file);
    if (cfg?.sshTarget) {
      return {
        target: cfg.sshTarget,
        args: Array.isArray(cfg.sshExtraArgs) ? cfg.sshExtraArgs : [],
        source: file,
      };
    }
  }

  // 1.5) 各工作台分区自己的挂载配置（主 GUI 的 DSH_HOME 下它们在 dsh-remote/sim-homes/<name>/）
  //      多个分区指向同一台机时，取**最近修改**的那份 —— 活跃的那个。
  try {
    const simRoot = join(home, "dsh-remote", "sim-homes");
    if (existsSync(simRoot)) {
      const candidates = [];
      for (const entry of readdirSync(simRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(simRoot, entry.name, "remote-mount.json");
        if (!existsSync(file)) continue;
        const cfg = readJson(file);
        if (!cfg?.sshTarget) continue;
        candidates.push({ cfg, file, at: statSync(file).mtimeMs });
      }
      candidates.sort((left, right) => right.at - left.at);
      const best = candidates[0];
      if (best) {
        return {
          target: best.cfg.sshTarget,
          args: Array.isArray(best.cfg.sshExtraArgs) ? best.cfg.sshExtraArgs : [],
          source: best.file,
        };
      }
    }
  } catch { /* 读不到就走下一级 */ }

  // 2) 主 GUI：servers.json 里第一个远程机器
  const serversFile = join(homedir(), ".dsh", "dsh-remote", "servers.json");
  const servers = readJson(serversFile)?.servers;
  if (Array.isArray(servers)) {
      // 优先非 direct（真·远程机），但 direct 实例本身也可能带 conn（本机起服务 + SSH 挂盘）；
      // 只认非 direct 会让主 GUI 里 exp 直接解析不到目标。
      const remote = servers.find((s) => s?.direct !== true && s?.conn?.host)
        ?? servers.find((s) => s?.conn?.host);
    if (remote) {
      const extra = Number.isFinite(Number(remote.conn.sshPort)) ? ["-p", String(remote.conn.sshPort)] : [];
      return {
        target: `${remote.conn.user ?? "root"}@${remote.conn.host}`,
        args: [...extra, "-o", "StrictHostKeyChecking=accept-new"],
        source: serversFile,
      };
    }
  }

  return null;
}

/**
 * 在远端执行一段 shell，返回 stdout/stderr/退出码。
 * @param command - 要执行的 shell 脚本（可直接多行）。
 * @param options.timeoutMs - 超时；超时会把 timeout 置真。
 */
export function runRemote(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ssh = resolveSsh();
  if (!ssh) {
    return { ok: false, code: null, stdout: "", stderr: "找不到 SSH 目标：既没有 $DSH_HOME/remote-mount.json，servers.json 里也没有远程机器。" };
  }
  const args = [
    // 非交互：拿不到凭据就失败，绝不卡住会话
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    ...ssh.args,
    ssh.target,
    command,
  ];
  const r = spawnSync("ssh", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) {
    return { ok: false, code: null, stdout: r.stdout ?? "", stderr: `ssh 执行失败：${r.error.message}` };
  }
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { ok: r.status === 0, code: r.status, stdout, stderr };
}

/** 供工具描述/报错使用：当前会用哪台机器。 */
export function describeTarget() {
  const ssh = resolveSsh();
  return ssh ? `${ssh.target}（来自 ${ssh.source}）` : "未配置";
}
