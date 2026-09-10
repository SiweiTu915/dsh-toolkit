// dsh-remote — 纯路径 / shell 辅助函数(不依赖 fs、不依赖 ssh,便于单测)
//
// 借鉴自 dsh-remote@0.8.14 的 lib/paths.js:把纯逻辑从主流程里拆出来。
// 同时支持 POSIX(/a/b)与 Windows(D:\Code、C:/Users、\\server\share)。

/** 单引号 shell 转义:把任意字符串安全塞进远程命令里。 */
export function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/** 是否是 Windows 形式(盘符或 UNC)。 */
export function isWindowsPath(p) {
  return /^[a-zA-Z]:/.test(String(p)) || /^\\\\/.test(String(p))
}

/**
 * 归一化远程路径:折叠 `.` / `..`,统一分隔符,保留原始风格。
 * - POSIX:`/a//b/../c` → `/a/c`
 * - Windows 盘符:`D:\Code\\x\..` → `D:\Code`(保持盘符,不补前导 /)
 * - UNC:`\\server\share\a` 保留 `\\server\share` 前缀
 */
export function normalizeRemotePath(input) {
  const s = String(input ?? '')
  if (!s) return s

  // UNC:\\server\share\...
  const unc = s.match(/^(\\\\[^\\/]+(?:\\[^\\/]+)?)(?:[\\/](.*))?$/s)
  if (unc) {
    const prefix = unc[1]
    const rest = unc[2] ?? ''
    const parts = collapse(rest)
    return parts.length ? `${prefix}\\${parts.join('\\')}` : prefix
  }

  // Windows 盘符:X:\... 或 X:/...
  const drive = s.match(/^([a-zA-Z]:)(?:[\\/](.*))?$/s)
  if (drive) {
    const prefix = drive[1]
    const rest = drive[2] ?? ''
    const parts = collapse(rest)
    return parts.length ? `${prefix}\\${parts.join('\\')}` : prefix
  }

  // POSIX
  const absolute = s.startsWith('/')
  const parts = collapse(s)
  return (absolute ? '/' : '') + parts.join('/')
}

function collapse(p) {
  const out = []
  for (const seg of String(p).split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out
}

/** 按 base 的风格拼接远程路径。 */
export function joinRemotePath(base, child) {
  const b = String(base ?? '')
  const c = String(child ?? '')
  if (!c) return b
  if (isWindowsPath(b)) return normalizeRemotePath(`${b.replace(/[\\/]+$/, '')}\\${c}`)
  return normalizeRemotePath(`${b.replace(/\/+$/, '')}/${c}`)
}

/** 取 parent 的父目录(远程路径,保留风格)。 */
export function dirnameRemote(p) {
  const s = String(p ?? '')
  const norm = normalizeRemotePath(s)
  if (isWindowsPath(norm)) {
    const i = norm.lastIndexOf('\\')
    return i <= 1 ? norm : norm.slice(0, i)
  }
  const i = norm.lastIndexOf('/')
  return i <= 0 ? '/' : norm.slice(0, i)
}

/**
 * full 相对于 root 的相对路径(同步状态文件与本地镜像都用 POSIX 形式)。
 * 不在 root 之下时返回 null。
 */
export function relPathUnder(root, full) {
  const r = normalizeRemotePath(root)
  const f = normalizeRemotePath(full)
  const win = isWindowsPath(r)
  const norm = (p) => (win ? p.replace(/\\/g, '/') : p)
  const R = norm(r).replace(/\/+$/, '')
  const F = norm(f)
  if (F === R) return ''
  if (!F.startsWith(R + '/')) return null
  return F.slice(R.length + 1)
}

/** 把相对路径(远程风格)映射成本机镜像下的绝对路径(本机统一用 /)。 */
export function toLocalPath(localRoot, rel) {
  const clean = String(rel ?? '').split(/[\\/]+/).filter((s) => s && s !== '.').join('/')
  return clean ? `${localRoot.replace(/\/+$/, '')}/${clean}` : localRoot
}

/** 把相对路径映射成远程绝对路径(按 remoteRoot 的风格)。 */
export function toRemotePath(remoteRoot, rel) {
  const clean = String(rel ?? '').split(/[\\/]+/).filter((s) => s && s !== '.').join('/')
  return clean ? joinRemotePath(remoteRoot, clean) : normalizeRemotePath(remoteRoot)
}

/**
 * 忽略规则匹配(简化版 gitignore 风格):
 * - `*.log` 匹配任意层级下同名的文件
 * - `data/**`、`build/*` 匹配目录前缀
 * - `!pattern` 取反(后面的规则覆盖前面的)
 */
export function makeIgnore(patterns) {
  const rules = (patterns ?? [])
    .map((raw) => String(raw).trim())
    .filter((p) => p && !p.startsWith('#'))
    .map((p) => ({ negate: p.startsWith('!'), glob: p.startsWith('!') ? p.slice(1) : p }))
    .map((r) => ({ ...r, re: globToRegExp(r.glob) }))
  return (rel) => {
    const p = String(rel).replace(/\\/g, '/')
    let ignored = false
    for (const r of rules) if (r.re.test(p)) ignored = !r.negate
    return ignored
  }
}

function globToRegExp(glob) {
  let g = String(glob).replace(/\\/g, '/')
  const anchored = g.startsWith('/')          // 以 / 开头才锚定到根
  if (anchored) g = g.slice(1)
  const dirOnly = g.endsWith('/')
  if (dirOnly) g = g.slice(0, -1)
  let body = ''
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]
    if (ch === '*') {
      if (g[i + 1] === '*') { body += '.*'; i++ } else body += '[^/]*'
    } else if (ch === '?') body += '[^/]'
    else if ('.+^${}()|[]\\'.includes(ch)) body += `\\${ch}`
    else body += ch
  }
  // 未锚定的模式匹配任意层级(同步工具里 `data/**` 通常就指望这个语义)
  const prefix = anchored ? '^' : '(^|.*/)'
  return new RegExp(`${prefix}${body}(/.*)?$`)
}
