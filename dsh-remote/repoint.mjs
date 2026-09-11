#!/usr/bin/env node
/**
 * repoint.mjs —— 把一台机器的「连接端点」一次改全。
 *
 * 典型场景:在云控制台**克隆**了一台新实例(数据/系统盘都克隆过来了,只有
 * host 和端口变了),想把现有工作台直接指过去,而不是重建一个分区。
 *
 * 端点散落在三处,少改一处就会出现「文件工具能用、bash 用不了」这类半通状态:
 *   1. servers.json 的 conn        —— rw.mjs、fs provider、目录选择器(走 ssh2)
 *   2. 各分区的 remote-mount.json  —— subprocess provider(bash/glob/grep)
 *      没显式写 sshTarget 时会退回 `ssh <机器名>`,依赖 ~/.ssh/config 别名
 *   3. ~/.ssh/config 的 Host 块    —— 你手动 `ssh <别名>` 用(--ssh-config 时才改)
 *
 * 本脚本把 1 与 2 一次写死(2 直接写 `user@host` + `-p 端口`,不再依赖别名),
 * 3 需要显式 `--ssh-config` 才动 —— 那是你的私人文件。
 *
 * 用法:
 *   node repoint.mjs <机器名> --host <新主机> --port <新端口> [--user root]
 *   node repoint.mjs <机器名> --host <新主机> --port <新端口> --dry-run
 *   node repoint.mjs <机器名> --host <新主机> --port <新端口> --ssh-config
 *
 * 改完记得重启受影响的分区实例(面板上「断开」再「连接」)。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REMOTE_DIR = process.env.DSH_REMOTE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-remote')
const SERVERS_FILE = join(REMOTE_DIR, 'servers.json')
const SSH_CONFIG = join(homedir(), '.ssh', 'config')

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const name = argv[0]
if (!name || name.startsWith('--')) die('用法: node repoint.mjs <机器名> --host <主机> --port <端口> [--user root] [--dry-run] [--ssh-config]')

const host = opt('--host')
const portRaw = opt('--port')
const user = opt('--user')
const dryRun = flag('--dry-run')
const alsoSshConfig = flag('--ssh-config')
if (!host) die('缺少 --host')
const port = Number(portRaw)
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`--port 无效: ${portRaw}`)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = (file) => {
  if (!existsSync(file) || dryRun) return
  copyFileSync(file, `${file}.bak-${stamp}`)
}

console.log(`机器: ${name}`)
console.log(`新端点: ${user ?? '(沿用)'}@${host}:${port}${dryRun ? '   [dry-run,不写盘]' : ''}`)
console.log()

// ── 1) servers.json ────────────────────────────────────────────────────────
if (!existsSync(SERVERS_FILE)) die(`读不到 ${SERVERS_FILE}`)
const serversRaw = JSON.parse(readFileSync(SERVERS_FILE, 'utf8'))
const entry = (serversRaw.servers ?? []).find((s) => s.name === name)
if (!entry) die(`servers.json 里没有机器 "${name}"`)
const conn = entry.conn ?? entry.mirror ?? {}
const nextUser = user ?? conn.user ?? entry.user ?? 'root'
const before = { host: conn.host ?? entry.host, user: conn.user ?? entry.user, sshPort: conn.sshPort ?? entry.sshPort }
entry.conn = { ...conn, host, user: nextUser, sshPort: port }
console.log('1) servers.json 的 conn')
console.log(`   ${before.host ?? '-'}:${before.sshPort ?? '-'} (${before.user ?? '-'})  →  ${host}:${port} (${nextUser})`)
if (!dryRun) {
  backup(SERVERS_FILE)
  writeFileSync(SERVERS_FILE, `${JSON.stringify(serversRaw, null, 2)}\n`)
}

// ── 2) 各分区的挂载配置 ────────────────────────────────────────────────────
const sshExtraArgs = []
if (port !== 22) sshExtraArgs.push('-p', String(port))
sshExtraArgs.push('-o', 'StrictHostKeyChecking=accept-new')

const homesDir = join(REMOTE_DIR, 'sim-homes')
const touched = []
for (const dir of existsSync(homesDir) ? readdirSync(homesDir) : []) {
  for (const file of ['remote-mount.json', 'fs-sftp.json']) {
    const path = join(homesDir, dir, file)
    if (!existsSync(path)) continue
    let cfg
    try { cfg = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
    if (cfg.server !== name) continue
    cfg.sshTarget = `${nextUser}@${host}`
    cfg.sshExtraArgs = sshExtraArgs
    if (!dryRun) {
      backup(path)
      writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`)
    }
    touched.push(`${dir}/${file}`)
  }
}
console.log()
console.log('2) 分区挂载配置(写死 sshTarget,不再依赖 ssh 别名)')
if (touched.length === 0) console.log('   (没有分区引用这台机器)')
for (const t of touched) console.log(`   ${t}  →  sshTarget=${nextUser}@${host}  sshExtraArgs=${JSON.stringify(sshExtraArgs)}`)

// ── 3) ~/.ssh/config(可选,只动同名 Host 块)──────────────────────────────
console.log()
if (!alsoSshConfig) {
  console.log('3) ~/.ssh/config —— 跳过(要同步你手动用的别名,加 --ssh-config)')
} else if (!existsSync(SSH_CONFIG)) {
  console.log(`3) ~/.ssh/config —— 不存在,跳过`)
} else {
  const lines = readFileSync(SSH_CONFIG, 'utf8').split('\n')
  const out = []
  let inBlock = false
  let seen = { hostname: false, port: false, user: false }
  let found = false
  const flushMissing = () => {
    if (!found) return
    if (!seen.hostname) out.push(`  HostName ${host}`)
    if (!seen.port) out.push(`  Port ${port}`)
    if (!seen.user) out.push(`  User ${nextUser}`)
  }
  for (const line of lines) {
    const hostMatch = /^\s*Host\s+(.*)$/i.exec(line)
    if (hostMatch) {
      if (inBlock) flushMissing()
      inBlock = hostMatch[1].split(/\s+/).includes(name)
      if (inBlock) { found = true; seen = { hostname: false, port: false, user: false } }
      out.push(line)
      continue
    }
    if (inBlock) {
      if (/^\s*HostName\s+/i.test(line)) { seen.hostname = true; out.push(`  HostName ${host}`); continue }
      if (/^\s*Port\s+/i.test(line)) { seen.port = true; out.push(`  Port ${port}`); continue }
      if (/^\s*User\s+/i.test(line)) { seen.user = true; out.push(`  User ${nextUser}`); continue }
    }
    out.push(line)
  }
  flushMissing()
  console.log('3) ~/.ssh/config')
  if (!found) {
    console.log(`   ✗ 没有 Host ${name} 块,未改动(要新建请手动编辑)`)
  } else {
    console.log(`   Host ${name} → HostName ${host} / Port ${port} / User ${nextUser}`)
    if (!dryRun) {
      backup(SSH_CONFIG)
      writeFileSync(SSH_CONFIG, out.join('\n'))
    }
  }
}

console.log()
console.log(dryRun ? '（dry-run:什么都没写）' : '完成。下一步:在面板上把受影响的分区「断开」再「连接」,让实例重新读取配置。')
if (touched.length > 0 && !dryRun) {
  console.log(`  受影响分区: ${[...new Set(touched.map((t) => t.split('/')[0]))].join(', ')}`)
}
if (!dryRun) console.log('  被改动的文件已备份为 *.bak-<时间戳>')
