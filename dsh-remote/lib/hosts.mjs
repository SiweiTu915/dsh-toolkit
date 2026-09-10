// dsh-remote — 主机清单与连接参数解析(供 rw.mjs / mirror.mjs 共用)
//
// 连接信息优先级:命令行参数 → 机器条目的 mirror/conn 字段 → servers.json 的主机字段
// (仅当它不是本机回环)。这样"本机 GPU 分区"(host=127.0.0.1 的 direct 条目)
// 也能挂远程连接。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const REMOTE_DIR = join(DSH_HOME, 'dsh-remote')
export const SERVERS_FILE = join(REMOTE_DIR, 'servers.json')

export function loadServers() {
  try { return JSON.parse(readFileSync(SERVERS_FILE, 'utf8')) } catch { return { servers: [] } }
}

export function saveServers(data) {
  mkdirSync(dirname(SERVERS_FILE), { recursive: true })
  writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2) + '\n')
}

export function findServer(name) {
  const all = loadServers().servers ?? []
  const s = all.find((x) => x.name === name)
  if (!s) {
    const names = all.map((x) => x.name).join(', ') || '无'
    throw new Error(`servers.json 里没有机器 "${name}"(可用: ${names})`)
  }
  return s
}

/**
 * 解析 SSH 连接参数。opts 可含 host/user/port/keyPath 覆盖。
 * @returns {{ host, user, port, keyPath }}
 */
export function resolveConn(server, opts = {}) {
  const cfg = server.mirror ?? server.conn ?? {}
  let host = opts.host || cfg.host
  let user = opts.user || cfg.user
  let port = Number(opts.port || cfg.sshPort || 0)
  if (!host) {
    const entryHost = server.host
    if (entryHost && entryHost !== '127.0.0.1' && entryHost !== 'localhost') {
      host = entryHost
      user = user || server.user
      port = port || Number(server.sshPort ?? 22)
    }
  }
  if (!host) {
    throw new Error(`机器 "${server.name}" 没有可用的 SSH 连接信息。\n` +
      `  用法: 加 --host <主机> --user <用户> [--port <端口>]，或在该条目上写 conn: { host, user, sshPort }`)
  }
  return { host, user: user || 'root', port: port || 22, keyPath: opts.keyPath || cfg.keyPath || server.keyPath }
}
