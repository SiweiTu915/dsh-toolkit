// dsh-remote — 「换端点」的共用逻辑(CLI 与面板都调这里)
//
// 背景:端点散在三处,少改一处就会出现「文件工具能用、bash 用不了」的半通状态:
//   1. servers.json 的 conn        —— rw.mjs、fs provider、目录选择器(走 ssh2)
//   2. 各分区的挂载配置            —— subprocess provider(bash/glob/grep),写死 sshTarget
//   3. ~/.ssh/config 的 Host 块    —— 你手动 ssh 用(可选)
//
// 这里只做「算改动 + 落盘 + 备份」,不做决定。CLI(repoint.mjs)与面板
// (/api/endpoint)都调它,免得两处逻辑漂移。
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_REMOTE_DIR =
  process.env.DSH_REMOTE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-remote')
export const SSH_CONFIG_FILE = join(homedir(), '.ssh', 'config')

/** 挂载配置的两种命名(见 repoint.mjs 的注释)。 */
const MOUNT_FILES = ['remote-mount.json', 'fs-sftp.json']

/** subprocess provider 用的 ssh 参数:非 22 端口才写 -p,并接受新主机指纹。 */
export function sshExtraArgsFor(port) {
  const args = []
  if (Number(port) !== 22) args.push('-p', String(port))
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  return args
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 该机器在 servers.json 里的条目(找不到返回 null)。 */
export function findServer(name, remoteDir = DEFAULT_REMOTE_DIR) {
  const d = readJson(join(remoteDir, 'servers.json'))
  const list = Array.isArray(d?.servers) ? d.servers : Array.isArray(d) ? d : []
  return list.find((s) => s.name === name) ?? null
}

/** 引用这台机器的所有挂载配置(用于显示与改写)。 */
export function mountConfigsOf(name, remoteDir = DEFAULT_REMOTE_DIR) {
  const homesDir = join(remoteDir, 'sim-homes')
  const out = []
  if (!existsSync(homesDir)) return out
  for (const dir of readdirSync(homesDir)) {
    for (const f of MOUNT_FILES) {
      const file = join(homesDir, dir, f)
      if (!existsSync(file)) continue
      const cfg = readJson(file)
      if (!cfg || cfg.server !== name) continue
      out.push({ home: dir, file, cfg })
    }
  }
  return out
}

/** 读 ~/.ssh/config 里 Host <name> 块(不存在返回 found:false)。 */
export function readSshHostBlock(name, sshConfigFile = SSH_CONFIG_FILE) {
  if (!existsSync(sshConfigFile)) return { found: false, path: sshConfigFile }
  let text
  try { text = readFileSync(sshConfigFile, 'utf8') } catch { return { found: false, path: sshConfigFile } }
  const lines = text.split('\n')
  let inBlock = false
  const got = { found: false, path: sshConfigFile, host: null, port: null, user: null }
  for (const line of lines) {
    const m = /^\s*Host\s+(.*)$/i.exec(line)
    if (m) { inBlock = m[1].split(/\s+/).includes(name); if (inBlock) got.found = true; continue }
    if (!inBlock) continue
    const h = /^\s*HostName\s+(\S+)/i.exec(line); if (h) got.host = h[1]
    const p = /^\s*Port\s+(\d+)/i.exec(line); if (p) got.port = Number(p[1])
    const u = /^\s*User\s+(\S+)/i.exec(line); if (u) got.user = u[1]
  }
  return got
}

/**
 * 现状一眼看全:conn、引用它的挂载配置、ssh 别名,以及三者是否一致。
 * 面板卡片就显示它 —— 否则 direct 分区的卡片只会写「本地实例 :3090」,
 * 真实远程端点根本不露出来。
 */
export function readEndpoint(name, remoteDir = DEFAULT_REMOTE_DIR, sshConfigFile = SSH_CONFIG_FILE) {
  const s = findServer(name, remoteDir)
  const conn = s ? (s.conn ?? s.mirror ?? null) : null
  const mounts = mountConfigsOf(name, remoteDir).map(({ home, file, cfg }) => ({
    home,
    file,
    sshTarget: cfg.sshTarget ?? null,
    sshExtraArgs: Array.isArray(cfg.sshExtraArgs) ? cfg.sshExtraArgs : [],
    remoteRoot: cfg.remoteRoot ?? null,
  }))
  const ssh = readSshHostBlock(name, sshConfigFile)

  const port = conn?.sshPort ?? null
  const host = conn?.host ?? null
  const expectedArgs = port ? sshExtraArgsFor(port) : null
  const checks = []
  if (!conn) checks.push('servers.json 里没有可用的 conn')
  for (const m of mounts) {
    if (m.sshTarget && host && !String(m.sshTarget).endsWith(`@${host}`)) checks.push(`${m.home}: sshTarget 指向别处`)
    const p = m.sshExtraArgs?.[0] === '-p' ? Number(m.sshExtraArgs[1]) : 22
    if (port && p !== Number(port)) checks.push(`${m.home}: 端口 ${p} 与 conn 的 ${port} 不一致`)
  }
  if (ssh.found && host && ssh.host !== host) checks.push('~/.ssh/config 别名指向别处')
  if (ssh.found && port && Number(ssh.port) !== Number(port)) checks.push('~/.ssh/config 别名端口不一致')
  return {
    name,
    conn: conn ? { host, user: conn.user ?? s?.user ?? null, sshPort: port } : null,
    mounts,
    sshConfig: { found: ssh.found, host: ssh.host, port: ssh.port, user: ssh.user, path: ssh.path },
    expectedArgs,
    consistent: checks.length === 0,
    problems: checks,
  }
}

/**
 * 算出「换端点」要改哪些地方(不写盘)。
 * @returns {{ok: boolean, error?: string, nextUser?: string, sshExtraArgs?: number[]|string[], changes?: object[]}}
 */
export function planRepoint({ name, host, port, user, remoteDir = DEFAULT_REMOTE_DIR, sshConfigFile = SSH_CONFIG_FILE }) {
  if (!name) return { ok: false, error: '缺少机器名' }
  const p = Number(port)
  if (!host) return { ok: false, error: '缺少 host' }
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: `端口无效: ${port}` }

  const serversFile = join(remoteDir, 'servers.json')
  if (!existsSync(serversFile)) return { ok: false, error: `读不到 ${serversFile}` }
  const raw = readJson(serversFile)
  const list = Array.isArray(raw?.servers) ? raw.servers : Array.isArray(raw) ? raw : null
  const entry = list?.find((s) => s.name === name)
  if (!entry) return { ok: false, error: `servers.json 里没有机器 "${name}"` }

  const conn = entry.conn ?? entry.mirror ?? {}
  const nextUser = user || conn.user || entry.user || 'root'
  const sshExtraArgs = sshExtraArgsFor(p)
  const changes = []

  changes.push({
    kind: 'servers',
    file: serversFile,
    label: 'servers.json 的 conn',
    before: { host: conn.host ?? entry.host ?? null, user: conn.user ?? entry.user ?? null, sshPort: conn.sshPort ?? entry.sshPort ?? null },
    after: { host, user: nextUser, sshPort: p },
  })

  for (const { home, file, cfg } of mountConfigsOf(name, remoteDir)) {
    changes.push({
      kind: 'mount',
      file,
      label: `挂载配置 ${home}`,
      before: { sshTarget: cfg.sshTarget ?? null, sshExtraArgs: cfg.sshExtraArgs ?? null },
      after: { sshTarget: `${nextUser}@${host}`, sshExtraArgs },
    })
  }

  const ssh = readSshHostBlock(name, sshConfigFile)
  changes.push({
    kind: 'sshConfig',
    file: sshConfigFile,
    label: '~/.ssh/config 的 Host 块',
    found: ssh.found,
    noop: !ssh.found,
    before: { host: ssh.host, port: ssh.port, user: ssh.user },
    after: { host, port: p, user: nextUser },
  })

  return { ok: true, name, host, port: p, nextUser, sshExtraArgs, changes }
}

/** 改写 ~/.ssh/config 里 Host <name> 块(保持其它内容逐字不变)。 */
function rewriteSshHostBlock(name, host, port, user, sshConfigFile) {
  const lines = readFileSync(sshConfigFile, 'utf8').split('\n')
  const out = []
  let inBlock = false
  let seen = { hostname: false, port: false, user: false }
  let found = false
  const flushMissing = () => {
    if (!found) return
    if (!seen.hostname) out.push(`  HostName ${host}`)
    if (!seen.port) out.push(`  Port ${port}`)
    if (!seen.user) out.push(`  User ${user}`)
  }
  for (const line of lines) {
    const hm = /^\s*Host\s+(.*)$/i.exec(line)
    if (hm) {
      if (inBlock) flushMissing()
      inBlock = hm[1].split(/\s+/).includes(name)
      if (inBlock) { found = true; seen = { hostname: false, port: false, user: false } }
      out.push(line)
      continue
    }
    if (inBlock) {
      if (/^\s*HostName\s+/i.test(line)) { seen.hostname = true; out.push(`  HostName ${host}`); continue }
      if (/^\s*Port\s+/i.test(line)) { seen.port = true; out.push(`  Port ${port}`); continue }
      if (/^\s*User\s+/i.test(line)) { seen.user = true; out.push(`  User ${user}`); continue }
    }
    out.push(line)
  }
  flushMissing()
  return { text: out.join('\n'), found }
}

/**
 * 应用改动。dryRun 时不写盘。
 * @returns {{ok:boolean, error?:string, applied:string[], skipped:string[], backups:string[], stamp:string}}
 */
export function applyRepoint({
  name, host, port, user, sshConfig = false,
  remoteDir = DEFAULT_REMOTE_DIR, sshConfigFile = SSH_CONFIG_FILE, dryRun = false,
}) {
  const plan = planRepoint({ name, host, port, user, remoteDir, sshConfigFile })
  if (!plan.ok) return { ok: false, error: plan.error, applied: [], skipped: [], backups: [] }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const applied = []
  const skipped = []
  const backups = []
  const backup = (file) => {
    if (dryRun || !existsSync(file)) return
    const dest = `${file}.bak-${stamp}`
    copyFileSync(file, dest)
    backups.push(dest)
  }

  // 1) servers.json
  const serversFile = join(remoteDir, 'servers.json')
  const raw = readJson(serversFile)
  const list = Array.isArray(raw?.servers) ? raw.servers : raw
  const entry = list.find((s) => s.name === name)
  const conn = entry.conn ?? entry.mirror ?? {}
  entry.conn = { ...conn, host, user: plan.nextUser, sshPort: plan.port }
  if (!dryRun) {
    backup(serversFile)
    const payload = Array.isArray(raw?.servers) ? { ...raw, servers: list } : list
    writeFileSync(serversFile, `${JSON.stringify(payload, null, 2)}\n`)
  }
  applied.push('servers.json 的 conn')

  // 2) 各挂载配置
  for (const { home, file, cfg } of mountConfigsOf(name, remoteDir)) {
    cfg.sshTarget = `${plan.nextUser}@${host}`
    cfg.sshExtraArgs = plan.sshExtraArgs
    if (!dryRun) {
      backup(file)
      writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`)
    }
    applied.push(`挂载配置 ${home}`)
  }

  // 3) ~/.ssh/config(可选,且只动同名 Host 块)
  if (!sshConfig) {
    skipped.push('~/.ssh/config(未开启)')
  } else if (!existsSync(sshConfigFile)) {
    skipped.push('~/.ssh/config(文件不存在)')
  } else {
    const { text, found } = rewriteSshHostBlock(name, host, plan.port, plan.nextUser, sshConfigFile)
    if (!found) {
      skipped.push(`~/.ssh/config(没有 Host ${name} 块)`)
    } else {
      if (!dryRun) {
        backup(sshConfigFile)
        writeFileSync(sshConfigFile, text)
      }
      applied.push('~/.ssh/config 的 Host 块')
    }
  }

  return { ok: true, plan, applied, skipped, backups, stamp, dryRun }
}
