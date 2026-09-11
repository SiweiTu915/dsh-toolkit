#!/usr/bin/env node
/**
 * dsh-remote — 直接对「远程文件」增删改查(全程 SFTP / SSH,不把文件拉到本机)
 *
 * 设计:所有操作都是远程就地读写 —— 本机只过数据流,不落副本、不做同步。
 *   读:ls / tree / stat / read / grep / find
 *   写:write(创建或覆盖)/ append / edit(定向替换)
 *   删:rm [-r]
 *   改:mkdir / mv / cp / edit
 *   跑:exec(在远程执行命令)
 *
 * 用法:
 *   node rw.mjs <命令> <机器名> [参数...]
 *   node rw.mjs ls gpu /root/project
 *   node rw.mjs read gpu /root/a.py --head 40
 *   node rw.mjs read gpu /root/big.bin --out ./big.bin   # 二进制安全地下载到本机
 *   node rw.mjs edit gpu /root/a.py --old "lr=0.1" --new "lr=0.01"
 *   node rw.mjs write gpu /root/new.py --from ./local.py
 *   node rw.mjs exec gpu "nvidia-smi -L"
 *
 * 连接信息取自 servers.json 的对应条目(或 --host/--user/--port/--key 覆盖)。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { stdin } from 'node:process'
import { connect } from './lib/sftp.mjs'
import { findServer, resolveConn } from './lib/hosts.mjs'
import { shq, normalizeRemotePath, dirnameRemote, joinRemotePath } from './lib/paths.mjs'

const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const out = (s = '') => console.log(s)
const human = (n) => {
  const u = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  let v = Number(n) || 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`
}
const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

// ── 参数解析 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { all: false, recursive: false, dryRun: false, stdin: false, context: 0, ignoreCase: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') opts.all = true
    else if (a === '-r' || a === '--recursive') opts.recursive = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--stdin') opts.stdin = true
    else if (a === '-i' || a === '--ignore-case') opts.ignoreCase = true
    else if (a === '--text') opts.text = argv[++i]
    else if (a === '--from') opts.from = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--old') opts.old = argv[++i]
    else if (a === '--new') opts.new = argv[++i]
    else if (a === '--pattern') opts.pattern = argv[++i]
    else if (a === '--name') opts.name = argv[++i]
    else if (a === '--head') opts.head = Number(argv[++i])
    else if (a === '--tail') opts.tail = Number(argv[++i])
    else if (a === '--depth') opts.depth = Number(argv[++i])
    else if (a === '--max') opts.max = Number(argv[++i])
    else if (a === '--context') opts.context = Number(argv[++i])
    else if (a === '--host') opts.host = argv[++i]
    else if (a === '--user') opts.user = argv[++i]
    else if (a === '--port') opts.port = argv[++i]
    else if (a === '--key') opts.key = argv[++i]
    else positional.push(a)
  }
  return { opts, positional }
}

async function withConn(name, opts, fn) {
  const server = findServer(name)
  const conn = await connect({ ...resolveConn(server, opts), machineId: name })
  try { return await fn(conn) } finally { conn.end() }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (c) => { data += c })
    stdin.on('end', () => resolve(data))
  })
}

// ── 命令实现 ──────────────────────────────────────────────────────────────
async function cmdLs(conn, path) {
  const target = normalizeRemotePath(path || '.')
  const st = await conn.stat(target).catch(() => null)
  if (st && !st.isDirectory()) return cmdStat(conn, target)
  const entries = await conn.readdir(target)
  const rows = entries.map((e) => ({
    type: e.attrs.isDirectory() ? 'dir ' : 'file',
    size: e.attrs.isDirectory() ? '-' : human(e.attrs.size),
    mtime: fmtTime((e.attrs.mtime ?? 0) * 1000),
    name: e.filename + (e.attrs.isDirectory() ? '/' : ''),
  })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir ' ? -1 : 1))
  out(`${target}  (${rows.length} 项)`)
  for (const r of rows) out(`  ${r.type}  ${r.size.padStart(7)}  ${r.mtime}  ${r.name}`)
}

async function cmdTree(conn, path, opts) {
  const root = normalizeRemotePath(path || '.')
  const maxDepth = opts.depth ?? 2
  let files = 0
  let dirs = 0
  const walk = async (dir, prefix, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = await conn.readdir(dir) } catch { return }
    const shown = entries.filter((e) => !/^(\.git|node_modules|__pycache__|\.ipynb_checkpoints)$/.test(e.filename))
    for (const e of shown.slice(0, 60)) {
      const isDir = e.attrs.isDirectory()
      if (isDir) dirs++
      else files++
      out(`${prefix}${e.filename}${isDir ? '/' : `  (${human(e.attrs.size)})`}`)
      if (isDir) await walk(joinRemotePath(dir, e.filename), `${prefix}  `, depth + 1)
    }
    if (shown.length > 60) out(`${prefix}… 其余 ${shown.length - 60} 项`)
  }
  out(root)
  await walk(root, '  ', 1)
  out(`\n共 ${dirs} 目录 / ${files} 文件（深度 ≤${maxDepth}）`)
}

async function cmdStat(conn, path) {
  const target = normalizeRemotePath(path)
  const st = await conn.stat(target)
  out(`${target}`)
  out(`  类型: ${st.isDirectory() ? '目录' : st.isFile() ? '文件' : '其他'}`)
  out(`  大小: ${st.size} 字节 (${human(st.size)})`)
  out(`  修改: ${fmtTime((st.mtime ?? 0) * 1000)}`)
  out(`  权限: ${(st.mode & 0o777).toString(8)}`)
}

async function cmdRead(conn, path, opts) {
  const target = normalizeRemotePath(path)
  // --out:把内容原样写到本机文件(二进制安全)。
  // ⚠️ 落盘时**不能**带上给终端看的那行 `[N 字节]` 脚注 —— 实测直接 `read > file`
  // 重定向会被脚注污染,得到的 md5 与远程不一致。
  const toFile = typeof opts.out === 'string' && opts.out.length > 0
  if (toFile) writeFileSync(opts.out, Buffer.alloc(0)) // 先清空,避免追加到旧内容
  const emit = (chunk) => { if (toFile) appendFileSync(opts.out, chunk); else process.stdout.write(chunk) }
  if (opts.head || opts.tail) {
    // 大文件用远程 head/tail,避免整文件传输
    const cmd = opts.head
      ? `head -n ${opts.head} ${shq(target)}`
      : `tail -n ${opts.tail} ${shq(target)}`
    const r = await conn.exec(cmd)
    if (r.code !== 0) die(r.stderr.trim() || `读取失败 (code ${r.code})`)
    emit(r.stdout)
    if (toFile) { process.stderr.write(`✓ 已下载 ${target} → ${opts.out}(${Buffer.byteLength(r.stdout)} 字节)\n`); return }
    if (!r.stdout.endsWith('\n')) out()
    return
  }
  const buf = await conn.readFile(target)
  emit(buf)
  if (toFile) { process.stderr.write(`✓ 已下载 ${target} → ${opts.out}(${buf.length} 字节)\n`); return }
  if (buf.length && buf[buf.length - 1] !== 0x0a) out()
  out(`\n[${buf.length} 字节]`)
}

async function cmdWrite(conn, path, opts) {
  const target = normalizeRemotePath(path)
  let data
  if (opts.from) data = readFileSync(opts.from)
  else if (opts.stdin) data = Buffer.from(await readStdin())
  else if (typeof opts.text === 'string') data = Buffer.from(opts.text)
  else die('需要 --text "内容" / --from <本地文件> / --stdin 之一')
  const existed = await conn.stat(target).then(() => true).catch(() => false)
  if (opts.dryRun) { out(`[dry-run] 将${existed ? '覆盖' : '创建'} ${target}(${data.length} 字节)`); return }
  await conn.writeFile(target, data)
  out(`✓ ${existed ? '已覆盖' : '已创建'} ${target}(${data.length} 字节)`)
}

async function cmdAppend(conn, path, opts) {
  const target = normalizeRemotePath(path)
  if (typeof opts.text !== 'string') die('需要 --text "内容"')
  let prev = Buffer.alloc(0)
  try { prev = await conn.readFile(target) } catch { /* 新文件 */ }
  const needsNewline = prev.length > 0 && prev[prev.length - 1] !== 0x0a
  const data = Buffer.concat([prev, needsNewline ? Buffer.from('\n') : Buffer.alloc(0), Buffer.from(opts.text)])
  if (opts.dryRun) { out(`[dry-run] 将追加到 ${target}`); return }
  await conn.writeFile(target, data)
  out(`✓ 已追加到 ${target}(${data.length} 字节)`)
}

async function cmdEdit(conn, path, opts) {
  const target = normalizeRemotePath(path)
  if (typeof opts.old !== 'string' || typeof opts.new !== 'string') die('需要 --old "原文" --new "新文"')
  const buf = await conn.readFile(target)
  const text = buf.toString('utf8')
  const idx = text.indexOf(opts.old)
  if (idx < 0) die(`未找到匹配内容(未修改):${JSON.stringify(opts.old.slice(0, 60))}`)
  const count = text.split(opts.old).length - 1
  const next = opts.all ? text.split(opts.old).join(opts.new) : text.replace(opts.old, opts.new)
  if (opts.dryRun) { out(`[dry-run] 匹配 ${count} 处${opts.all ? '(全部替换)' : '(仅第一处)'},未写入`); return }
  await conn.writeFile(target, Buffer.from(next))
  out(`✓ 已修改 ${target}(${opts.all ? `全部 ${count}` : '1'} 处${count > 1 && !opts.all ? `,该内容共 ${count} 处` : ''})`)
}

async function cmdRm(conn, paths, opts) {
  for (const p of paths) {
    const target = normalizeRemotePath(p)
    const st = await conn.stat(target).catch(() => null)
    if (!st) { out(`- ${target} 不存在,跳过`); continue }
    if (opts.dryRun) { out(`[dry-run] 将删除 ${target}`); continue }
    if (st.isDirectory()) {
      if (!opts.recursive) { out(`✗ ${target} 是目录,需加 -r`); continue }
      const r = await conn.exec(`rm -rf ${shq(target)}`)
      if (r.code !== 0) { out(`✗ 删除失败: ${r.stderr.trim()}`); continue }
    } else await conn.unlink(target)
    out(`✓ 已删除 ${target}`)
  }
}

async function cmdMkdir(conn, paths, opts) {
  for (const p of paths) {
    const target = normalizeRemotePath(p)
    if (opts.dryRun) { out(`[dry-run] 将创建目录 ${target}`); continue }
    await conn.mkdirp(target)
    out(`✓ 已创建目录 ${target}`)
  }
}

async function cmdMv(conn, from, to) {
  await conn.rename(normalizeRemotePath(from), normalizeRemotePath(to))
  out(`✓ ${from} → ${to}`)
}

async function cmdCp(conn, from, to) {
  const src = normalizeRemotePath(from)
  const dst = normalizeRemotePath(to)
  const st = await conn.stat(src).catch(() => null)
  if (!st) die(`源不存在: ${src}`)
  if (st.isDirectory()) {
    const r = await conn.exec(`cp -r ${shq(src)} ${shq(dst)}`)
    if (r.code !== 0) die(r.stderr.trim() || '复制失败')
  } else {
    const buf = await conn.readFile(src)
    await conn.writeFile(dst, buf)
  }
  out(`✓ 已复制 ${src} → ${dst}`)
}

async function cmdGrep(conn, path, opts) {
  if (!opts.pattern) die('需要 --pattern <正则>')
  const target = normalizeRemotePath(path || '.')
  const flags = [opts.ignoreCase ? '-i' : '', '-n', '-E',
    opts.recursive ? '-r' : '-r',
    opts.context ? `-C ${opts.context}` : ''].filter(Boolean).join(' ')
  const cmd = `grep ${flags} ${shq(opts.pattern)} ${shq(target)} 2>/dev/null | head -n ${opts.max ?? 200}`
  const r = await conn.exec(cmd)
  if (!r.stdout.trim()) { out('(无匹配)'); return }
  process.stdout.write(r.stdout)
  const lines = r.stdout.split('\n').filter(Boolean).length
  if (lines >= (opts.max ?? 200)) out(`[已达上限 ${opts.max ?? 200} 行,可用 --max 调整]`)
}

async function cmdFind(conn, path, opts) {
  const target = normalizeRemotePath(path || '.')
  const namePart = opts.name ? `-name ${shq(opts.name)}` : ''
  const cmd = `find ${shq(target)} ${namePart} -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -n ${opts.max ?? 200}`
  const r = await conn.exec(cmd)
  if (!r.stdout.trim()) { out('(无匹配)'); return }
  process.stdout.write(r.stdout)
}

async function cmdExec(conn, command) {
  if (!command) die('需要一条命令,例如: rw.mjs exec gpu "nvidia-smi -L"')
  const r = await conn.exec(command)
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.code !== 0) { out(`[退出码 ${r.code}]`); process.exit(r.code ?? 1) }
}

// ── 入口 ──────────────────────────────────────────────────────────────────
async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2))
  const [cmd, name, ...rest] = positional
  if (!cmd || !name) {
    out('用法: node rw.mjs <ls|tree|stat|read|write|append|edit|rm|mkdir|mv|cp|grep|find|exec> <机器名> [参数] [--选项]')
    out('例:   node rw.mjs ls gpu /root/project')
    out('      node rw.mjs read gpu /root/a.py --head 40')
    out('      node rw.mjs edit gpu /root/a.py --old "lr=0.1" --new "lr=0.01"')
    out('      node rw.mjs exec gpu "nvidia-smi -L"')
    process.exit(1)
  }
  await withConn(name, opts, async (conn) => {
    switch (cmd) {
      case 'ls': return cmdLs(conn, rest[0])
      case 'tree': return cmdTree(conn, rest[0], opts)
      case 'stat': return cmdStat(conn, rest[0])
      case 'read': case 'cat': return cmdRead(conn, rest[0], opts)
      case 'write': return cmdWrite(conn, rest[0], opts)
      case 'append': return cmdAppend(conn, rest[0], opts)
      case 'edit': return cmdEdit(conn, rest[0], opts)
      case 'rm': case 'del': return cmdRm(conn, rest, opts)
      case 'mkdir': return cmdMkdir(conn, rest, opts)
      case 'mv': return cmdMv(conn, rest[0], rest[1])
      case 'cp': return cmdCp(conn, rest[0], rest[1])
      case 'grep': return cmdGrep(conn, rest[0], opts)
      case 'find': return cmdFind(conn, rest[0], opts)
      case 'exec': case 'run': return cmdExec(conn, rest.join(' '))
      default: die(`未知命令: ${cmd}`)
    }
  })
}

main().catch((e) => die(e?.message ?? String(e)))
