// dsh-remote — ssh2 连接与 SFTP 文件原语
//
// 为什么用 ssh2 而不是 spawn 系统 ssh:
//   · 支持密码 / keyboard-interactive / proxy jump(ssh 子进程做不到非交互输密码)
//   · 不依赖系统 ssh 配置与 known_hosts(host key 校验自己做)
//   · SFTP 可做逐文件读写/stat,而不是只能整目录 rsync
import { Client } from 'ssh2'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { getPassword } from './credential.mjs'
import { normalizeRemotePath, dirnameRemote } from './paths.mjs'

/** 内容指纹(用于"两边改成同样内容"的判定)。 */
export function hashBuf(buf) {
  return createHash('sha1').update(buf).digest('hex')
}

function defaultKeyPaths() {
  const home = process.env.HOME || ''
  return [
    process.env.DSH_REMOTE_KEY,
    `${home}/.ssh/id_ed25519`,
    `${home}/.ssh/id_rsa`,
  ].filter(Boolean)
}

/**
 * 建立连接。cfg: { host, port, user, password?, keyPath?, agent?, timeoutMs? }
 * 认证顺序:显式 password → keyPath → 门钥串里的密码 → 默认私钥 → agent。
 * 返回 { sftp, exec, end, info }(已就绪可用)。
 */
export async function connect(cfg) {
  const host = cfg.host
  const port = Number(cfg.port ?? 22)
  const user = cfg.user || 'root'
  if (!host) throw new Error('缺少 host')

  const auth = {}
  if (cfg.password) auth.password = cfg.password
  if (cfg.keyPath) auth.privateKey = readFileSync(cfg.keyPath)
  if (!auth.password && !auth.privateKey) {
    const stored = getPassword(cfg.machineId || `${host}-${user}-${port}`)
    if (stored.ok) auth.password = stored.password
  }
  if (auth.password && !auth.privateKey) {
    for (const p of defaultKeyPaths()) {
      if (p && existsSync(p)) { auth.privateKey = readFileSync(p); break }
    }
  }
  if (!auth.password && !auth.privateKey) {
    for (const p of defaultKeyPaths()) {
      if (p && existsSync(p)) { auth.privateKey = readFileSync(p); break }
    }
  }
  if (process.env.SSH_AUTH_SOCK) auth.agent = process.env.SSH_AUTH_SOCK
  if (!auth.password && !auth.privateKey && !auth.agent) {
    throw new Error('没有可用凭据:请配置私钥,或先用 `mirror.mjs passwd <机器名>` 存一次密码')
  }

  const client = new Client()
  const conn = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`连接超时: ${user}@${host}:${port}`)), cfg.timeoutMs ?? 20000)
    client.on('ready', () => { clearTimeout(timer); resolve(client) })
    client.on('error', (err) => { clearTimeout(timer); reject(err) })
    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      // 挑战响应:有密码就用密码回答(部分服务器只开 keyboard-interactive)
      finish(prompts.map(() => auth.password ?? ''))
    })
    client.connect({
      host, port, username: user, ...auth,
      tryKeyboard: true,
      readyTimeout: cfg.timeoutMs ?? 20000,
      keepaliveInterval: 30000,
    })
  })

  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)))
  })

  const p = (fn) => (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
  })

  const stat = p(sftp.stat.bind(sftp))
  const readdir = p(sftp.readdir.bind(sftp))
  const readFileRaw = p(sftp.readFile.bind(sftp))
  const writeFileRaw = p(sftp.writeFile.bind(sftp))
  const mkdirRaw = p(sftp.mkdir.bind(sftp))
  const unlinkRaw = p(sftp.unlink.bind(sftp))
  const renameRaw = p(sftp.rename.bind(sftp))
  const utimesRaw = p(sftp.utimes.bind(sftp))
  const rmdirRaw = p(sftp.rmdir.bind(sftp))

  /** 读取文件内容(Buffer)。 */
  async function readFile(remotePath) {
    return readFileRaw(normalizeRemotePath(remotePath))
  }

  /** 写入文件内容,自动建父目录。 */
  async function writeFile(remotePath, data) {
    const target = normalizeRemotePath(remotePath)
    await mkdirp(dirnameRemote(target))
    return writeFileRaw(target, data)
  }

  /** 递归建目录(已存在则忽略)。 */
  async function mkdirp(remotePath) {
    const target = normalizeRemotePath(remotePath)
    const parts = target.split(/[\\/]/).filter(Boolean)
    const win = /^[a-zA-Z]:$/.test(parts[0] ?? '')
    let cur = win ? parts[0] + '\\' : target.startsWith('/') ? '/' : ''
    const rest = win ? parts.slice(1) : parts
    for (const seg of rest) {
      cur = cur === '/' ? `/${seg}` : win && cur.endsWith('\\') ? cur + seg : cur ? `${cur}${win ? '\\' : '/'}${seg}` : seg
      try { await stat(cur) } catch {
        try { await mkdirRaw(cur) } catch (err) { if (!/Failure/i.test(String(err?.message))) throw err }
      }
    }
    return target
  }

  /** 递归列举,返回 [{ rel, size, mtimeMs }](rel 为相对 root 的 POSIX 路径)。 */
  async function walk(remoteRoot, { ignore, maxEntries = 200000 } = {}) {
    const root = normalizeRemotePath(remoteRoot)
    const out = []
    const stack = [{ abs: root, rel: '' }]
    while (stack.length) {
      const { abs, rel } = stack.pop()
      let entries
      try { entries = await readdir(abs) } catch { continue }
      for (const e of entries) {
        const name = e.filename
        const childRel = rel ? `${rel}/${name}` : name
        if (ignore && ignore(childRel)) continue
        if (e.attrs?.isDirectory?.()) {
          stack.push({ abs: `${abs.replace(/[\\/]+$/, '')}${abs.includes('\\') ? '\\' : '/'}${name}`, rel: childRel })
        } else if (e.attrs?.isFile?.()) {
          out.push({ rel: childRel, size: e.attrs.size, mtimeMs: (e.attrs.mtime ?? 0) * 1000 })
          if (out.length > maxEntries) throw new Error(`文件数超过 ${maxEntries},请用 ignore 排除大目录`)
        }
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  /** 在远程执行一条命令,返回 { code, stdout, stderr }。 */
  function exec(command) {
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        stream.on('data', (d) => { stdout += d })
        stream.stderr.on('data', (d) => { stderr += d })
        stream.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
      })
    })
  }

  /**
   * 改名/移动。**优先用 posix-rename 扩展**:普通 `SSH_FXP_RENAME` 在目标已存在时
   * 会被 OpenSSH 按 SFTP v3 规范拒绝(报 code 4 Failure),而 `ext_openssh_rename`
   * 走真正的 `rename(2)`,可覆盖。服务端不支持该扩展时退回普通 rename。
   */
  async function rename(a, b) {
    const from = normalizeRemotePath(a)
    const to = normalizeRemotePath(b)
    if (typeof sftp.ext_openssh_rename === 'function') {
      try {
        await new Promise((resolve, reject) => {
          sftp.ext_openssh_rename(from, to, (err) => (err ? reject(err) : resolve()))
        })
        return { from, to }
      } catch { /* 服务端不支持扩展 → 退回普通 rename */ }
    }
    await renameRaw(from, to)
    return { from, to }
  }

  return {
    sftp,
    stat,
    readdir,
    readFile,
    writeFile,
    mkdirp,
    unlink: (p2) => unlinkRaw(normalizeRemotePath(p2)),
    rename,
    rmdir: (p2) => rmdirRaw(normalizeRemotePath(p2)),
    utimes: (p2, atime, mtime) => utimesRaw(normalizeRemotePath(p2), atime, mtime),
    walk,
    exec,
    end: () => { try { conn.end() } catch { /* ignore */ } },
    info: { host, port, user },
  }
}
