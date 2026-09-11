// dsh-remote — 访问范围(围栏)解析
//
// 为什么需要这个:面板的 /api/rw/* 直接持有 SSH 凭据,原先每个端点都把手里的
// 绝对路径原样交给 SFTP —— 等于「能打开面板页面」就等于「能读写远程整台机器」。
// 更糟的是它**绕开了 fs provider 上那三档权限**(read-only / workspace-write /
// danger-full-access 只管模型的文件工具),所以模型被限制在工作区里,而面板
// 那条路径不受任何限制。
//
// 两类调用方,两种范围:
//   1. 工作台里的侧栏插件 —— 请求带 `port`,范围 = **该工作台注册的工作区**(最窄)
//   2. 面板自己的文件管理器 —— 请求带 `name`,范围 = 该机器声明的**挂载根**
//      (remoteRoot,例如 /root;绝不是 /)
//
// 「挂载根」这个上界对机器级管理是必要的:工作区通常挂在挂载根下面好几层,
// 把面板也压到工作区里就看不到挂载根本身了。想在机器上再放宽或收窄,
// 在 servers.json 的条目上写显式 `roots: [...]`(声明式例外,而不是默认放开)。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { REMOTE_DIR } from './hosts.mjs'
import { normalizeRemotePath, dirnameRemote, joinRemotePath, relPathUnder, toRemotePath } from './paths.mjs'

/** 某个工作台的 home(workbench.mjs 建出来的那套)。 */
export function workbenchHome(name) {
  return join(REMOTE_DIR, 'sim-homes', name)
}

/**
 * 读工作台的挂载配置。remote-mount.json / fs-sftp.json 两种命名都认。
 * @returns {{remoteRoot: string, localRoot: string|null}|null}
 */
export function readMount(name) {
  for (const file of ['remote-mount.json', 'fs-sftp.json']) {
    const p = join(workbenchHome(name), file)
    if (!existsSync(p)) continue
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'))
      const remoteRoot = d.remoteRoot || d.root
      const localRoot = d.localRoot
      if (remoteRoot) {
        return {
          remoteRoot: normalizeRemotePath(remoteRoot),
          localRoot: localRoot ? normalizeRemotePath(localRoot) : null,
        }
      }
    } catch { /* 坏文件视为没有 */ }
  }
  return null
}

/** 该工作台注册表里的工作区(本机路径)。 */
function registeredWorkspaces(name) {
  const reg = join(workbenchHome(name), 'storages', 'workspace.json')
  if (!existsSync(reg)) return []
  try {
    const d = JSON.parse(readFileSync(reg, 'utf8'))
    const table = d?.tables?.workspaces ?? {}
    const ids = Array.isArray(d?.global?.workspaceIds) ? d.global.workspaceIds : Object.keys(table)
    const out = []
    for (const id of ids) {
      const w = table[id]
      if (w?.path) out.push({ path: w.path, title: w.title || String(w.path).split('/').pop() })
    }
    return out
  } catch { return [] }
}

/**
 * 工作台的范围:**它自己登记的工作区**,映射到远程拼写。
 * 没有挂载配置就映射不出去(本机路径对远程无意义)→ 返回空,让调用方回落机器级。
 * @returns {{roots: string[], titles: Record<string,string>, mount: object|null}}
 */
export function readWorkbenchRoots(name) {
  const mount = readMount(name)
  const roots = []
  const titles = {}
  if (!mount || !mount.localRoot) return { roots, titles, mount }
  for (const w of registeredWorkspaces(name)) {
    const rel = relPathUnder(mount.localRoot, w.path)
    if (rel === null) continue                       // 不在挂载点之下 → 不属于这台机器
    const remote = toRemotePath(mount.remoteRoot, rel)
    if (roots.includes(remote)) continue
    roots.push(remote)
    titles[remote] = w.title
  }
  return { roots, titles, mount }
}

/**
 * 机器级范围:该机器声明的根。
 * 优先级:servers.json 上显式 `roots` → 挂载配置的 remoteRoot → conn.defaultPath → 家目录。
 * 注意默认是 /root 而**不是 /** —— 后者等于不设界。
 */
export function machineRoots(server) {
  const declared = server?.roots ?? server?.conn?.roots ?? server?.mirror?.roots
  if (Array.isArray(declared) && declared.length) return declared.map(normalizeRemotePath).filter(Boolean)
  const mount = readMount(server?.name)
  if (mount?.remoteRoot) return [mount.remoteRoot]
  const dp = server?.conn?.defaultPath ?? server?.defaultPath
  return [normalizeRemotePath(dp || '/root')]
}

/** target 是否在任一 root 之下(纯字符串判定,已归一化)。 */
export function withinRoots(roots, target) {
  const t = normalizeRemotePath(target)
  for (const r of roots) if (relPathUnder(r, t) !== null) return true
  return false
}

/** 最贴合的 root(用于给界面显示「当前范围」)。 */
export function rootOf(roots, target) {
  const t = normalizeRemotePath(target)
  let best = null
  for (const r of roots) {
    const rel = relPathUnder(r, t)
    if (rel === null) continue
    if (!best || normalizeRemotePath(r).length > best.length) best = normalizeRemotePath(r)
  }
  return best
}

/** ssh2 的 realpath 是回调式,包一层;路径不存在返回 null。 */
export function realpath(conn, p) {
  return new Promise((resolve) => {
    const sftp = conn?.sftp
    if (!sftp || typeof sftp.realpath !== 'function') return resolve(null)
    try {
      sftp.realpath(normalizeRemotePath(p), (err, abs) => resolve(err ? null : abs || null))
    } catch { resolve(null) }
  })
}

/** 同上,给 readlink / lstat 这类回调式调用用。 */
function sftpCall(conn, method, arg) {
  return new Promise((resolve) => {
    const sftp = conn?.sftp
    if (!sftp || typeof sftp[method] !== 'function') return resolve(null)
    try {
      sftp[method](normalizeRemotePath(arg), (err, v) => resolve(err ? null : (typeof v === 'string' ? v : v || true)))
    } catch { resolve(null) }
  })
}

/**
 * 围栏判定,**先解 symlink 再判**。目标本身可能还不存在(新建文件),所以从它往上
 * 找到最深的已存在祖先,realpath 之后再把这些段接回去。这样「工作区里放一个指向
 * /etc 的软链」也逃不出去。
 *
 * 末尾那一段要单独处理:如果它本身是**悬空软链**,realpath 会失败 → 若就此回退到
 * 父目录,会判成「在范围内」,可真正写入时 OS 仍会顺着软链写到外面。所以 realpath
 * 失败后再试一次 readlink,是软链就按它的目标重新判定(相对目标按链接所在目录展开)。
 * 中间段是软链的情况由「realpath 父目录」天然覆盖。
 *
 * @returns {Promise<{ok: boolean, resolved: string, reason?: string}>}
 */
export async function fencePath(conn, target, roots, depth = 0) {
  const t = normalizeRemotePath(target)
  if (!t) return { ok: false, resolved: t, reason: '空路径' }
  if (depth > 16) return { ok: false, resolved: t, reason: '软链嵌套过深' }
  let head = t
  const tail = []
  for (;;) {
    const real = await realpath(conn, head)
    if (real) {
      const full = tail.length ? joinRemotePath(real, tail.reverse().join('/')) : normalizeRemotePath(real)
      if (withinRoots(roots, full)) return { ok: true, resolved: full }
      return { ok: false, resolved: full, reason: `${full} 不在允许范围内` }
    }
    // realpath 失败:可能 head 是软链(含悬空软链)—— 按它的目标重新判定
    const link = await sftpCall(conn, 'readlink', head)
    if (link) {
      // 相对目标按「链接所在目录」展开(head 就是链接本身,所以是它的父目录)
      const nextTarget = link.startsWith('/') ? link : joinRemotePath(dirnameRemote(head), link)
      const below = tail.slice().reverse()          // head 之下还挂着的段
      const r = await fencePath(conn, nextTarget, roots, depth + 1)
      if (!r.ok) return r
      return below.length ? { ok: true, resolved: joinRemotePath(r.resolved, below.join('/')) } : r
    }
    const parent = dirnameRemote(head)
    if (!parent || parent === head) return { ok: false, resolved: t, reason: '路径无法解析' }
    const base = head.slice(parent === '/' ? 1 : parent.length + 1)
    if (!base) return { ok: false, resolved: t, reason: '路径无法解析' }
    tail.push(base)
    head = parent
  }
}

/** 给用户看的范围描述。 */
export function describeScope(scope) {
  if (!scope) return ''
  return scope.kind === 'workspace'
    ? `本工作台的 ${scope.roots.length} 个工作区`
    : `该机器的挂载根 ${scope.roots.join('、')}`
}
