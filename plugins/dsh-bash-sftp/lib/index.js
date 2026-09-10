/**
 * dsh-bash-sftp —— 远程挂载下的 bash 执行器。
 *
 * 它**不重新实现任何执行逻辑**:`LocalBashExecutor` 本身就是 `ctx.subprocess`
 * 的消费方(`run()` → `spawn(['bash','-c',cmd], cwd=workdir)`),而那个接缝已由
 * `dsh-subprocess-sftp` 挪到远程。所以这个类只补两件远程世界特有的事:
 *
 * 1. **如实汇报 `sandboxMode`**。`LocalBashExecutor` 继承自 `ShellExecutor` 的
 *    getter 返回 `undefined`(不设限),但 `@deepseek-ai/dsh-permission-presets`
 *    在构造函数里硬性要求所挂 bash 执行器必须有一个 `sandboxMode` —— 否则整个
 *    组合直接启动失败。远程世界里命令以 root 身份在 GPU 机上跑,本机 harness
 *    不施加任何文件沙箱,所以诚实的答案就是 `danger-full-access`:
 *    "不做本地约束"正是事实。配套地,profile 的 permission 预置表里要有一条
 *    (danger-full-access, ask) 的条目,推导才落得到预设上。
 *
 * 2. **默认 workdir 指向挂载点**。`LocalBashExecutor.resolve()` 的兜底是
 *    `process.cwd()`(本机目录),在远程分区里那个目录没有意义。这里改成默认
 *    落到远程挂载点的本机拼写,再由 subprocess provider 映射成远程路径。
 *
 * ⚠️ 注意它**不是**沙箱:挂 `danger-full-access` 是陈述事实,不是放宽策略。
 * 本机的批准策略(`ask`)仍由 `ctx.approval` 独立控制,风险工具的审批照旧。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join as hostJoin, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 远程世界没有本地文件沙箱,如实报告为不受约束。 */
const REMOTE_SANDBOX_MODE = 'danger-full-access'

function packageCandidates(home) {
  const out = []
  try {
    for (const name of readdirSync(hostJoin(home, 'profiles'))) out.push(hostJoin(home, 'profiles', name, 'package.json'))
  } catch { /* 没有 profiles 目录就走下面的候选 */ }
  out.push(hostJoin(home, 'harness', 'current', 'node_modules'))
  return out
}

/** 解析 `@deepseek-ai/dsh-bash-local`(必须与 harness 同一份物理模块)。 */
async function loadLocalBash() {
  const home = process.env.DSH_HOME ?? hostJoin(homedir(), '.dsh')
  const tried = []
  for (const candidate of packageCandidates(home)) {
    try {
      if (candidate.endsWith('package.json')) {
        if (!existsSync(candidate)) continue
        return await import(pathToFileURL(createRequire(candidate).resolve('@deepseek-ai/dsh-bash-local')).href)
      }
      const direct = hostJoin(candidate, '@deepseek-ai', 'dsh-bash-local', 'lib', 'index.js')
      if (existsSync(direct)) return await import(pathToFileURL(direct).href)
    } catch (error) {
      tried.push(`${candidate} → ${error.message}`)
    }
  }
  try {
    return await import('@deepseek-ai/dsh-bash-local')
  } catch (error) {
    tried.push(`bare import → ${error.message}`)
  }
  throw new Error(`dsh-bash-sftp: 找不到 @deepseek-ai/dsh-bash-local(必须与 harness 同一份)\n  ${tried.join('\n  ')}`)
}

const { LocalBashExecutor } = await loadLocalBash()

/** 与 fs / subprocess provider 共用同一份挂载配置。 */
function loadMountConfig() {
  const home = process.env.DSH_HOME ?? hostJoin(homedir(), '.dsh')
  for (const name of ['remote-mount.json', 'fs-sftp.json']) {
    const file = hostJoin(home, name)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* 解析失败交给 provider 报错,这里只求拿到 localRoot */ }
  }
  return {}
}

export default class SftpBashExecutor extends LocalBashExecutor {
  constructor(ctx, config) {
    super(ctx, config)
    const mount = loadMountConfig()
    this.mountRoot = typeof mount.localRoot === 'string' && mount.localRoot
      ? posix.normalize(mount.localRoot)
      : undefined
  }

  /**
   * 远程命令不受本机文件沙箱约束 —— 这是事实陈述,不是策略放宽。
   * @returns 恒为 `danger-full-access`。
   */
  get sandboxMode() {
    return REMOTE_SANDBOX_MODE
  }

  /**
   * 与父类一致,只把 workdir 的兜底从本机 `process.cwd()` 改成远程挂载点。
   * @param request - 调用方的执行请求。
   * @returns 填好 workdir / timeout 的完整 spec。
   */
  resolve(request) {
    if (request.workdir === undefined && this.mountRoot !== undefined) {
      return super.resolve({ ...request, workdir: this.mountRoot })
    }
    return super.resolve(request)
  }
}
