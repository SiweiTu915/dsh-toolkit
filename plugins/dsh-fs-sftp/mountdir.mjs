#!/usr/bin/env node
/**
 * mountdir.mjs —— 为远程目录在本机建一个空的占位目录,让 dsh 的
 * 「Add workspace」能选中它。
 *
 * 为什么需要:工作区注册表(dsh-workspace)用 **宿主机** node:fs/promises 的
 * realpath + stat 校验目录,不经过 ctx.fs。所以想把某个远程项目作为独立工作区,
 * 本机必须存在同名占位目录(空的,0 字节)。
 *
 * 用法:
 *   node mountdir.mjs /root/project          # 建占位目录并打印可粘贴路径
 *   node mountdir.mjs --list                          # 列出已有占位目录
 *   node mountdir.mjs --rm /root/project     # 删掉空占位目录
 *   node mountdir.mjs --config <path> /root/xxx       # 指定 fs-sftp.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'

function die(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const configFlag = argv.indexOf('--config')
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
// 与三个 provider 一致:优先 remote-mount.json,退回旧名 fs-sftp.json。
const configPath = configFlag !== -1
  ? argv[configFlag + 1]
  : [join(home, 'remote-mount.json'), join(home, 'fs-sftp.json')].find((file) => existsSync(file)) ?? join(home, 'remote-mount.json')

if (!existsSync(configPath)) die(`找不到配置 ${configPath}(需要 localRoot / remoteRoot)`)
let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (error) {
  die(`解析 ${configPath} 失败: ${error.message}`)
}
const localRoot = config.localRoot
const remoteRoot = posix.normalize(config.remoteRoot || '/')
if (typeof localRoot !== 'string' || !localRoot) die(`${configPath} 里缺少 localRoot`)
mkdirSync(localRoot, { recursive: true })

/** 远程路径 → 本机占位路径。 */
function placeholderFor(remote) {
  const p = posix.normalize(remote)
  if (p !== remoteRoot && !p.startsWith(remoteRoot === '/' ? '/' : remoteRoot + '/')) {
    die(`"${p}" 不在 remoteRoot ${remoteRoot} 之内`)
  }
  if (p === remoteRoot) return localRoot
  return posix.join(localRoot, p.slice(remoteRoot === '/' ? 1 : remoteRoot.length + 1))
}

function list() {
  const rows = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      const remote = prefix === '' ? posix.join(remoteRoot, entry.name) : posix.join(prefix, entry.name)
      const empty = readdirSync(full).length === 0
      rows.push(`${empty ? '○' : '●'} ${remote}  →  ${full}${empty ? '   (空占位)' : ''}`)
      walk(full, remote)
    }
  }
  walk(localRoot, '')
  if (rows.length === 0) console.log('(还没有任何占位目录)')
  else for (const row of rows) console.log(row)
  console.log(`\n挂载点: ${remoteRoot}  →  ${localRoot}`)
}

const rmIndex = argv.indexOf('--rm')
// 跳过 --config 的值参数;不能只按下标算,否则 configFlag 为 -1 时会误吞第一个位置参数。
const skip = new Set(configFlag !== -1 ? [configFlag, configFlag + 1] : [])
const targets = argv.filter((a, i) => !a.startsWith('--') && !skip.has(i))

if (argv.includes('--list')) {
  list()
} else if (rmIndex !== -1) {
  const target = argv[rmIndex + 1]
  if (!target) die('--rm 后面要给远程路径')
  const placeholder = placeholderFor(target)
  if (!existsSync(placeholder)) die(`占位目录不存在: ${placeholder}`)
  if (readdirSync(placeholder).length > 0) die(`占位目录非空,拒绝删除: ${placeholder}`)
  rmdirSync(placeholder)
  console.log(`✓ 已删除空占位目录 ${placeholder}`)
} else if (targets.length > 0) {
  for (const remote of targets) {
    const placeholder = placeholderFor(remote)
    const existed = existsSync(placeholder)
    mkdirSync(placeholder, { recursive: true })
    if (!statSync(placeholder).isDirectory()) die(`${placeholder} 不是目录`)
    console.log(`${existed ? '○ 已存在' : '✓ 已创建'}  ${remote}`)
    console.log(`   在 dsh 里 Add workspace 选: ${placeholder}`)
  }
} else {
  console.log('用法: node mountdir.mjs <远程绝对路径...> | --list | --rm <远程路径>')
  console.log(`(当前配置 ${configPath}: ${remoteRoot} → ${localRoot})`)
}
