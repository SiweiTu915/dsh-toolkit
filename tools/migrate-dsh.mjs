#!/usr/bin/env node
/**
 * dsh 迁移工具（零依赖，Node 22+）—— 打包 / 还原整套 DSH 工作台。
 *
 * pack：把 $DSH_HOME 的数据、配置、插件、dsh-remote、工具打包成一个 tar.gz；
 *       引擎（harness 安装）不打包，只记录版本号，还原时重装（跨机器/跨 OS 安全）。
 * restore：在新机器上解包 → 重写绝对路径 → 重装指定版本引擎 → 写 state → 冒烟验证。
 *
 * 用法：
 *   node ~/.dsh/migrate-dsh.mjs pack [--out <文件>] [--exclude-sessions] [--exclude-credentials]
 *   node ~/.dsh/migrate-dsh.mjs list <归档>                      # 还原前预览内容
 *   node ~/.dsh/migrate-dsh.mjs restore <归档> [--home <目录>]
 *       [--engine <版本>] [--no-engine] [--force] [--npm-cache <目录>] [--no-smoke]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, chmodSync, rmSync, symlinkSync, renameSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'

const PKG = '@deepseek-ai/dsh'
const TOOL_NAME = 'migrate-dsh'

function resolveHome() {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') return resolve(argv[i + 1])
  }
  return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
}
const HOME = resolveHome()

const now = () => new Date().toISOString()
const log = (s = '') => console.log(s)
function die(msg, code = 1) { console.error(`✗ ${msg}`); process.exit(code) }
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
function writeJson(p, o) { writeFileSync(p, JSON.stringify(o, null, 2) + '\n') }

/** 顶层要排除的条目（可再生成 / 大件 / 运行时状态）。 */
const EXCLUDES = [
  'harness',        // 引擎：还原时按 manifest 版本重装
  '.npm-cache',     // npm 缓存：还原时重建
  'backups',        // 更新备份：迁移不需要
  '.update-tmp-*',  // 冒烟测试临时目录
  'dsh-remote/.state', // 隧道 PID 运行时状态
  '.migrate-manifest.json',
  '.migrate-tmp',
]

function excludeFlags(extra = []) {
  const all = [...EXCLUDES, ...extra]
  return all.map((e) => `--exclude=${e}`)
}

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------

async function cmdPack(opts) {
  const out = opts.out || join(process.cwd(), `dsh-migrate-${now().replace(/[:.]/g, '-')}.tar.gz`)
  if (existsSync(out)) die(`输出文件已存在: ${out}`)
  const extra = []
  if (opts.excludeSessions) extra.push('sessions')
  if (opts.excludeCredentials) extra.push('.credentials.yaml')

  const state = readJson(join(HOME, 'harness', 'state.json'))
  const manifest = {
    tool: TOOL_NAME,
    version: 1,
    createdAt: now(),
    sourceHost: hostname(),
    sourceHome: HOME,
    harness: {
      current: state?.current ?? null,
      managed: (() => {
        const dir = join(HOME, 'harness')
        return readdirSafe(dir).filter((d) => d !== 'current' && existsSync(join(dir, d, 'node_modules', PKG, 'package.json')))
      })(),
    },
    includes: {
      sessions: !opts.excludeSessions,
      credentials: !opts.excludeCredentials,
      simHomes: true,
      agents: existsSync(join(homedir(), '.agents')),
    },
  }

  // manifest 先进临时目录，与 home 内容一起打进归档根
  const tmp = join(HOME, '.migrate-tmp')
  mkdirSync(tmp, { recursive: true })
  writeJson(join(tmp, 'manifest.json'), manifest)

  const r = spawnSync('tar', [
    '-czf', out,
    ...excludeFlags(extra),
    '-C', tmp, 'manifest.json',
    '-C', HOME, '.',
  ], { encoding: 'utf8' })
  rmSync(tmp, { recursive: true, force: true })
  if (r.status !== 0) die(`打包失败: ${r.stderr || r.stdout}`)

  chmodSync(out, 0o600)
  const size = (statSync(out).size / 1048576).toFixed(1)
  log(`✓ 已打包: ${out} (${size}M)`)
  log(`  来源: ${HOME} @ ${manifest.sourceHost}`)
  log(`  引擎版本: ${manifest.harness.current ?? '（未受管）'}${manifest.harness.managed.length ? `，受管目录 ${manifest.harness.managed.join(', ')}` : ''}`)
  log(`  包含: 会话${manifest.includes.sessions ? '✓' : '✗'} 凭据${manifest.includes.credentials ? '✓' : '✗'} sim-homes✓ 引擎✗(还原时重装)`)
  if (manifest.includes.credentials) {
    log('  注意: 归档含 .credentials.yaml(0600 权限)。请勿上传公开仓库；如需分享请用 --exclude-credentials。')
  }
  return out
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function readManifest(archive) {
  const r = spawnSync('tar', ['-xzf', archive, '-O', 'manifest.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0) die(`不是有效的迁移归档(缺少 manifest.json): ${archive}`)
  try { return JSON.parse(r.stdout) } catch { die('归档 manifest.json 无法解析') }
}

function listArchive(archive) {
  const r = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) die(`无法读取归档: ${archive}`)
  const files = r.stdout.split('\n').filter(Boolean)
  const count = files.length
  const top = new Map()
  for (const f of files) { const k = f.split('/')[0]; top.set(k, (top.get(k) ?? 0) + 1) }
  return { files, count, top }
}

function cmdList(archive) {
  if (!existsSync(archive)) die(`归档不存在: ${archive}`)
  const m = readManifest(archive)
  log(`归档: ${archive}`)
  log(`  来源: ${m.sourceHome} @ ${m.sourceHost}，创建于 ${m.createdAt}`)
  log(`  引擎版本: ${m.harness.current ?? '（未记录）'}`)
  log(`  包含: 会话${m.includes?.sessions ? '✓' : '✗'} 凭据${m.includes?.credentials ? '✓' : '✗'} sim-homes${m.includes?.simHomes ? '✓' : '✗'}${m.includes?.agents ? ' agents✓' : ''}`)
  const { count, top } = listArchive(archive)
  log(`  条目数: ${count}`)
  for (const [k, n] of [...top.entries()].sort((a, b) => b[1] - a[1])) log(`    ${k}/  ×${n}`)
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

function readdirSafe(dir) { try { return statSync(dir).isDirectory() ? readdirSync(dir) : [] } catch { return [] } }

function isHomePopulated(home) {
  return ['sessions', 'profiles', 'settings.yaml', 'storages'].some((k) => existsSync(join(home, k)))
}

/** 在文本文件里替换源 home 绝对路径为目标的（dsh-remote 服务器清单等）。 */
function rewritePaths(home, sourceHome, targetHome, relPaths) {
  for (const rel of relPaths) {
    const p = join(home, rel)
    if (!existsSync(p)) continue
    let text
    try { text = readFileSync(p, 'utf8') } catch { continue }
    if (!text.includes(sourceHome)) continue
    writeFileSync(p, text.split(sourceHome).join(targetHome))
    log(`  ✓ 已重写路径: ${rel} (${sourceHome} → ${targetHome})`)
  }
}

function writeShim(home) {
  const dir = join(home, 'bin')
  mkdirSync(dir, { recursive: true })
  const shim = join(dir, 'dsh')
  writeFileSync(shim, `#!/bin/sh\n# dsh shim — 由 ${TOOL_NAME}/update-dsh.mjs 维护\nexec "${join(home, 'harness', 'current', 'node_modules', '.bin', 'dsh')}" "$@"\n`)
  chmodSync(shim, 0o755)
}

/** 重装引擎（与 update-dsh.mjs 相同的容错：EPERM 换独立缓存、OOM 提堆上限）。 */
async function installEngine(targetHome, version, npmCache) {
  const dir = join(targetHome, 'harness', version)
  mkdirSync(dir, { recursive: true })
  log(`  安装引擎 ${PKG}@${version} → ${dir}（首次约 300–400MB）...`)
  const cache = npmCache || join(targetHome, '.npm-cache')
  const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=4096'].filter(Boolean).join(' ') }
  const runInstall = (extra) => spawnSync('npm', ['install', '--prefix', dir, ...extra, '--no-audit', '--no-fund', '--loglevel=error', `${PKG}@${version}`], { encoding: 'utf8', timeout: 10 * 60 * 1000, env })
  let r = runInstall(['--cache', cache])
  if (r.status !== 0 && /EPERM|root-owned/.test(r.stderr || '')) {
    log(`  警告: 默认缓存不可写，用独立缓存重试: ${cache}`)
    r = runInstall(['--cache', cache])
  }
  if (r.status !== 0) die(`引擎安装失败:\n${(r.stderr || '').split('\n').slice(-8).join('\n')}`)
  const bin = join(dir, 'node_modules', '.bin', 'dsh')
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (v.status !== 0 || !v.stdout.trim()) die('引擎安装后版本校验失败')
  log(`  ✓ 引擎 ${v.stdout.trim()} 安装完成`)
  return dir
}

async function cmdRestore(archive, opts) {
  if (!existsSync(archive)) die(`归档不存在: ${archive}`)
  const manifest = readManifest(archive)
  const target = opts.home || HOME
  const sourceHome = manifest.sourceHome
  if (resolve(target) === resolve(sourceHome)) {
    die('目标 home 与归档来源相同（本机原地还原有风险），请用 --home 指定其他目录')
  }
  if (isHomePopulated(target) && !opts.force) {
    die(`目标目录已有数据: ${target}\n  确认覆盖请加 --force（建议先备份现有内容）`)
  }

  mkdirSync(target, { recursive: true })
  log(`还原到: ${target}`)
  const r = spawnSync('tar', ['-xzf', archive, '-C', target], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) die(`解包失败: ${r.stderr || r.stdout}`)
  // manifest.json 落到 home 根目录 → 保留为迁移记录
  if (existsSync(join(target, 'manifest.json')) && !existsSync(join(target, '.migrate-manifest.json'))) {
    renameSync(join(target, 'manifest.json'), join(target, '.migrate-manifest.json'))
  }

  // 绝对路径重写（dsh-remote 服务器清单里 sim-homes 的 home 字段）
  rewritePaths(target, sourceHome, target, ['dsh-remote/servers.json', 'dsh-remote/servers.sim.json'])

  // 引擎
  if (!opts.noEngine) {
    const version = opts.engine || manifest.harness.current
    if (!version) die('归档未记录引擎版本，请用 --engine <版本> 指定，或 --no-engine 只还原数据')
    await installEngine(target, version, opts.npmCache)
    const harnessDir = join(target, 'harness')
    const currentLink = join(harnessDir, 'current')
    rmSync(currentLink, { force: true })
    symlinkSync(join(harnessDir, version), currentLink)
    writeJson(join(harnessDir, 'state.json'), {
      current: version,
      currentPath: join(harnessDir, version),
      previous: null,
      history: [{ from: '(migrated)', to: version, at: now(), backup: archive }],
      updatedAt: now(),
    })
    log(`  ✓ 已切换 current → ${version}`)
    writeShim(target)

    // 冒烟：真实配置能否组合（dump-config 与启动同算法）
    if (!opts.noSmoke) {
      const bin = join(harnessDir, 'current', 'node_modules', '.bin', 'dsh')
      const smoke = spawnSync(bin, ['--profile', 'web', '--dump-config'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_HOME: target } })
      if (smoke.status !== 0) {
        log(`  警告: 还原后配置组合失败（可排查后重试，或 --no-smoke 跳过）:\n${(smoke.stderr || '').slice(-800)}`)
      } else {
        const ids = [...smoke.stdout.matchAll(/^- id: (\S+)/gm)].length
        log(`  ✓ 配置冒烟通过（${ids} 个条目可组合）`)
      }
    }
  }

  log('')
  log('✓ 还原完成。接下来：')
  log(`  1. 启动 GUI: ${join(target, 'bin', 'dsh')} web（或把 ${join(target, 'bin')} 加入 PATH 后直接 dsh web）`)
  log('  2. 检查历史会话是否都在侧边栏')
  log('  3. dsh-remote: node dsh-remote/cli.mjs connect <名字> 重建隧道')
  if (opts.noEngine) log('  4. 引擎未安装: node update-dsh.mjs update 安装并切换（或 restore --engine <版本>）')
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const opts = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--out') opts.out = rest[++i]
    else if (a === '--home') opts.home = rest[++i]
    else if (a === '--engine') opts.engine = rest[++i]
    else if (a === '--npm-cache') opts.npmCache = rest[++i]
    else if (a === '--exclude-sessions') opts.excludeSessions = true
    else if (a === '--exclude-credentials') opts.excludeCredentials = true
    else if (a === '--no-engine') opts.noEngine = true
    else if (a === '--no-smoke') opts.noSmoke = true
    else if (a === '--force') opts.force = true
    else positional.push(a)
  }
  switch (cmd) {
    case 'pack': await cmdPack(opts); break
    case 'list': cmdList(positional[0]); break
    case 'restore': await cmdRestore(positional[0], opts); break
    default: die(`用法见文件头部注释。当前 HOME=${HOME}`)
  }
}

main().catch((e) => die(e?.message ?? String(e)))
