// dsh-remote — 凭据存取:优先 OS 凭据库,失败降级到本地文件
//
// 借鉴自 dsh-remote@0.8.14 的 lib/credential.js:
// 每个后端都是 best-effort —— 任何失败都返回 { ok:false },调用方回退明文,
// 功能绝不因为凭据库不可用而阻塞。
//
// 后端:
//   darwin → `security` 命令(登录钥匙串,generic password)
//   win32  → 暂不支持,直接走文件后端
//   其他   → 文件后端(0600,位于 $DSH_HOME/dsh-remote/.credentials.json)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SERVICE = 'dsh-remote'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const FALLBACK_FILE = join(DSH_HOME, 'dsh-remote', '.credentials.json')

export function platformBackend() {
  if (process.platform === 'darwin') return 'keychain'
  return 'file'
}

function account(machineId) {
  return String(machineId ?? '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'
}

function readFallback() {
  try { return JSON.parse(readFileSync(FALLBACK_FILE, 'utf8')) } catch { return {} }
}

function writeFallback(data) {
  mkdirSync(dirname(FALLBACK_FILE), { recursive: true })
  writeFileSync(FALLBACK_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(FALLBACK_FILE, 0o600) } catch { /* ignore */ }
}

/** 读取密码。返回 { ok, password?, backend } —— 永不抛错。 */
export function getPassword(machineId) {
  const acc = account(machineId)
  if (platformBackend() === 'keychain') {
    try {
      const out = execFileSync('security',
        ['find-generic-password', '-s', SERVICE, '-a', acc, '-w'],
        { encoding: 'utf8', timeout: 8000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
      const password = out.replace(/\n$/, '')
      if (password) return { ok: true, password, backend: 'keychain' }
    } catch { /* fall through to file */ }
  }
  const data = readFallback()
  if (typeof data[acc] === 'string') return { ok: true, password: data[acc], backend: 'file' }
  return { ok: false, backend: platformBackend() }
}

/** 保存密码。返回 { ok, backend } —— 永不抛错(钥匙串失败则回退文件)。 */
export function setPassword(machineId, password) {
  const acc = account(machineId)
  if (platformBackend() === 'keychain') {
    try {
      // -U:已存在则更新
      execFileSync('security',
        ['add-generic-password', '-s', SERVICE, '-a', acc, '-w', String(password), '-U'],
        { timeout: 8000, stdio: 'ignore' })
      return { ok: true, backend: 'keychain' }
    } catch { /* fall through */ }
  }
  const data = readFallback()
  data[acc] = String(password)
  writeFallback(data)
  return { ok: true, backend: 'file' }
}

/** 删除密码。返回 { ok, backend }。 */
export function deletePassword(machineId) {
  const acc = account(machineId)
  if (platformBackend() === 'keychain') {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', acc],
        { timeout: 8000, stdio: 'ignore' })
    } catch { /* not found is fine */ }
  }
  const data = readFallback()
  if (acc in data) {
    delete data[acc]
    writeFallback(data)
  }
  return { ok: true, backend: platformBackend() }
}

/** 凭据后端现状(诊断用)。 */
export function credentialStatus(machineId) {
  const acc = account(machineId)
  const backend = platformBackend()
  const hasFile = existsSync(FALLBACK_FILE) && typeof readFallback()[acc] === 'string'
  return { backend, hasFileEntry: hasFile, file: FALLBACK_FILE }
}
