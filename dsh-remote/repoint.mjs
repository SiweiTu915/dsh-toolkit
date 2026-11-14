#!/usr/bin/env node
/**
 * repoint.mjs —— 把一台机器的「连接端点」一次改全。
 *
 * 典型场景:云上克隆/重启了一台实例(数据/系统盘不变,只有 host 与端口变),
 * 想把现有工作台直接指过去,而不是重建一个分区。
 *
 * 端点散落在三处,少改一处就会出现「文件工具能用、bash 用不了」的半通状态:
 *   1. servers.json 的 conn        —— rw.mjs、fs provider、目录选择器(走 ssh2)
 *   2. 各分区的挂载配置            —— subprocess provider(bash/glob/grep)
 *      没显式写 sshTarget 时会退回 `ssh <机器名>`,依赖 ~/.ssh/config 别名
 *   3. ~/.ssh/config 的 Host 块    —— 你手动 `ssh <别名>` 用(--ssh-config 时才改)
 *
 * 本脚本把 1 与 2 一次写死(2 直接写 `user@host` + `-p 端口`,不再依赖别名),
 * 3 需要显式 `--ssh-config` 才动 —— 那是你的私人文件。
 *
 * 逻辑都在 lib/repoint.mjs(面板的「换端点」按钮调的是同一份),这里只做参数解析与打印。
 *
 * 用法:
 *   node repoint.mjs <机器名> --host <新主机> --port <新端口> [--user root]
 *   node repoint.mjs <机器名> --host <新主机> --port <新端口> --dry-run
 *   node repoint.mjs <机器名> --host <新主机> --port <新端口> --ssh-config
 *   node repoint.mjs <机器名> --show          # 只看当前端点与一致性,不改任何东西
 *   node repoint.mjs --undo [--stamp <批次>] [--yes]   # 回滚到某批备份(默认只预览)
 *
 * 改完记得重启受影响的分区实例(面板上「断开」再「连接」)。
 */
import { DEFAULT_REMOTE_DIR, SSH_CONFIG_FILE, planRepoint, applyRepoint, readEndpoint, listRepointBackups, undoRepoint } from './lib/repoint.mjs'

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const name = argv[0]
// --undo 不需要机器名:它是按备份批次还原,先放行
if (!name || (name.startsWith('--') && !flag('--undo'))) {
  die('用法: node repoint.mjs <机器名> --host <主机> --port <端口> [--user root] [--dry-run] [--ssh-config] | --show')
}

// ── --undo:回滚到某批备份(默认只预览,加 --yes 才写) ──────────────────────
if (flag('--undo')) {
  const stamp = opt('--stamp')
  const rows = listRepointBackups()
  if (rows.length === 0) die('没有找到任何 repoint 备份')
  const target = stamp ?? rows[0].stamp
  const preview = undoRepoint({ stamp: target, dryRun: true })
  if (!preview.ok) die(preview.error)
  console.log(`批次 ${target}（共 ${rows.filter((r) => r.stamp === target).length} 个备份）`)
  for (const file of preview.restored) console.log(`  将还原  ${file.replace(process.env.HOME ?? '', '~')}`)
  if (!flag('--yes')) {
    console.log()
    console.log('（预览。确认无误后加 --yes 真正回滚；回滚前会把当前状态另存为 *.pre-undo-<时间>）')
    process.exit(0)
  }
  const done = undoRepoint({ stamp: target, dryRun: false })
  if (!done.ok) die(done.error)
  console.log()
  console.log(`✓ 已还原 ${done.restored.length} 个文件`)
  if (done.saved?.length) console.log(`  回滚前的状态已另存: ${done.saved.length} 个 (*.pre-undo-*)`)
  console.log('  下一步:在面板上把受影响的分区「断开」再「连接」')
  process.exit(0)
}

// ── --show:只看现状 ────────────────────────────────────────────────────────
if (flag('--show')) {
  const ep = readEndpoint(name, DEFAULT_REMOTE_DIR, SSH_CONFIG_FILE)
  if (!ep.conn) die(`servers.json 里没有机器 "${name}" 的可写 conn`)
  console.log(`${name} 当前端点`)
  console.log(`  conn(servers.json)   ${ep.conn.user}@${ep.conn.host}:${ep.conn.sshPort}`)
  for (const m of ep.mounts) {
    const p = m.sshExtraArgs?.[0] === '-p' ? m.sshExtraArgs[1] : '22'
    console.log(`  挂载配置 ${m.home.padEnd(14)} ${m.sshTarget} -p ${p}  (remoteRoot=${m.remoteRoot})`)
  }
  console.log(`  ~/.ssh/config 别名   ${ep.sshConfig.found ? `${ep.sshConfig.user}@${ep.sshConfig.host}:${ep.sshConfig.port}` : '(没有该 Host 块)'}`)
  console.log(ep.consistent ? '  ✓ 三处一致' : `  ✗ 不一致: ${ep.problems.join('; ')}`)
  process.exit(ep.consistent ? 0 : 1)
}

// ── 换端点 ────────────────────────────────────────────────────────────────
const host = opt('--host')
const portRaw = opt('--port')
const user = opt('--user')
const dryRun = flag('--dry-run')
const alsoSshConfig = flag('--ssh-config')
if (!host) die('缺少 --host')
if (portRaw === undefined) die('缺少 --port')

const port = Number(portRaw)
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`--port 无效: ${portRaw}`)

const pre = planRepoint({ name, host, port, user })
if (!pre.ok) die(pre.error)

console.log(`机器: ${pre.name}`)
console.log(`新端点: ${pre.nextUser}@${pre.host}:${pre.port}${dryRun ? '   [dry-run,不写盘]' : ''}`)
console.log()

const r = applyRepoint({ name, host, port, user, sshConfig: alsoSshConfig, dryRun })
if (!r.ok) die(r.error)

const c1 = r.plan.changes.find((x) => x.kind === 'servers')
console.log('1) servers.json 的 conn')
console.log(`   ${c1.before.host ?? '-'}:${c1.before.sshPort ?? '-'} (${c1.before.user ?? '-'})  →  ${c1.after.host}:${c1.after.sshPort} (${c1.after.user})`)
console.log()

console.log('2) 分区挂载配置(写死 sshTarget,不再依赖 ssh 别名)')
const mounts = r.plan.changes.filter((x) => x.kind === 'mount')
if (!mounts.length) console.log('   (没有分区引用这台机器)')
for (const m of mounts) {
  console.log(`   ${m.label.replace('挂载配置 ', '')}  →  sshTarget=${m.after.sshTarget}  sshExtraArgs=${JSON.stringify(m.after.sshExtraArgs)}`)
}
console.log()

console.log('3) ~/.ssh/config')
const c3 = r.plan.changes.find((x) => x.kind === 'sshConfig')
if (!alsoSshConfig) console.log('   跳过(要同步你手动用的别名,加 --ssh-config)')
else if (!c3.found) console.log(`   ✗ 没有 Host ${name} 块,未改动(要新建请手动编辑)`)
else console.log(`   Host ${name} → HostName ${c3.after.host} / Port ${c3.after.port} / User ${c3.after.user}`)
console.log()

console.log(dryRun ? '（dry-run:什么都没写）' : '完成。下一步:在面板上把受影响的分区「断开」再「连接」,让实例重新读取配置。')
if (!dryRun) {
  const homes = mounts.map((x) => x.label.replace('挂载配置 ', ''))
  if (homes.length) console.log(`  受影响分区: ${homes.join(', ')}`)
  if (r.backups.length) console.log(`  被改动的文件已备份: ${r.backups.length} 个(*.bak-${r.stamp})`)
}
