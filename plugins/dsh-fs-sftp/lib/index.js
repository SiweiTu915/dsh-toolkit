/**
 * dsh-fs-sftp —— 把 `ctx.fs` 接到远程机器的 SFTP 上。
 *
 * 目的:让一个 DSH 会话的「文件世界」直接就是远程机器,不拉任何文件到本机。
 * 这是官方 `@deepseek-ai/dsh-fs-e2b`(远程执行世界的 fs provider)的同构实现,
 * 区别是后端用 SFTP 而不是 E2B SDK。
 *
 * 关键约束(来自 harness 源码,不是设计选择):
 *   - `FileSystem` 的服务名固定是 `"fs"`(`super(ctx, "fs")`),全局单例。
 *     所以必须把 profile 里的 `fs-sandbox` 禁用掉,由本插件接管。
 *   - 工作区注册表(dsh-workspace)用 **宿主机** `node:fs/promises` 的
 *     `realpath` + `stat` 校验目录,不经过 `ctx.fs`。因此工作区根目录必须是
 *     本机真实存在的目录 —— 这里用「本地空挂载点目录 → 远程真实目录」的前缀
 *     映射满足它:本机只有空目录(几个 inode),文件内容全在远程。
 *
 * 路径映射:
 *   localRoot/proj/src/a.py   ⇄   remoteRoot/proj/src/a.py
 * 两种拼写都接受(既容忍 harness 侧拼写,也容忍模型直接写远程绝对路径)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join as hostJoin, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

const BINARY_SAMPLE_BYTES = 8192
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024 * 1024
const DEFAULT_DIFF_BASIS_MAX_BYTES = 1024 * 1024

/**
 * 解析 `@deepseek-ai/dsh-fs`。必须拿到与 harness **同一份物理模块**,
 * 否则 `extends FileSystem` 会绑到另一份 cordis 上,服务注册静默错位。
 * profile 的 node_modules 指向 harness 自己的安装目录,所以从那里解析最稳。
 */
function fsContractCandidates() {
  const out = []
  if (process.env.DSH_FS_MODULE) out.push(process.env.DSH_FS_MODULE)
  const home = process.env.DSH_HOME
  if (home) {
    const profiles = hostJoin(home, 'profiles')
    try {
      for (const name of readdirSync(profiles)) out.push(hostJoin(profiles, name, 'package.json'))
    } catch { /* 没有 profiles 目录就走下面的候选 */ }
    out.push(hostJoin(home, 'harness', 'current', 'node_modules', '@deepseek-ai', 'dsh-fs', 'lib', 'index.js'))
  }
  return out
}

async function loadFsContract() {
  const tried = []
  for (const candidate of fsContractCandidates()) {
    try {
      if (candidate.endsWith('package.json')) {
        if (!existsSync(candidate)) continue
        const resolved = createRequire(candidate).resolve('@deepseek-ai/dsh-fs')
        return await import(pathToFileURL(resolved).href)
      }
      if (existsSync(candidate)) return await import(pathToFileURL(candidate).href)
    } catch (error) {
      tried.push(`${candidate} → ${error.message}`)
    }
  }
  try {
    return await import('@deepseek-ai/dsh-fs')
  } catch (error) {
    tried.push(`bare import → ${error.message}`)
  }
  throw new Error(`dsh-fs-sftp: 找不到 @deepseek-ai/dsh-fs(必须与 harness 同一份)\n  ${tried.join('\n  ')}`)
}

const { FileSystem, FsError, FsVersion } = await loadFsContract()

/* ------------------------------------------------------------------ 工具 --- */

function throwIfAborted(signal, verb) {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

/** SFTP 的 stat 没有 inode/ctime,版本只能由 mode+size+mtime+owner 拼。 */
function versionOf(info) {
  return FsVersion(`${Number(info.mode) & 0o7777}:${Number(info.size)}:${Number(info.mtime)}:${Number(info.uid ?? 0)}:${Number(info.gid ?? 0)}`)
}

/** follow=false 时按 lstat 语义先看符号链接本身。 */
function typeOf(info, follow) {
  if (!follow && typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) return 'symlink'
  if (typeof info.isDirectory === 'function' && info.isDirectory()) return 'directory'
  if (typeof info.isFile === 'function' && info.isFile()) return 'file'
  return 'other'
}

function isNotFound(error) {
  return error?.code === 2 || /no such file/i.test(String(error?.message ?? ''))
}

function isConnectionError(error) {
  const code = error?.code
  if (typeof code === 'string' && ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true
  return /connection lost|no response from server|channel closed|not connected|socket hang up|connection closed/i.test(String(error?.message ?? ''))
}

/** SFTP 状态码 → FsError 词汇表(fs-local 用的同一套 code)。 */
function mapRemoteError(error, verb, displayPath) {
  if (error instanceof FsError) return error
  const code = error?.code
  if (code === 2) return new FsError(`cannot ${verb} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  if (code === 3) return new FsError(`cannot ${verb} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  if (code === 4) return new FsError(`cannot ${verb} "${displayPath}": ${error.message}`, 'FS_IO_ERROR', { cause: error })
  return new FsError(`cannot ${verb} "${displayPath}": ${error?.message ?? error}`, 'FS_IO_ERROR', { cause: error })
}

function decodeUtf8(buffer, verb, displayPath) {
  const sample = buffer.subarray(0, BINARY_SAMPLE_BYTES)
  if (sample.includes(0)) throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
  }
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n')
}

function splitLineEndings(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return { content: normalizeLineEndings(text), lineEndings: crlf > lf ? 'crlf' : 'lf' }
}

function restoreLineEndings(text, mode) {
  return mode === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

function applyLiteralEdit(text, oldString, newString, replaceAll, displayPath) {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString must be a non-empty string`, 'FS_EDIT_NOT_FOUND')
  }
  const first = text.indexOf(oldString)
  if (first === -1) throw new FsError(`cannot edit "${displayPath}": oldString not found`, 'FS_EDIT_NOT_FOUND')
  if (!replaceAll) {
    if (text.indexOf(oldString, first + oldString.length) !== -1) {
      throw new FsError(`cannot edit "${displayPath}": oldString appears more than once (set replaceAll)`, 'FS_AMBIGUOUS_EDIT')
    }
    return text.slice(0, first) + newString + text.slice(first + oldString.length)
  }
  return text.split(oldString).join(newString)
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`dsh-fs-sftp: config.${name} 必须是非空字符串`)
  return value
}

/**
 * 分区级配置:`<DSH_HOME>/remote-mount.json`(旧名 `fs-sftp.json` 仍兼容)。
 * 三个远程 provider(fs / subprocess / bash)共用这一份映射。
 */
function loadSidecarConfig() {
  const home = process.env.DSH_HOME ?? '.'
  for (const name of ['remote-mount.json', 'fs-sftp.json']) {
    const file = hostJoin(home, name)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是对象')
      return parsed
    } catch (error) {
      throw new Error(`dsh-fs-sftp: 解析 ${file} 失败: ${error.message}`)
    }
  }
  return {}
}

/* -------------------------------------------------------------- provider --- */

export default class SftpFileSystem extends FileSystem {
  constructor(ctx, config) {
    super(ctx)
    // 配置来源:条目 config 优先,否则读 <DSH_HOME>/fs-sftp.json(每个分区各一份)。
    const cfg = { ...loadSidecarConfig(), ...(config ?? {}) }
    this.cfg = {
      localRoot: posix.normalize(requireString(cfg.localRoot, 'localRoot')),
      remoteRoot: posix.normalize(typeof cfg.remoteRoot === 'string' && cfg.remoteRoot ? cfg.remoteRoot : '/'),
      remoteDir: cfg.remoteDir ?? hostJoin(process.env.DSH_HOME ?? '.', 'dsh-remote'),
      server: cfg.server,
      explicit: { host: cfg.host, port: cfg.port, user: cfg.user, keyPath: cfg.keyPath, password: cfg.password },
      readOnly: cfg.readOnly === true,
      maxBytes: cfg.maxBytes ?? DEFAULT_MAX_BYTES,
      maxTextBytes: cfg.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      diffBasisMaxBytes: cfg.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES,
      connectTimeoutMs: cfg.connectTimeoutMs ?? 20000,
    }
    this.locks = new Map()
    this.transportPromise = null
    this.connected = null
    // 挂载点必须是本机真实目录(工作区注册表用宿主机 realpath/stat 校验)。
    try {
      mkdirSync(this.cfg.localRoot, { recursive: true })
    } catch { /* 只读挂载点已存在或权限不足时交给后续操作报错 */ }
  }

  /* ------------------------------ 路径映射 ------------------------------ */

  /** harness 侧路径(本地拼写或远程拼写)→ 远程绝对路径。 */
  remotePathFor(harnessPath) {
    const p = posix.normalize(harnessPath)
    const { localRoot, remoteRoot } = this.cfg
    if (p === localRoot) return remoteRoot
    if (p.startsWith(localRoot + '/')) return posix.join(remoteRoot, p.slice(localRoot.length + 1))
    if (p === remoteRoot || p.startsWith(remoteRoot === '/' ? '/' : remoteRoot + '/')) return p
    throw new FsError(`"${p}" 不在远程挂载点 ${localRoot} 之内`, 'FS_NOT_FOUND')
  }

  /* ------------------------------ 连接管理 ------------------------------ */

  resolveServerEntry() {
    const { remoteDir, server, explicit } = this.cfg
    let entry = {}
    if (server) {
      const file = hostJoin(remoteDir, 'servers.json')
      let raw
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        throw new Error(`dsh-fs-sftp: 读不到 ${file}: ${error.message}`)
      }
      entry = (raw.servers ?? []).find((s) => s.name === server)
      if (!entry) {
        const names = (raw.servers ?? []).map((s) => s.name).join(', ') || '无'
        throw new Error(`dsh-fs-sftp: servers.json 里没有机器 "${server}"(可用: ${names})`)
      }
    }
    const conn = entry.mirror ?? entry.conn ?? {}
    const host = explicit.host ?? conn.host ?? (entry.host !== '127.0.0.1' ? entry.host : undefined)
    if (!host) throw new Error(`dsh-fs-sftp: 没有可用的 SSH 连接信息(检查 config.server / config.host)`)
    return {
      host,
      user: explicit.user ?? conn.user ?? entry.user ?? 'root',
      port: Number(explicit.port ?? conn.sshPort ?? entry.sshPort ?? 22) || 22,
      keyPath: explicit.keyPath ?? conn.keyPath ?? entry.keyPath,
      password: explicit.password,
      machineId: entry.name,
      timeoutMs: this.cfg.connectTimeoutMs,
    }
  }

  invalidate() {
    const current = this.connected
    this.connected = null
    this.transportPromise = null
    try { current?.end?.() } catch { /* 已经断了 */ }
  }

  async openTransport() {
    const module = await import(pathToFileURL(hostJoin(this.cfg.remoteDir, 'lib', 'sftp.mjs')).href)
    const transport = await module.connect(this.resolveServerEntry())
    // sftp.mjs 没包 lstat,这里补一个(契约的 lstat 是 no-follow 语义)。
    transport.lstat = (remotePath) => new Promise((resolve, reject) => {
      transport.sftp.lstat(remotePath, (error, info) => (error ? reject(error) : resolve(info)))
    })
    transport.chmod = (remotePath, mode) => new Promise((resolve, reject) => {
      transport.sftp.chmod(remotePath, mode, (error) => (error ? reject(error) : resolve()))
    })
    this.connected = transport
    return transport
  }

  async transport() {
    if (this.connected) return this.connected
    if (!this.transportPromise) {
      this.transportPromise = this.openTransport().catch((error) => {
        this.transportPromise = null
        throw error
      })
    }
    return this.transportPromise
  }

  /** 断线自动重连一次。 */
  async withTransport(op, verb, displayPath) {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const transport = await this.transport()
      try {
        return await op(transport)
      } catch (error) {
        lastError = error
        if (attempt === 0 && isConnectionError(error)) {
          this.invalidate()
          continue
        }
        throw mapRemoteError(error, verb, displayPath)
      }
    }
    throw mapRemoteError(lastError, verb, displayPath)
  }

  async withLock(targetKey, op) {
    const run = (this.locks.get(targetKey) ?? Promise.resolve()).then(op, op)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  /* ------------------------------ 契约方法 ------------------------------ */

  async resolve(path, opts) {
    throwIfAborted(opts?.signal, 'resolve')
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    }
    const cwd = opts?.cwd ?? this.cfg.localRoot
    const absolute = posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(cwd, path)
    this.remotePathFor(absolute)
    throwIfAborted(opts?.signal, 'resolve')
    return { targetKey: absolute, displayPath: absolute }
  }

  processPath(target) {
    return String(target.targetKey)
  }

  fileUrl(target) {
    return pathToFileURL(this.processPath(target)).href
  }

  contains(parent, child) {
    const base = this.processPath(parent)
    const target = this.processPath(child)
    if (base === target) return true
    const rel = posix.relative(base, target)
    return rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel)
  }

  async probe(harnessPath, { follow = true } = {}) {
    const remote = this.remotePathFor(harnessPath)
    return this.withTransport(async (transport) => {
      try {
        return follow ? await transport.stat(remote) : await transport.lstat(remote)
      } catch (error) {
        if (error?.code === 2) return null
        throw error
      }
    }, 'stat', harnessPath)
  }

  meta(info, follow) {
    return { version: versionOf(info), type: typeOf(info, follow), size: Number(info.size) }
  }

  async stat(target, signal) {
    throwIfAborted(signal, 'stat')
    const info = await this.probe(target.targetKey, { follow: true })
    throwIfAborted(signal, 'stat')
    return info ? this.meta(info, true) : undefined
  }

  async lstat(path, opts, signal) {
    throwIfAborted(signal, 'lstat')
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    }
    const cwd = opts?.cwd ?? this.cfg.localRoot
    const absolute = posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(cwd, path)
    const info = await this.probe(absolute, { follow: false })
    throwIfAborted(signal, 'lstat')
    return info ? this.meta(info, false) : undefined
  }

  /** 读原始字节,先做常规文件与体积检查。 */
  async readBuffer(harnessPath, displayPath, signal) {
    const info = await this.probe(harnessPath, { follow: true })
    if (!info) throw new FsError(`cannot read "${displayPath}": not found`, 'FS_NOT_FOUND')
    if (!info.isFile()) throw new FsError(`cannot read "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const remote = this.remotePathFor(harnessPath)
    return this.withTransport((transport) => transport.readFile(remote), 'read', displayPath)
  }

  async readText(target, signal) {
    throwIfAborted(signal, 'read')
    const info = await this.probe(target.targetKey, { follow: true })
    if (!info) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (!info.isFile()) throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (Number(info.size) > this.cfg.maxTextBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${this.cfg.maxTextBytes}-byte text limit`, 'FS_TOO_LARGE')
    }
    const buffer = await this.readBuffer(target.targetKey, target.displayPath, signal)
    throwIfAborted(signal, 'read')
    return decodeUtf8(buffer, 'read', target.displayPath)
  }

  streamText(target, signal) {
    const self = this
    return Promise.resolve((async function* stream() {
      yield await self.readText(target, signal)
    })())
  }

  /**
   * 读 `[offset, offset + length)` 这段字节,不解码、不做二进制判定。
   * 窗口本身就是上界:流从 offset 打开、读满 length 就停,所以无论文件多大都只
   * 缓冲这一段;窗口起点在文件末尾或之后 → 返回空(不报错)。
   *
   * 语义对齐官方 `dsh-fs-local` 的 `readByteWindow`。这是 0.1.5 新增的契约方法
   * (0.1.2 没有),供工作区文件树 / 文档预览做分页读;在 0.1.2 上多实现一个
   * 没人调用的方法无副作用。
   * @param target - 已解析的目标。
   * @param range - `offset` 起始字节(0 基)与 `length` 最大字节数。
   * @param signal - 中止读取(FS_ABORTED)。
   * @returns 至多 `length` 字节。
   */
  async readByteRange(target, range, signal) {
    throwIfAborted(signal, 'read')
    if (typeof range?.offset !== 'number' || typeof range?.length !== 'number'
      || !Number.isFinite(range.offset) || !Number.isFinite(range.length)
      || range.offset < 0 || range.length < 0) {
      throw new FsError(`cannot read "${target.displayPath}": invalid byte range`, 'FS_IO_ERROR')
    }
    const info = await this.probe(target.targetKey, { follow: true })
    if (!info) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (!info.isFile()) throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (range.length === 0) return new Uint8Array(0)
    const remote = this.remotePathFor(target.targetKey)
    const window = await this.withTransport(
      (transport) => this.readRemoteWindow(transport, remote, range, signal),
      'read',
      target.displayPath,
    )
    throwIfAborted(signal, 'read')
    return window
  }

  /**
   * 经 SFTP 读一个字节窗口。用 createReadStream 的 start/end(闭区间),
   * 越界时流自然提前结束 —— 与本地实现"窗口越界返回空"一致。
   * @param transport - 已就绪的连接。
   * @param remote - 远程绝对路径。
   * @param range - offset / length。
   * @param signal - 中止信号。
   * @returns 窗口字节。
   */
  readRemoteWindow(transport, remote, range, signal) {
    return new Promise((resolve, reject) => {
      const stream = transport.sftp.createReadStream(remote, {
        start: range.offset,
        end: range.offset + range.length - 1,
      })
      const chunks = []
      let bytes = 0
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        try { stream.destroy() } catch { /* 已结束 */ }
        reject(new FsError('read aborted', 'FS_ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      stream.on('data', (chunk) => {
        chunks.push(chunk)
        bytes += chunk.length
        // start/end 已经封顶,这里再兜一层:任何实现差异都不许读超窗口
        if (bytes > range.length) {
          try { stream.destroy() } catch { /* 已结束 */ }
        }
      })
      stream.on('error', (error) => finish(reject, mapRemoteError(error, 'read', remote)))
      stream.on('close', () => finish(resolve, Buffer.concat(chunks, Math.min(bytes, range.length))))
    })
  }

  async readBytes(target, signal, maxBytes) {
    throwIfAborted(signal, 'read')
    const limit = maxBytes ?? this.cfg.maxBytes
    const info = await this.probe(target.targetKey, { follow: true })
    if (!info) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (!info.isFile()) throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (Number(info.size) > limit) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${limit}-byte limit`, 'FS_TOO_LARGE')
    }
    const buffer = await this.readBuffer(target.targetKey, target.displayPath, signal)
    if (buffer.length > limit) {
      throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${limit}-byte limit`, 'FS_TOO_LARGE')
    }
    return buffer
  }

  async listDir(target, signal) {
    throwIfAborted(signal, 'list')
    const remote = this.remotePathFor(target.targetKey)
    const info = await this.probe(target.targetKey, { follow: true })
    if (!info) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (!info.isDirectory()) throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const raw = await this.withTransport((transport) => transport.readdir(remote), 'list', target.displayPath)
    return raw
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .sort((left, right) => left.filename.localeCompare(right.filename))
      .map((entry) => {
        const childKey = posix.join(target.targetKey, entry.filename)
        const item = {
          name: entry.filename,
          type: typeOf(entry.attrs ?? {}, false),
          target: { targetKey: childKey, displayPath: childKey },
        }
        const attrs = entry.attrs
        if (attrs && attrs.mtime !== undefined) {
          item.version = versionOf(attrs)
          item.size = Number(attrs.size)
        }
        return item
      })
  }

  /** 原子写:同目录 staging + rename(POSIX 同文件系统 rename 是原子的)。 */
  async writeAtomic(remote, content, existing, signal) {
    const mode = existing ? Number(existing.mode) & 0o777 : undefined
    const staging = `${remote}.dsh-tmp-${randomBytes(6).toString('hex')}`
    await this.withTransport(async (transport) => {
      await transport.mkdirp(posix.dirname(remote))
      throwIfAborted(signal, 'write')
      await transport.writeFile(staging, Buffer.from(content, 'utf8'))
      if (mode !== undefined) {
        try { await transport.chmod(staging, mode) } catch { /* 权限继承失败不阻断发布 */ }
      }
      throwIfAborted(signal, 'write')
      await transport.rename(staging, remote)
    }, 'write', remote)
  }

  async readForDiff(remote, displayPath, signal) {
    try {
      const info = await this.probe(this.harnessPathFor(remote), { follow: true })
      if (!info || !info.isFile() || Number(info.size) > this.cfg.diffBasisMaxBytes) return null
      const buffer = await this.withTransport((transport) => transport.readFile(remote), 'read', displayPath)
      if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return null
      return normalizeLineEndings(buffer.toString('utf8'))
    } catch {
      return null
    }
  }

  /** 远程路径反查 harness 拼写(前缀映射的逆)。 */
  harnessPathFor(remote) {
    const p = posix.normalize(remote)
    const { localRoot, remoteRoot } = this.cfg
    if (p === remoteRoot) return localRoot
    if (remoteRoot === '/' || p.startsWith(remoteRoot + '/')) {
      return posix.join(localRoot, p.slice(remoteRoot === '/' ? 1 : remoteRoot.length + 1))
    }
    return p
  }

  assertWritable(target) {
    if (this.cfg.readOnly) {
      throw new FsError(`cannot write "${target.displayPath}": 该远程挂载点是只读的`, 'FS_PERMISSION_DENIED')
    }
  }

  async writeText(target, content, expected, signal) {
    this.assertWritable(target)
    const remote = this.remotePathFor(target.targetKey)
    return this.withLock(target.targetKey, async () => {
      throwIfAborted(signal, 'write')
      const existing = await this.probe(target.targetKey, { follow: true })
      if (existing && !existing.isFile()) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (expected.version !== undefined && versionOf(existing) !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      const before = existing ? await this.readForDiff(remote, target.displayPath, signal) : null
      await this.writeAtomic(remote, content, existing, signal)
      const after = await this.probe(target.targetKey, { follow: true })
      return {
        operation: existing ? 'update' : 'create',
        version: after ? versionOf(after) : FsVersion(`missing:${remote}`),
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  async editText(target, edit, expected, signal) {
    this.assertWritable(target)
    const remote = this.remotePathFor(target.targetKey)
    return this.withLock(target.targetKey, async () => {
      throwIfAborted(signal, 'edit')
      const existing = await this.probe(target.targetKey, { follow: true })
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (!existing.isFile()) throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const original = await this.readText(target, signal)
      const split = splitLineEndings(original)
      const edited = applyLiteralEdit(split.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      await this.writeAtomic(remote, restoreLineEndings(edited, split.lineEndings), existing, signal)
      const after = await this.probe(target.targetKey, { follow: true })
      return {
        version: after ? versionOf(after) : FsVersion(`missing:${remote}`),
        before: split.content,
        after: edited,
      }
    })
  }

  /** cordis 卸载时收尾。 */
  async [Symbol.asyncDispose]() {
    this.invalidate()
  }
}
