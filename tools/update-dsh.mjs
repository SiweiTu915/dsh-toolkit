#!/usr/bin/env node
/**
 * dsh 自动更新工具（零依赖，Node 22+）
 *
 * 原理：把 harness 装进 $DSH_HOME/harness/<version> 的受管目录（不再依赖 npx 缓存），
 * 用 $DSH_HOME/harness/current 符号链接指向当前版本，更新时：
 *   备份用户配置 → 预取新版本 → 冒烟测试 → 新旧配置 diff → 原子切换 → 可回滚。
 * 用户的 profile（插件、cordis.patch.yml）放在 $DSH_HOME/profiles 下，更新时绝不触碰。
 *
 * 用法：
 *   node ~/.dsh/update-dsh.mjs status                查看当前/最新版本
 *   node ~/.dsh/update-dsh.mjs check                 检查更新 + 发布说明
 *   node ~/.dsh/update-dsh.mjs update [--to x.y.z] [--channel <dist-tag>]
 *       [--profile web] [--yes] [--no-smoke] [--force] [--no-path] [--home DIR]
 *   node ~/.dsh/update-dsh.mjs install <version>     只预取版本，不切换
 *   node ~/.dsh/update-dsh.mjs rollback              回滚到上一个版本
 *   node ~/.dsh/update-dsh.mjs versions              列出已安装版本
 *   node ~/.dsh/update-dsh.mjs prune [--keep N]      清理旧版本(保留 current+回滚目标+最近 N-1 个)
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, readlinkSync, rmSync, statSync, chmodSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename, isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const PKG = '@deepseek-ai/dsh'
const REGISTRY_URL = 'https://registry.npmjs.org/' + encodeURIComponent(PKG)
const REPO = 'deepseek-ai/deepseek-harness'
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`
const NET_TIMEOUT_MS = 10000
const BOOT_SMOKE_MS = 20000
const MAX_DIFF_LINES = 120

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString()
const log = (s = '') => console.log(s)

function die(msg, code = 1) {
  console.error(`✗ ${msg}`)
  process.exit(code)
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error) throw new Error(`无法执行 ${cmd}: ${r.error.message}`)
  return r
}

async function fetchJson(url, timeoutMs = NET_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'dsh-update-tool' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res.json()
}

function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function writeJsonFile(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n')
}

/** 宽松 semver 解析（支持 0.1.1-rc.2 这类预发布版本号）。 */
function parseVer(v) {
  if (typeof v !== 'string') return null
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] }
}

function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b)
  if (!pa || !pb) return String(a).localeCompare(String(b))
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === undefined) return 1   // 正式版 > 预发布
  if (pb.pre === undefined) return -1
  const pa2 = pa.pre.split('.'), pb2 = pb.pre.split('.')
  for (let i = 0; i < Math.max(pa2.length, pb2.length); i++) {
    const a = pa2[i], b = pb2[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const na = /^\d+$/.test(a), nb = /^\d+$/.test(b)
    if (na && nb) return +a < +b ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// 目录与环境
// ---------------------------------------------------------------------------

/** --home DIR 优先于 $DSH_HOME，最后回退到 ~/.dsh。 */
function resolveHome() {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') return resolve(argv[i + 1])
  }
  return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

const HOME = resolveHome()
const HARNESS_DIR = join(HOME, 'harness')
const BIN_DIR = join(HOME, 'bin')
const BACKUPS_DIR = join(HOME, 'backups')
const CURRENT_LINK = join(HARNESS_DIR, 'current')
const STATE_FILE = join(HARNESS_DIR, 'state.json')

const BIN_REL = join('node_modules', '.bin', 'dsh')
const PKG_REL = join('node_modules', PKG, 'package.json')

function binPathFor(installDir) {
  return join(installDir, BIN_REL)
}

function versionOfInstall(installDir) {
  return readJsonFile(join(installDir, PKG_REL))?.version ?? null
}

/** 解析 current 符号链接指向的安装目录。 */
function resolveCurrent() {
  if (!existsSync(CURRENT_LINK)) return null
  const target = readlinkSync(CURRENT_LINK)
  const p = isAbsolute(target) ? target : join(HARNESS_DIR, target)
  return existsSync(binPathFor(p)) ? p : null
}

/** 检测"当前使用的"安装：受管 current → npx 缓存（按版本取最高）→ PATH 上的 dsh。 */
function detectCurrent() {
  const managed = resolveCurrent()
  if (managed) return { version: versionOfInstall(managed), path: managed, kind: 'managed' }

  const npxRoot = join(homedir(), '.npm', '_npx')
  let best = null
  if (existsSync(npxRoot)) {
    for (const hash of readdirSafe(npxRoot)) {
      const pkg = join(npxRoot, hash, PKG_REL)
      if (!existsSync(pkg)) continue
      const v = readJsonFile(pkg)?.version
      if (v && (!best || cmpVer(v, best.version) > 0)) best = { version: v, path: join(npxRoot, hash), kind: 'npx' }
    }
  }
  if (best) return best

  const which = sh('sh', ['-lc', 'command -v dsh'])
  if (which.status === 0 && which.stdout.trim()) {
    const p = which.stdout.trim().replace(/\/node_modules\/\.bin\/dsh$/, '')
    return { version: versionOfInstall(p) ?? 'unknown', path: p, kind: 'path' }
  }
  return null
}

function readdirSafe(dir) {
  try { return statSync(dir).isDirectory() ? readdirSync(dir) : [] } catch { return [] }
}

// ---------------------------------------------------------------------------
// 网络：npm registry + GitHub 发布说明
// ---------------------------------------------------------------------------

async function npmInfo() {
  const j = await fetchJson(REGISTRY_URL)
  return {
    tags: j['dist-tags'] ?? {},
    versions: Object.keys(j.versions ?? {}),
  }
}

async function releaseNotes(version) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const releases = await fetchJson(GITHUB_RELEASES_URL)
      const rel = releases.find((r) => r.tag_name === `dsh-v${version}`)
      if (!rel?.body) return null
      return rel.body
        .replace(/<[^>]+>/g, ' ')            // 去 HTML 标签
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 去 markdown 链接
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 2500)
    } catch {
      if (attempt === 1) return null
      await new Promise((res) => setTimeout(res, 1000))
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 安装与冒烟
// ---------------------------------------------------------------------------

/** 把某版本装进受管目录（已存在则跳过），返回安装目录。 */
async function installVersion(version) {
  const dir = join(HARNESS_DIR, version)
  if (existsSync(binPathFor(dir)) && versionOfInstall(dir) === version) return dir
  mkdirSync(dir, { recursive: true })
  log(`  安装 ${PKG}@${version} → ${dir}（首次约 300–400MB，视网速 1–3 分钟）...`)

  // ~/.npm 缓存里若有 root 属主文件会 EPERM；失败时用工作区内的独立缓存重试。
  // 依赖树很大（数百 MB），npm 默认 Node 堆会 OOM，显式提高堆上限。
  const npmEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=4096'].filter(Boolean).join(' '),
  }
  const runInstall = (extra) => sh('npm', ['install', '--prefix', dir, ...extra, '--no-audit', '--no-fund', '--loglevel=error', `${PKG}@${version}`], { timeout: 10 * 60 * 1000, env: npmEnv })
  let r = runInstall([])
  if (r.status !== 0) {
    const hint = /EPERM|root-owned/.test(r.stderr || '')
      ? `（~/.npm 缓存含 root 属主文件，已用独立缓存重试；也可手动修复：sudo chown -R $(id -u):$(id -g) ~/.npm）`
      : ''
    if (hint) {
      log(`  警告: 默认 npm 缓存不可写${hint}`)
      r = runInstall(['--cache', join(HOME, '.npm-cache')])
    }
  }
  if (r.status !== 0) {
    const tail = (r.stderr || '').split('\n').slice(-8).join('\n')
    die(`安装 ${version} 失败：\n${tail}`)
  }
  const got = versionOfInstall(dir)
  if (got !== version) die(`安装后版本校验失败：期望 ${version}，实际 ${got}`)
  return dir
}

/** 对安装目录做冒烟：--version + 用临时 DSH_HOME 启动 web profile（不碰真实 profile）。 */
async function smokeTest(installDir, profile) {
  const bin = binPathFor(installDir)
  const v = sh(bin, ['--version'])
  if (v.status !== 0 || !v.stdout.trim()) return { ok: false, step: 'version', detail: v.stderr || '无输出' }

  const tmpHome = join(HOME, '.update-tmp-' + Date.now())
  mkdirSync(tmpHome, { recursive: true })
  const port = 20000 + Math.floor(Math.random() * 30000)
  const env = { ...process.env, DSH_HOME: tmpHome, DSH_UPDATE_SMOKE: '1' }
  try {
    const child = spawn(bin, ['--profile', profile, '--port', String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000) })
    const result = await new Promise((resolveP) => {
      child.on('exit', (code, signal) => resolveP({ running: false, code, signal }))
      child.on('error', (e) => resolveP({ running: false, code: null, signal: null, error: e.message }))
      setTimeout(() => resolveP({ running: true }), BOOT_SMOKE_MS)
    })
    if (!result.running) {
      const why = result.error ? `启动失败: ${result.error}` : `进程提前退出(code=${result.code}${result.signal ? `, signal=${result.signal}` : ''})`
      return { ok: false, step: 'boot', detail: `${why}：\n${stderr.slice(-1200)}` }
    }
    child.kill('SIGTERM')
    return { ok: true, step: 'boot', detail: `版本 ${v.stdout.trim()} 启动正常，${BOOT_SMOKE_MS / 1000}s 内无崩溃` }
  } catch (e) {
    return { ok: false, step: 'boot', detail: String(e) }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 配置 dump 与 diff
// ---------------------------------------------------------------------------

function dumpConfig(installDir, profile) {
  const r = sh(binPathFor(installDir), ['--profile', profile, '--dump-config'], { timeout: 60000 })
  if (r.status !== 0) throw new Error(`--dump-config 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

function idsFromDump(text) {
  return new Set([...text.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]))
}

function diffFiles(beforeFile, afterFile) {
  const r = spawnSync('diff', ['-u', beforeFile, afterFile], { encoding: 'utf8', timeout: 15000 })
  if (r.error) return { changed: true, text: `diff 不可用(${r.error.message})，跳过逐行对比` }
  if (r.status === 0) return { changed: false, text: '' }
  if (r.status === 1) return { changed: true, text: r.stdout.split('\n').slice(0, MAX_DIFF_LINES).join('\n') }
  return { changed: true, text: `diff 执行异常(status=${r.status})，跳过逐行对比` }
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

const BACKUP_FILES = [
  'settings.yaml',
  'cordis.patch.yml',
]

function collectBackupSources() {
  const files = []
  for (const f of BACKUP_FILES) if (existsSync(join(HOME, f))) files.push(join(HOME, f))
  const profilesDir = join(HOME, 'profiles')
  for (const name of readdirSafe(profilesDir)) {
    if (name === 'node_modules') continue
    const dir = join(profilesDir, name)
    if (!statSync(dir).isDirectory()) continue
    for (const f of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const p = join(dir, f)
      if (existsSync(p)) files.push(p)
    }
  }
  return files
}

function doBackup() {
  const dir = join(BACKUPS_DIR, now().replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const copied = []
  for (const src of collectBackupSources()) {
    const dst = join(dir, src.slice(HOME.length + 1).replaceAll('/', '__'))
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    copied.push(dst)
  }
  return { dir, copied }
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function isTTY() { return Boolean(process.stdin.isTTY && process.stdout.isTTY) }

async function ask(question, defaultYes = true) {
  if (!isTTY()) return defaultYes
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await new Promise((res) => rl.question(`  ${question} ${suffix} `, res))
  rl.close()
  const a = answer.trim().toLowerCase()
  if (!a) return defaultYes
  return a === 'y' || a === 'yes'
}

// ---------------------------------------------------------------------------
// 切换 / 回滚 / shim / PATH
// ---------------------------------------------------------------------------

function flipCurrent(installDir) {
  rmSync(CURRENT_LINK, { force: true })
  symlinkSync(installDir, CURRENT_LINK)
}

function readState() { return readJsonFile(STATE_FILE) ?? {} }

function writeState(state) { writeJsonFile(STATE_FILE, state) }

function ensureShim() {
  mkdirSync(BIN_DIR, { recursive: true })
  const shim = join(BIN_DIR, 'dsh')
  const body = `#!/bin/sh\n# dsh shim — 由 ~/.dsh/update-dsh.mjs 管理，指向 harness/current\nexec "${CURRENT_LINK}/node_modules/.bin/dsh" "$@"\n`
  writeFileSync(shim, body)
  chmodSync(shim, 0o755)
  return shim
}

function detectShellRc() {
  const shell = (process.env.SHELL || '').split('/').pop()
  if (shell === 'zsh') return join(homedir(), '.zshrc')
  if (shell === 'bash') return join(homedir(), '.bashrc')
  return null
}

function setupPath(shim) {
  if (process.env.PATH.split(':').includes(BIN_DIR)) return null
  const rc = detectShellRc()
  if (!rc) return `  提示：把 ${BIN_DIR} 加入 PATH（当前 shell 不受支持自动修改）：\n    export PATH="${BIN_DIR}:$PATH"`
  const line = `export PATH="${BIN_DIR}:$PATH"`
  let content = ''
  if (existsSync(rc)) content = readFileSync(rc, 'utf8')
  if (content.includes(BIN_DIR)) return null
  if (!isTTY()) return `  提示：把下面这行加到 ${rc}：\n    ${line}`
  return { rc, line, content }
}

async function offerPathSetup() {
  const shim = ensureShim()
  const res = setupPath(shim)
  if (res === null) return
  if (typeof res === 'string') { log(res); return }
  const ok = await ask(`把 ${BIN_DIR} 加入 PATH（写入 ${res.rc}）？`, true)
  if (!ok) { log(`  跳过。手动使用：${shim} web`); return }
  const append = (res.content.endsWith('\n') ? '' : '\n') + `\n# dsh 自动更新工具：受管安装优先\nexport PATH="${BIN_DIR}:$PATH"\n`
  writeFileSync(res.rc, res.content + append)
  log(`  已写入 ${res.rc}。当前终端执行 export PATH="${BIN_DIR}:$PATH" 后即可直接用 dsh 命令。`)
}

// ---------------------------------------------------------------------------
// 各子命令
// ---------------------------------------------------------------------------

function fmtInstall(i) {
  return i ? ` 当前版本: ${i.version} (${i.kind === 'managed' ? '受管安装' : i.kind === 'npx' ? 'npx 缓存' : 'PATH'}: ${i.path})` : ' 当前版本: 未检测到安装'
}

async function cmdStatus() {
  const cur = detectCurrent()
  log(fmtInstall(cur))
  let tags
  try {
    tags = (await npmInfo()).tags
  } catch {
    log('  最新版本: （无法访问 npm registry，离线）')
    return
  }
  const tagLine = Object.entries(tags).map(([t, v]) => `${t}=${v}`).join('  ')
  log(`  dist-tags: ${tagLine}`)
  if (cur?.version && parseVer(cur.version)) {
    const newerTags = Object.entries(tags).filter(([, v]) => cmpVer(v, cur.version) > 0)
    if (!newerTags.length) {
      log('  当前已是最新（所有 dist-tag 均不新于当前）。')
    } else {
      for (const [t, v] of newerTags) log(`  较新可用: [${t}] ${v}  （比当前新）`)
    }
  }
}

async function cmdCheck() {
  await cmdStatus()
  const cur = detectCurrent()
  if (!cur?.version) return
  const info = await npmInfo()
  // 取"比当前新"的最高版本(跨所有 dist-tag),展示其发布说明
  const newer = Object.entries(info.tags).filter(([, v]) => cmpVer(v, cur.version) > 0).sort((a, b) => cmpVer(b[1], a[1]))
  const tag = newer[0]?.[0]
  const target = newer[0]?.[1]
  if (!target) {
    log('  没有比当前更新的版本可检查。')
    return
  }
  log('')
  log(`── 发布说明 dsh-v${target}（tag: ${tag}）──────────────────`)
  const notes = await releaseNotes(target)
  log(notes ?? '（未取到发布说明，可查看 https://github.com/deepseek-ai/deepseek-harness/releases）')
}

async function cmdUpdate(argv) {
  const opts = argv.options ?? {}
  const profile = opts.profile || 'web'
  const cur = detectCurrent()
  if (!cur?.version) die('未检测到现有安装，无法更新')
  log(fmtInstall(cur))

  const info = await npmInfo()
  const channel = opts.channel || 'latest'
  const target = opts.to || info.tags[channel]
  if (!target) die(`dist-tag "${channel}" 不存在（可用: ${Object.keys(info.tags).join(', ')}）`)
  if (opts.to && !info.versions.includes(target)) die(`版本 ${target} 不在 npm 上（可用版本: ${info.versions.join(', ')}）`)

  // 提示:其他 dist-tag 上是否有比目标更新的版本(如 alpha 通道)
  const newerThanTarget = Object.entries(info.tags).filter(([, v]) => cmpVer(v, target) > 0)
  if (newerThanTarget.length) {
    log('  提示: 以下通道版本比目标更新，需要的话用 --channel <tag> 或 --to <版本>:')
    for (const [t, v] of newerThanTarget) log(`    [${t}] ${v}`)
  }

  if (cmpVer(target, cur.version) <= 0) {
    log(`  目标 ${target} 不新于当前 ${cur.version}，无需更新。`)
    return
  }

  log(`  更新路径: ${cur.version} → ${target}`)
  const notes = await releaseNotes(target)
  if (notes) log(`  发布说明摘要：\n${notes.slice(0, 600)}...`)

  // 1) 确保受管 current 存在（首次会把现有 npx 缓存目录接进来，零下载）
  if (!resolveCurrent()) {
    if (cur.kind === 'npx' && existsSync(binPathFor(cur.path))) {
      mkdirSync(HARNESS_DIR, { recursive: true })
      flipCurrent(cur.path)
      log(`  已把现有安装（${cur.version}，${cur.path}）接管为受管 current。`)
    } else {
      log('  初始化受管安装（安装当前版本）...')
      const dir = await installVersion(cur.version)
      flipCurrent(dir)
    }
  }

  // 2) 备份 + 升级前配置快照
  log('  备份用户配置...')
  const backup = doBackup()
  const beforeFile = join(backup.dir, 'config-before.yml')
  try {
    writeFileSync(beforeFile, dumpConfig(resolveCurrent(), profile))
    log(`  已备份到 ${backup.dir}（含当前配置快照 config-before.yml）`)
  } catch (e) {
    log(`  警告: 当前配置快照失败（不影响更新）：${e.message}`)
  }

  // 3) 预取目标版本
  log('  预取目标版本...')
  const targetDir = await installVersion(target)

  // 4) 冒烟测试
  let smoke = null
  if (!opts.noSmoke) {
    log(`  冒烟测试 ${target}（版本 + 临时环境启动 web profile）...`)
    smoke = await smokeTest(targetDir, profile)
    log(`  ${smoke.ok ? '✓' : '✗'} 冒烟: ${smoke.detail}`)
    if (!smoke.ok && !opts.force) {
      log('  中止更新（旧版本保持可用）。确认无碍可加 --force 强制切换。')
      return
    }
  }

  // 5) 配置 diff（升级后哪些条目变了/消失 —— 判断 user patch 是否会被跳过）
  let afterFile = null
  let removedIds = []
  let diffInfo = null
  try {
    afterFile = join(backup.dir, 'config-after.yml')
    writeFileSync(afterFile, dumpConfig(targetDir, profile))
    const before = idsFromDump(readFileSync(beforeFile, 'utf8'))
    const after = idsFromDump(readFileSync(afterFile, 'utf8'))
    removedIds = [...before].filter((id) => !after.has(id)).sort()
    diffInfo = diffFiles(beforeFile, afterFile)
    log(`  配置 diff（${cur.version} → ${target}）: ${diffInfo.changed ? '有变化' : '无变化'}`)
    if (removedIds.length) {
      log(`  警告: 以下条目 id 在新版本中消失，若你的 cordis.patch.yml 按这些 id 打补丁，升级后会被跳过并告警：\n    ${removedIds.join(', ')}`)
    }
    if (diffInfo.changed) log(diffInfo.text)
  } catch (e) {
    log(`  警告: 配置 diff 失败：${e.message}`)
  }

  // 6) 确认并切换
  if (!opts.yes && !isTTY()) die('非交互环境，请加 --yes 确认切换')
  const ok = opts.yes || await ask(`切换到 ${target}？（旧版本 ${cur.version} 保留可回滚）`, true)
  if (!ok) { log('  已取消，未做任何切换。'); return }

  const state = readState()
  const prevPath = resolveCurrent()
  flipCurrent(targetDir)
  writeState({
    current: target,
    currentPath: targetDir,
    previous: prevPath ? { version: versionOfInstall(prevPath), path: prevPath } : null,
    history: [...(state.history ?? []), { from: cur.version, to: target, at: now(), backup: backup.dir }],
    updatedAt: now(),
  })
  log(`✓ 已切换到 ${target}`)

  // 7) shim + PATH
  if (!opts.noPath) await offerPathSetup()
  log('')
  log('  重启 GUI 后生效：先停掉当前的 dsh web 进程，再用下面的命令启动：')
  log(`    ${join(BIN_DIR, 'dsh')} web`)
  log(`  回滚：node ~/.dsh/update-dsh.mjs rollback`)
  if (backup.copied.length) log(`  配置备份：${backup.dir}`)
}

async function cmdRollback() {
  const state = readState()
  const prev = state.previous
  if (!prev?.path || !existsSync(binPathFor(prev.path))) {
    die('没有可回滚的上一版本（或该安装目录已不存在）。可用 node ~/.dsh/update-dsh.mjs versions 查看。')
  }
  const cur = resolveCurrent()
  flipCurrent(prev.path)
  writeState({
    ...state,
    current: prev.version,
    currentPath: prev.path,
    previous: cur ? { version: versionOfInstall(cur), path: cur } : null,
    updatedAt: now(),
  })
  log(`✓ 已回滚到 ${prev.version}（${prev.path}）`)
  ensureShim()
  log('  重启 GUI 后生效。')
}

async function cmdVersions() {
  const cur = resolveCurrent()
  const dirs = readdirSafe(HARNESS_DIR).filter((d) => d !== 'current' && existsSync(join(HARNESS_DIR, d, PKG_REL)))
  if (!dirs.length) { log('  受管目录为空。用 node ~/.dsh/update-dsh.mjs update 开始第一次更新。'); return }
  for (const d of dirs.sort(cmpVer)) {
    const full = join(HARNESS_DIR, d)
    log(`  ${d}${cur === full ? '  ← current' : ''}  (${full})`)
  }
}

/** 清理旧版本目录：保留 current、回滚目标(previous)与最近的 keep-1 个版本。 */
async function cmdPrune(opts) {
  const keep = Number(opts.options.keep ?? 2)
  const state = readState()
  const cur = resolveCurrent()
  const protectedSet = new Set()
  if (cur) protectedSet.add(basename(cur))
  const prev = state.previous
  if (prev?.path?.startsWith(HARNESS_DIR)) protectedSet.add(basename(prev.path))

  const dirs = readdirSafe(HARNESS_DIR)
    .filter((d) => d !== 'current' && existsSync(join(HARNESS_DIR, d, PKG_REL)) && !protectedSet.has(d))
    .sort(cmpVer)

  // 按版本从新到旧保留 (keep - 已保护的) 个
  const keepMore = Math.max(0, keep - protectedSet.size)
  const removable = dirs.slice(0, Math.max(0, dirs.length - keepMore))
  if (!removable.length) {
    log(`  没有可清理的版本（保留 ${keep} 个最新版本 + current/回滚目标）。当前磁盘占用：`)
    for (const d of readdirSafe(HARNESS_DIR).filter((d) => d !== 'current' && existsSync(join(HARNESS_DIR, d, PKG_REL))).sort(cmpVer)) {
      const full = join(HARNESS_DIR, d)
      log(`    ${d}${cur === full ? '  ← current' : ''}  ${(duOf(full) / 1048576).toFixed(0)}M`)
    }
    return
  }
  log('  将删除以下旧版本目录：')
  for (const d of removable) {
    const full = join(HARNESS_DIR, d)
    log(`    ${d}  ${(duOf(full) / 1048576).toFixed(0)}M  (${full})`)
  }
  if (!opts.options.yes && !isTTY()) die('非交互环境，请加 --yes 确认清理')
  const ok = opts.options.yes || await ask('确认删除？（current 与回滚目标不会动）', false)
  if (!ok) { log('  已取消。'); return }
  for (const d of removable) rmSync(join(HARNESS_DIR, d), { recursive: true, force: true })
  log(`✓ 已清理 ${removable.length} 个旧版本，释放约 ${(removable.reduce((sum, d) => sum + duOf(join(HARNESS_DIR, d)) / 1048576, 0)).toFixed(0)}M。`)
  if (cur && !cur.startsWith(HARNESS_DIR)) {
    log('  提示：current 指向 npx 缓存（未受管）。升级完成后可手动清理旧 npx 缓存：')
    log(`    rm -rf ${cur}`)
  }
}

/** 目录占用字节数（du -sk 的 Node 版，粗略但足够提示用）。 */
function duOf(dir) {
  let total = 0
  const walk = (p) => {
    let entries
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(p, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isSymbolicLink()) { /* 符号链接不计（指向共享存储） */ }
      else {
        try { total += statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  walk(dir)
  return total
}

async function cmdInstall(ver) {
  if (!parseVer(ver)) die(`非法版本号: ${ver}`)
  const info = await npmInfo()
  if (!info.versions.includes(ver)) die(`版本 ${ver} 不在 npm 上`)
  const dir = await installVersion(ver)
  log(`✓ 已预取 ${ver} → ${dir}（未切换，可用 update --to ${ver} 切换）`)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const [sub, ...rest] = process.argv.slice(2)
  const opts = { options: {} }
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--yes') opts.options.yes = true
    else if (a === '--no-smoke') opts.options.noSmoke = true
    else if (a === '--force') opts.options.force = true
    else if (a === '--no-path') opts.options.noPath = true
    else if (a === '--profile') opts.options.profile = rest[++i]
    else if (a === '--to') opts.options.to = rest[++i]
    else if (a === '--channel') opts.options.channel = rest[++i]
    else if (a === '--keep') opts.options.keep = rest[++i]
    else if (a === '--home') i++ /* 已由 resolveHome 处理 */
    else positional.push(a)
  }

  switch (sub) {
    case undefined:
    case 'status': await cmdStatus(); break
    case 'check': await cmdCheck(); break
    case 'update': await cmdUpdate(opts); break
    case 'rollback': await cmdRollback(); break
    case 'versions': await cmdVersions(); break
    case 'prune': await cmdPrune(opts); break
    case 'install': await cmdInstall(positional[0]); break
    default:
      die(`未知命令: ${sub}\n用法见文件头部注释。`)
  }
}

main().catch((e) => die(e?.message ?? String(e)))
