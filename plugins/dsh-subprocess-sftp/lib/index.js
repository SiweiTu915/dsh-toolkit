/**
 * dsh-subprocess-sftp —— 把 `ctx.subprocess` 接到远程机器上(经 ssh)。
 *
 * 为什么只做这一个接缝就够:`LocalBashExecutor` 本身就是 `ctx.subprocess` 的
 * **消费方** —— 它的 `run()` 就是 `spawn(['bash','-c',command], cwd=workdir)`。
 * 所以 subprocess 一远程化,`bash` 工具自动跟着远程;`glob`/`grep` 也是走
 * `ctx.subprocess.spawn([rgPath, ...])`,同样跟着走。一个 provider 解决两个工具。
 *
 * 做法:继承 `LocalSubprocessRuntime`,**只覆盖 `spawn`**,把 argv/cwd 翻译成
 * 一条 ssh 调用。这样收集输出、spill、超时、abort、graceMs、waitForExit、
 * done 的语义全部复用官方实现,不会走样。
 *
 * 契约依据:`SubprocessRuntime` 的文档明确写着
 *   "Executable paths belong to one execution world shared with the mounted
 *    filesystem provider."
 * 即子进程接缝的可执行路径应当与挂载的 fs provider 属于同一个世界 —— 本插件
 * 正是实现这句话。
 *
 * ⚠️ 已知限制:终止只杀本机 ssh 客户端,远端进程组可能残留(ssh 的固有行为)。
 * 因此长任务仍须 `nohup ... &` 或 tmux(见 gpu-partition 技能)。
 */
import { spawn as spawnChild } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir as osTmpdir } from 'node:os'
import { basename, join as hostJoin, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ------------------------------------------------- 模块身份(与 harness 同一份) --- */

function packageCandidates(home) {
  const out = []
  const profiles = hostJoin(home, 'profiles')
  try {
    for (const name of readdirSync(profiles)) out.push(hostJoin(profiles, name, 'package.json'))
  } catch { /* 没有 profiles 目录就走下面的候选 */ }
  out.push(hostJoin(home, 'harness', 'current', 'node_modules'))
  return out
}

/**
 * 解析 `@deepseek-ai/dsh-subprocess-local`。必须与 harness 用**同一份物理模块**,
 * 否则 `extends LocalSubprocessRuntime` 会绑到另一份 cordis,服务注册静默错位。
 * profile 的 node_modules 指向 harness 安装目录,所以从那里解析最稳。
 */
async function loadLocalRuntime() {
  const home = process.env.DSH_HOME ?? hostJoin(homedir(), '.dsh')
  const tried = []
  for (const candidate of packageCandidates(home)) {
    try {
      if (candidate.endsWith('package.json')) {
        if (!existsSync(candidate)) continue
        const resolved = createRequire(candidate).resolve('@deepseek-ai/dsh-subprocess-local')
        return await import(pathToFileURL(resolved).href)
      }
      const direct = hostJoin(candidate, '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js')
      if (existsSync(direct)) return await import(pathToFileURL(direct).href)
    } catch (error) {
      tried.push(`${candidate} → ${error.message}`)
    }
  }
  try {
    return await import('@deepseek-ai/dsh-subprocess-local')
  } catch (error) {
    tried.push(`bare import → ${error.message}`)
  }
  throw new Error(`dsh-subprocess-sftp: 找不到 @deepseek-ai/dsh-subprocess-local(必须与 harness 同一份)\n  ${tried.join('\n  ')}`)
}

const { LocalSubprocessRuntime } = await loadLocalRuntime()

/* ------------------------------------------------------------------ 工具 --- */

/** POSIX 单引号包裹 —— 远程命令拼接用。 */
function shq(value) {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 配置来源:条目 config 优先,否则读 <DSH_HOME>/remote-mount.json,
 * 再退回旧名 <DSH_HOME>/fs-sftp.json(与 fs provider 共用同一份映射)。
 */
function loadSidecarConfig() {
  const home = process.env.DSH_HOME ?? hostJoin(homedir(), '.dsh')
  for (const name of ['remote-mount.json', 'fs-sftp.json']) {
    const file = hostJoin(home, name)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是对象')
      return parsed
    } catch (error) {
      throw new Error(`dsh-subprocess-sftp: 解析 ${file} 失败: ${error.message}`)
    }
  }
  return {}
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`dsh-subprocess-sftp: config.${name} 必须是非空字符串`)
  return value
}

/* -------------------------------------------------------------- provider --- */

export default class SftpSubprocessRuntime extends LocalSubprocessRuntime {
  constructor(ctx, config) {
    super(ctx)
    const cfg = { ...loadSidecarConfig(), ...(config ?? {}) }
    this.cfg = {
      localRoot: posix.normalize(requireString(cfg.localRoot, 'localRoot')),
      remoteRoot: posix.normalize(typeof cfg.remoteRoot === 'string' && cfg.remoteRoot ? cfg.remoteRoot : '/'),
      // ssh 目标:默认用 ssh config 别名(= servers.json 里的机器名)
      sshTarget: cfg.sshTarget ?? cfg.server ?? cfg.host,
      sshExtraArgs: Array.isArray(cfg.sshExtraArgs) ? cfg.sshExtraArgs : [],
      controlPersist: cfg.controlPersist ?? 120,
      // ControlPath 的落点由构造器按"展开后不超 104 字节"挑选,这里只留显式覆盖。
      cmDir: cfg.cmDir,
      controlPath: cfg.controlPath,
      // 挂载点外的 workdir:refuse(报错,与 fs provider 一致) / local(回退本地执行)
      outsideMount: cfg.outsideMount === 'local' ? 'local' : 'refuse',
      // 本地可执行文件 → 远程同名程序(按 basename 匹配)
      executableMap: { rg: cfg.remoteRg ?? '/usr/bin/rg', ...(cfg.executableMap ?? {}) },
      provision: cfg.provision !== false,
      connectTimeoutSec: cfg.connectTimeoutSec ?? 20,
    }
    if (!this.cfg.sshTarget) {
      throw new Error('dsh-subprocess-sftp: 需要 config.sshTarget(或 server)—— ssh config 里的主机别名')
    }
    // ── 连接复用(ControlMaster)──────────────────────────────────────────────
    // Unix domain socket 的 sun_path 上限是 104 字节,而 ssh 会在 ControlPath 上再
    // 追加 "." + 16 位随机后缀。macOS 的 os.tmpdir() 是 /var/folders/.../T/(49 字节),
    // 加上 40 字符的 %C 哈希必然溢出 —— 实测报 unix_listener ... too long。
    // 所以优先用真正短的 /tmp;并按**展开后**的长度做守卫,超长就干脆不复用连接。
    if (this.cfg.controlPath === undefined) {
      const candidates = this.cfg.cmDir ? [this.cfg.cmDir] : [hostJoin('/tmp', 'dsh-ssh-cm'), hostJoin(osTmpdir(), 'dsh-ssh-cm')]
      for (const dir of candidates) {
        try {
          mkdirSync(dir, { recursive: true })
        } catch {
          continue
        }
        const socketPath = hostJoin(dir, '%C')
        // %C → 40 字符;ssh 的 listener 还会追加 "." + 16 字符。
        if (socketPath.replace(/%C/g, 'x'.repeat(40)).length + 17 > 104) continue
        this.cfg.cmDir = dir
        this.cfg.controlPath = socketPath
        break
      }
      if (this.cfg.controlPath === undefined) {
        ctx.logger?.warn?.('dsh-subprocess-sftp: 找不到足够短的目录放 ssh 控制 socket,已关闭连接复用(每次命令重新建连)')
      }
    }
    // 启动时顺手确保远程有 rg(glob/grep 依赖);失败只记一笔,不阻塞启动。
    if (this.cfg.provision) void this.ensureRemoteTools()
  }

  /* ------------------------------ 路径映射 ------------------------------ */

  /** harness 侧路径 → 远程绝对路径;不在挂载点内时返回 undefined。 */
  tryRemotePath(harnessPath) {
    const p = posix.normalize(harnessPath)
    const { localRoot, remoteRoot } = this.cfg
    if (p === localRoot) return remoteRoot
    if (p.startsWith(localRoot + '/')) return posix.join(remoteRoot, p.slice(localRoot.length + 1))
    // 容忍远程拼写
    if (p === remoteRoot || p.startsWith(remoteRoot === '/' ? '/' : remoteRoot + '/')) return p
    return undefined
  }

  /**
   * 可执行文件映射:argv[0]。
   * - 裸名(如 `bash`、`rg`)→ 原样交给远程 PATH
   * - 挂载点内的绝对路径 → 前缀映射
   * - 挂载点外的绝对本地路径(如包内自带的 darwin 版 rg)→ 按 basename 查 executableMap
   */
  mapProgram(program) {
    const inside = this.tryRemotePath(program)
    if (inside !== undefined) return inside
    if (!program.startsWith('/')) return program
    const mapped = this.cfg.executableMap[basename(program)]
    if (mapped) return mapped
    return undefined // 无法映射 → 走拒绝路径,给清晰报错
  }

  /** 其余参数:只映射落在挂载点内的绝对路径,避免误伤正则/模式。 */
  mapArgument(argument) {
    if (!argument.startsWith('/')) return argument
    return this.tryRemotePath(argument) ?? argument
  }

  /* ------------------------------ ssh 调用 ------------------------------ */

  sshArgs() {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${this.cfg.connectTimeoutSec}`,
    ]
    if (this.cfg.controlPath) {
      args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${this.cfg.controlPath}`, '-o', `ControlPersist=${this.cfg.controlPersist}`)
    }
    args.push(...this.cfg.sshExtraArgs, this.cfg.sshTarget)
    return args
  }

  /** 一条 ssh 调用承载一个远程命令。 */
  sshSpec(spec, remoteCommand) {
    return {
      ...spec,
      argv: ['ssh', ...this.sshArgs(), remoteCommand],
      // 本机 ssh 子进程用被清洗过的父环境(需要 HOME / 私钥 / SSH_AUTH_SOCK);
      // 命令自己的 env 已经内联进远程命令串,不能塞给 ssh 客户端。
      cwd: homedir(),
      env: undefined,
    }
  }

  /** 远程拒绝执行:正常返回一个失败命令,而不是同步抛错(后台启动契约要求如此)。 */
  refuseSpec(spec, message) {
    return this.sshSpec(spec, `printf '%s\\n' ${shq(message)} >&2; exit 126`)
  }

  /* ------------------------------ 覆盖点 ------------------------------ */

  spawn(spec) {
    const remoteCwd = this.tryRemotePath(spec.cwd)

    if (remoteCwd === undefined) {
      if (this.cfg.outsideMount === 'local') return super.spawn(spec)
      return super.spawn(this.refuseSpec(
        spec,
        `dsh: workdir "${spec.cwd}" 不在远程挂载点 ${this.cfg.localRoot} 之内,拒绝在远程执行。`
        + `请在 dsh 里把 ${this.cfg.localRoot} 或其子目录添加为工作区(mountdir.mjs 可建占位目录)。`,
      ))
    }

    const program = this.mapProgram(spec.argv[0])
    if (program === undefined) {
      return super.spawn(this.refuseSpec(
        spec,
        `dsh: 可执行文件 "${spec.argv[0]}" 是本机路径,远程不存在同名程序;`
        + `请在 remote-mount.json 的 executableMap 里加一条 basename → 远程路径的映射。`,
      ))
    }

    const argv = [program, ...spec.argv.slice(1).map((argument) => this.mapArgument(argument))]
    const envPairs = []
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (value === undefined || !ENV_KEY.test(key)) continue
      envPairs.push(`${key}=${shq(value)}`)
    }
    const invocation = envPairs.length > 0
      ? `exec env ${envPairs.join(' ')} ${argv.map(shq).join(' ')}`
      : `exec ${argv.map(shq).join(' ')}`
    return super.spawn(this.sshSpec(spec, `cd ${shq(remoteCwd)} && ${invocation}`))
  }

  /** 终端(PTY)在远程挂载下不支持:web profile 没有挂载终端接缝,直接给清晰报错。 */
  async spawnTerminal(spec) {
    throw new Error(`dsh-subprocess-sftp: 远程挂载不支持终端会话(argv: ${spec.argv?.[0] ?? '?'})`)
  }

  /** 可执行文件解析要走远程 PATH,不能在本机 stat。 */
  async resolveExecutable(command, env, signal) {
    signal?.throwIfAborted()
    const mapped = this.mapProgram(command)
    if (mapped !== undefined) return mapped
    return super.resolveExecutable(command, env, signal)
  }

  /* ------------------------------ 远程工具预置 ------------------------------ */

  /** 确保远程有 ripgrep(glob/grep 依赖)。失败只记一笔。 */
  async ensureRemoteTools() {
    const rgPath = this.cfg.executableMap.rg
    if (!rgPath) return
    const probe = `command -v ${shq(rgPath)} >/dev/null 2>&1 && echo present || echo missing`
    try {
      const result = await this.runRemoteOnce(probe, 30000)
      if (result.stdout.includes('present')) return
      const install = `apt-get install -y ripgrep >/dev/null 2>&1 || (apt-get update >/dev/null 2>&1 && apt-get install -y ripgrep >/dev/null 2>&1); command -v ${shq(rgPath)} >/dev/null 2>&1 && echo ok || echo failed`
      const installed = await this.runRemoteOnce(install, 180000)
      if (!installed.stdout.includes('ok')) {
        this.ctx.logger?.warn?.(`dsh-subprocess-sftp: 远程 ${this.cfg.sshTarget} 上没有 ${rgPath},自动安装失败;glob/grep 会不可用。手动装:apt-get install -y ripgrep`)
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-subprocess-sftp: 预置远程工具失败(${error.message});glob/grep 可能不可用`)
    }
  }

  /** 一次性远程命令(预置检查用),不走 seam。 */
  runRemoteOnce(command, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawnChild('ssh', [...this.sshArgs(), command], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } reject(new Error('远程命令超时')) }, timeoutMs)
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
    })
  }
}
