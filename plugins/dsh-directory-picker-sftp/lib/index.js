/**
 * dsh-directory-picker-sftp —— 让 dsh 的「Add workspace」直接浏览远程目录。
 *
 * 这是 C 的正解:工作区注册表用**宿主机** node:fs 校验目录,所以工作区根必须
 * 本机真实存在;但目录**选择器**是一个可替换的接缝(`ctx.directoryPicker`)。
 * 把它换成远程版之后:
 *
 *   「Add workspace」→ 浏览的是 GPU 机上的真实目录树 → 选中即用
 *
 * 选中之所以能直接用,是因为本 provider 在**列举的同时把每个目录在本机物化成
 * 空占位目录**(0 字节,只是骨架),于是选中的路径天然满足注册表的本机校验。
 * 这就是「挂载点」该有的语义:本机只有骨架,内容全在远程。
 *
 * 契约只有 `capability()`,返回 `{kind:'browse', list, createDirectory}` ——
 * 客户端 UI(`dsh-client-ui-directory-picker-browse`)已经存在,会自动渲染这里
 * 返回的 list 结果,所以本插件零前端代码。
 *
 * 双世界:落在挂载点之内的路径走远程;之外的回退到本机文件系统(照官方 browse
 * provider 的语义),这样同一个对话框也还能挑本机目录,不丢能力。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join as hostJoin, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ------------------------------------------------- 模块身份(与 harness 同一份) --- */

async function loadPickerContract() {
  const home = process.env.DSH_HOME ?? hostJoin(homedir(), '.dsh')
  const tried = []
  const candidates = []
  try {
    for (const name of readdirSync(hostJoin(home, 'profiles'))) {
      candidates.push(hostJoin(home, 'profiles', name, 'package.json'))
    }
  } catch { /* 没有 profiles 目录就走下面的候选 */ }
  candidates.push(hostJoin(home, 'harness', 'current', 'node_modules'))
  for (const candidate of candidates) {
    try {
      if (candidate.endsWith('package.json')) {
        if (!existsSync(candidate)) continue
        const resolved = createRequire(candidate).resolve('@deepseek-ai/dsh-host-directory-picker')
        return await import(pathToFileURL(resolved).href)
      }
      const direct = hostJoin(candidate, '@deepseek-ai', 'dsh-host-directory-picker', 'lib', 'index.js')
      if (existsSync(direct)) return await import(pathToFileURL(direct).href)
    } catch (error) {
      tried.push(`${candidate} → ${error.message}`)
    }
  }
  try {
    return await import('@deepseek-ai/dsh-host-directory-picker')
  } catch (error) {
    tried.push(`bare import → ${error.message}`)
  }
  throw new Error(`dsh-directory-picker-sftp: 找不到 @deepseek-ai/dsh-host-directory-picker(必须与 harness 同一份)\n  ${tried.join('\n  ')}`)
}

const { DirectoryPicker, DirectoryPickerError } = await loadPickerContract()

/* ------------------------------------------------------------------ 配置 --- */

/** 与三个远程 provider 共用同一份挂载配置。 */
function loadMountConfig() {
  const home = process.env.DSH_HOME ?? hostJoin(homedir(), '.dsh')
  for (const name of ['remote-mount.json', 'fs-sftp.json']) {
    const file = hostJoin(home, name)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* 解析失败时按未配置处理,list 会退回本机浏览 */ }
  }
  return {}
}

/** 官方 browse provider 的默认上限(跟随 GitHub web UI 的 1000)。 */
const DEFAULT_MAX_ENTRIES = 1000

/* -------------------------------------------------------------- provider --- */

export default class SftpDirectoryPicker extends DirectoryPicker {
  constructor(ctx, config) {
    super(ctx)
    const cfg = { ...loadMountConfig(), ...(config ?? {}) }
    this.cfg = {
      maxEntries: Number(cfg.maxEntries ?? DEFAULT_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES,
      remoteDir: cfg.remoteDir ?? hostJoin(process.env.DSH_HOME ?? hostJoin(homedir(), '.dsh'), 'dsh-remote'),
      server: cfg.server,
      sshTarget: cfg.sshTarget ?? cfg.server,
      localRoot: typeof cfg.localRoot === 'string' && cfg.localRoot ? posix.normalize(cfg.localRoot) : null,
      remoteRoot: typeof cfg.remoteRoot === 'string' && cfg.remoteRoot ? posix.normalize(cfg.remoteRoot) : '/',
      connectTimeoutMs: cfg.connectTimeoutMs ?? 20000,
      // 列举时是否顺带物化本机空占位目录(关掉就只读远端,不加本机目录)
      materialize: cfg.materialize !== false,
    }
    this.transport = null
    this.transportPromise = null
    this.browseCapability = {
      kind: 'browse',
      list: (path, signal) => this.list(path, signal),
      createDirectory: (path, name) => this.createDirectory(path, name),
    }
  }

  /**
   * @returns 稳定的 browse 能力对象(消费者可能跨调用持有)。
   */
  capability() {
    return this.browseCapability
  }

  /** 该路径是否落在远程挂载点之内。 */
  insideMount(target) {
    if (!this.cfg.localRoot) return false
    const p = posix.normalize(target)
    return p === this.cfg.localRoot || p.startsWith(this.cfg.localRoot + '/')
  }

  /** harness 侧(本机拼写)路径 → 远程路径。 */
  remotePathFor(target) {
    const p = posix.normalize(target)
    const { localRoot, remoteRoot } = this.cfg
    if (p === localRoot) return remoteRoot
    return posix.join(remoteRoot, p.slice(localRoot.length + 1))
  }

  /* ------------------------------ SFTP 连接 ------------------------------ */

  resolveServerEntry() {
    const { remoteDir, server } = this.cfg
    if (!server) throw new Error('dsh-directory-picker-sftp: config 里缺少 server(remote-mount.json)')
    const file = hostJoin(remoteDir, 'servers.json')
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`dsh-directory-picker-sftp: 读不到 ${file}: ${error.message}`)
    }
    const entry = (raw.servers ?? []).find((s) => s.name === server)
    if (!entry) throw new Error(`dsh-directory-picker-sftp: servers.json 里没有机器 "${server}"`)
    const conn = entry.mirror ?? entry.conn ?? {}
    const host = conn.host ?? entry.host
    if (!host) throw new Error(`dsh-directory-picker-sftp: 机器 "${server}" 没有 SSH 连接信息`)
    return {
      host,
      user: conn.user ?? entry.user ?? 'root',
      port: Number(conn.sshPort ?? entry.sshPort ?? 22) || 22,
      keyPath: conn.keyPath ?? entry.keyPath,
      machineId: entry.name,
      timeoutMs: this.cfg.connectTimeoutMs,
    }
  }

  invalidate() {
    const current = this.transport
    this.transport = null
    this.transportPromise = null
    try { current?.end?.() } catch { /* 已经断了 */ }
  }

  async open() {
    const module = await import(pathToFileURL(hostJoin(this.cfg.remoteDir, 'lib', 'sftp.mjs')).href)
    const transport = await module.connect(this.resolveServerEntry())
    this.transport = transport
    return transport
  }

  async sftp() {
    if (this.transport) return this.transport
    if (!this.transportPromise) {
      this.transportPromise = this.open().catch((error) => {
        this.transportPromise = null
        throw error
      })
    }
    return this.transportPromise
  }

  /** 断线重连一次。 */
  async withTransport(op) {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const transport = await this.sftp()
      try {
        return await op(transport)
      } catch (error) {
        lastError = error
        const code = error?.code
        const connectionish = typeof code === 'string'
          || /connection lost|no response|channel closed|not connected/i.test(String(error?.message ?? ''))
        if (attempt === 0 && connectionish) {
          this.invalidate()
          continue
        }
        throw error
      }
    }
    throw lastError
  }

  /* ------------------------------ 列举 ------------------------------ */

  /**
   * 列出一层目录。落在挂载点内的走远程(并把每个子目录在本机物化成空占位),
   * 之外的回退到本机文件系统。
   * @param path - 要列出的绝对路径;省略时给出挂载点(没有挂载则给 home)。
   * @param signal - 调用方生命周期信号。
   * @returns 目录清单(path/home/crumbs/entries/truncated)。
   */
  async list(path, signal) {
    const fallbackHome = this.cfg.localRoot ?? homedir()
    const target = posix.normalize(path ?? fallbackHome)
    signal?.throwIfAborted()
    if (!this.insideMount(target)) return this.listLocal(target, signal, fallbackHome)
    return this.listRemote(target, signal)
  }

  async listRemote(target, signal) {
    const remote = this.remotePathFor(target)
    // 先把目标自身物化出来:从对话里直接粘一个深层路径时,它也得能被选中。
    this.materialize(target)
    let raw
    try {
      raw = await this.withTransport((transport) => transport.readdir(remote))
    } catch (error) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${error?.message ?? error}`)
    }
    signal?.throwIfAborted()
    // 与官方 browse provider 一致:只列目录和符号链接(选择器只用来挑目录)
    const dirs = raw
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .filter((entry) => entry.attrs?.isDirectory?.() || entry.attrs?.isSymbolicLink?.())
      .map((entry) => entry.filename)
      .sort((left, right) => left.localeCompare(right))
    const truncated = dirs.length > this.cfg.maxEntries
    const kept = dirs.slice(0, this.cfg.maxEntries)
    const entries = kept.map((name) => {
      const child = posix.join(target, name)
      // 物化:本机建同名空目录,选中后注册表校验才能通过
      this.materialize(child)
      return { name, path: child, hidden: name.startsWith('.') }
    })
    return {
      path: target,
      home: this.cfg.localRoot ?? target,
      crumbs: this.crumbsFor(target),
      entries,
      truncated,
    }
  }

  /** 挂载点之外:按本机文件系统列(照官方 browse provider 的语义)。 */
  async listLocal(target, signal, home) {
    let dirents
    try {
      dirents = readdirSync(target, { withFileTypes: true })
    } catch (error) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${error?.message ?? error}`)
    }
    const dirs = dirents
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
    return {
      path: target,
      home,
      crumbs: this.crumbsFor(target, true),
      entries: dirs.slice(0, this.cfg.maxEntries).map((name) => ({
        name,
        path: posix.join(target, name),
        hidden: name.startsWith('.'),
      })),
      truncated: dirs.length > this.cfg.maxEntries,
    }
  }

  /** 本机建空占位目录(0 字节,只是骨架)。 */
  materialize(target) {
    if (!this.cfg.materialize) return
    try {
      mkdirSync(target, { recursive: true })
    } catch { /* 建不出来(权限/只读挂载)时不影响列举,选中时会报错 */ }
  }

  /**
   * 面包屑:挂载点内的到挂载点为止(再往上不属于远程世界),
   * 挂载点外的一直走到文件系统根,与官方实现一致。
   * @param target - 当前目录。
   * @param toRoot - true 时一路走到 '/'。
   * @returns 由外到内的面包屑。
   */
  crumbsFor(target, toRoot = false) {
    const stop = toRoot ? posix.parse(target).root : this.cfg.localRoot
    const crumbs = []
    let current = target
    for (;;) {
      const isMount = current === this.cfg.localRoot
      crumbs.unshift({
        // 挂载点那一格显示远程身份,让操作者一眼看出这是远程目录树
        name: isMount ? `${this.cfg.sshTarget ?? this.cfg.server ?? 'remote'}:${this.cfg.remoteRoot}` : posix.basename(current),
        path: current,
        hidden: false,
      })
      if (current === stop) break
      const parent = posix.dirname(current)
      if (parent === current) break
      current = parent
    }
    return crumbs
  }

  /* ------------------------------ 新建目录 ------------------------------ */

  /**
   * 在指定父目录下建一个子目录。落在挂载点内时**同时在远程和本机建**
   * (远程是真目录,本机是空占位),这样新建完就能立刻选为工作区。
   * @param path - 已存在的父目录(绝对路径)。
   * @param name - 单个路径段。
   * @returns 新建目录的绝对路径。
   */
  async createDirectory(path, name) {
    const parent = posix.normalize(path)
    if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', posix.join(parent, String(name)), `"${name}" is not a single path segment`)
    }
    const target = posix.join(parent, name)
    if (!this.insideMount(target)) {
      try {
        mkdirSync(target)
        return target
      } catch (error) {
        if (error?.code === 'EEXIST') throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
        throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${error?.message ?? error}`)
      }
    }
    // 远程:已存在就按冲突报,与官方语义一致
    const remote = this.remotePathFor(target)
    try {
      if (await this.remoteHasConflict(remote)) {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      await this.withTransport((transport) => transport.mkdirp(remote))
    } catch (error) {
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${error?.message ?? error}`)
    }
    this.materialize(target)
    return target
  }

  /** 远程目录是否已存在(stat 命中即冲突)。 */
  async remoteHasConflict(remote) {
    return this.withTransport(async (transport) => {
      try {
        await transport.stat(remote)
        return true
      } catch (error) {
        if (error?.code === 2) return false
        throw error
      }
    })
  }
}
