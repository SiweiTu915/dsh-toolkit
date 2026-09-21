// lib/scope.mjs 的 fencePath 测试 —— 用**假 conn** 把 symlink 逃逸测出来。
//
// 为什么专门测这个:第一版围栏只做字符串判定,漏掉了「末尾是悬空软链」的情况 ——
// realpath 会失败,于是回退到父目录被判成「在范围内」,可真正写入时 OS 仍会顺着
// 软链落到外面。这条是实测才暴露的,所以必须钉在测试里。
// 跑法:node --test dsh-remote/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { fencePath } from '../lib/scope.mjs'
import { normalizeRemotePath } from '../lib/paths.mjs'

/** 极简内存文件系统:只把「末尾是软链」解掉,足够覆盖围栏的判定路径。 */
function makeConn({ exists = [], links = {} }) {
  const has = new Set(exists)
  const resolve = (p, depth = 0) => {
    if (depth > 8) return null
    const t = links[p]
    if (t !== undefined) {
      const next = normalizeRemotePath(t.startsWith('/') ? t : posix.join(posix.dirname(p), t))
      return resolve(next, depth + 1)
    }
    return has.has(p) ? p : null
  }
  return {
    sftp: {
      realpath(p, cb) { const r = resolve(p); r === null ? cb(new Error('ENOENT')) : cb(null, r) },
      readlink(p, cb) { links[p] !== undefined ? cb(null, links[p]) : cb(new Error('EINVAL')) },
    },
  }
}

const WS = '/root/ws'
const ROOTS = [WS]
const conn = makeConn({
  exists: [WS, `${WS}/a.py`, `${WS}/sub`, `${WS}/sub/b.py`, `${WS}/inside-link`, '/etc', '/etc/passwd', '/tmp'],
  links: {
    [`${WS}/to-etc`]: '/etc',                     // 指向外部的软链
    [`${WS}/rel-esc`]: '../../../../etc',         // 相对软链逃逸
    [`${WS}/dangling`]: '/tmp/definitely-not-here', // 悬空软链(realpath 会失败)
    [`${WS}/inside-link`]: 'sub',                 // 指向范围内
  },
})

test('范围内的路径放行(含还不存在的新文件)', async () => {
  for (const p of [`${WS}/a.py`, `${WS}/sub/b.py`, `${WS}/new-file.txt`, `${WS}/deep/new/dir/x`]) {
    const r = await fencePath(conn, p, ROOTS)
    assert.equal(r.ok, true, `${p} 应放行,却得到 ${JSON.stringify(r)}`)
  }
})

test('范围外一律拒绝', async () => {
  for (const p of ['/etc/passwd', '/root', '/', `${WS}x`, '/tmp/x']) {
    const r = await fencePath(conn, p, ROOTS)
    assert.equal(r.ok, false, `${p} 不该放行`)
  }
})

test('../ 穿越在归一化阶段就被折叠,不会绕过围栏', async () => {
  const r = await fencePath(conn, `${WS}/../../../../etc/passwd`, ROOTS)
  assert.equal(r.ok, false)
  assert.equal(r.resolved, '/etc/passwd')
})

test('软链指向范围外 → 拒绝(realpath 解出来就是外面)', async () => {
  for (const p of [`${WS}/to-etc`, `${WS}/to-etc/passwd`, `${WS}/rel-esc/x`]) {
    const r = await fencePath(conn, p, ROOTS)
    assert.equal(r.ok, false, `${p} 不该放行`)
  }
})

test('悬空软链 → 也拒绝(readlink 兜底,这是第一版漏掉的那条)', async () => {
  for (const p of [`${WS}/dangling`, `${WS}/dangling/evil.txt`]) {
    const r = await fencePath(conn, p, ROOTS)
    assert.equal(r.ok, false, `${p} 是悬空软链指向 /tmp,不该放行`)
  }
})

test('软链指向范围内 → 放行', async () => {
  const r = await fencePath(conn, `${WS}/inside-link`, ROOTS)
  assert.equal(r.ok, true)
  assert.equal(r.resolved, `${WS}/sub`)
})

test('多根:任一命中即可', async () => {
  const two = makeConn({ exists: ['/data', '/data/x', '/opt/y'] })
  assert.equal((await fencePath(two, '/data/x', ['/data'])).ok, true)
  assert.equal((await fencePath(two, '/opt/y', ['/data', '/opt'])).ok, true)
})
