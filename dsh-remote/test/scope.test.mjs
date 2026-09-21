// lib/scope.mjs 的测试 —— 访问范围解析与围栏判定。
// 这些是「工作区只能碰工作区、机器只能碰挂载根」的执行点,错了就是越权。
//
// 注意:scope.mjs 在 **import 时**就从 DSH_HOME 算出 REMOTE_DIR 了,所以必须先改
// 环境变量、再动态 import。node --test 默认每个测试文件一个子进程,互不干扰。
// 跑法:node --test dsh-remote/test/
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scope

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scope-'))
  const remote = join(home, 'dsh-remote')
  const simHome = join(remote, 'sim-homes', 'm1')
  mkdirSync(join(simHome, 'storages'), { recursive: true })

  writeFileSync(join(remote, 'servers.json'), JSON.stringify({
    servers: [
      { name: 'm1', conn: { host: 'h1.example', user: 'root', sshPort: 2222 } },
      { name: 'm2', conn: { host: 'h2.example', user: 'root', sshPort: 22 }, roots: ['/data', '/opt/x'] },
      { name: 'm3', conn: { host: 'h3.example', user: 'root', sshPort: 22, defaultPath: '/srv/app' } },
      { name: 'm4', direct: true },   // 没有 conn:不该崩,机器范围回落默认
    ],
  }, null, 2))

  // m1:挂载 localRoot ↔ remoteRoot,登记两个工作区
  writeFileSync(join(simHome, 'remote-mount.json'), JSON.stringify({
    server: 'm1', remoteRoot: '/root', localRoot: join(home, 'ws-root'),
  }, null, 2))
  writeFileSync(join(simHome, 'storages', 'workspace.json'), JSON.stringify({
    global: { workspaceIds: ['w1', 'w2', 'w3'] },
    tables: { workspaces: {
      w1: { path: join(home, 'ws-root', 'projA'), title: 'projA' },
      w2: { path: join(home, 'ws-root', 'deep', 'projB'), title: 'projB' },
      w3: { path: join(home, 'somewhere-else', 'nope'), title: 'nope' },  // 不在挂载点下 → 应被丢弃
    } },
  }, null, 2))

  process.env.DSH_HOME = home
  scope = await import('../lib/scope.mjs')
})

test('withinRoots:根自身与子路径算在内,同前缀的兄弟不算', () => {
  const R = ['/root/ws']
  assert.ok(scope.withinRoots(R, '/root/ws'))
  assert.ok(scope.withinRoots(R, '/root/ws/a/b.py'))
  // 最容易写错的两条:
  assert.ok(!scope.withinRoots(R, '/root/wsx'))
  assert.ok(!scope.withinRoots(R, '/root'))
  assert.ok(!scope.withinRoots(R, '/'))
  assert.ok(!scope.withinRoots(R, '/etc/passwd'))
})

test('withinRoots:../ 穿越在归一化阶段就被折叠掉', () => {
  const R = ['/root/ws']
  assert.ok(!scope.withinRoots(R, '/root/ws/../../etc/passwd'))
  assert.ok(scope.withinRoots(R, '/root/ws/a/../b'))
})

test('withinRoots:多根、根为 / 的情形', () => {
  assert.ok(scope.withinRoots(['/a', '/b'], '/b/x'))
  assert.ok(!scope.withinRoots(['/a', '/b'], '/c'))
  assert.ok(scope.withinRoots(['/'], '/anything'))
})

test('rootOf:取最贴合的根(而不是第一个匹配的)', () => {
  const R = ['/root', '/root/ws', '/root/ws/deep']
  assert.equal(scope.rootOf(R, '/root/ws/deep/a.py'), '/root/ws/deep')
  assert.equal(scope.rootOf(R, '/root/ws/b.py'), '/root/ws')
  assert.equal(scope.rootOf(R, '/root/c'), '/root')
  assert.equal(scope.rootOf(R, '/nope'), null)
})

test('machineRoots:显式 roots 优先,其次挂载根,其次 defaultPath,最后 /root', () => {
  const mk = (name) => ({ name, conn: null })
  assert.deepEqual(scope.machineRoots({ name: 'm2', roots: ['/data', '/opt/x'] }), ['/data', '/opt/x'])
  // m1 的挂载配置 remoteRoot=/root → 用挂载根(而不是 conn 里没有的 defaultPath)
  assert.deepEqual(scope.machineRoots({ name: 'm1' }), ['/root'])
  // 没有挂载配置时用 conn.defaultPath
  assert.deepEqual(scope.machineRoots({ name: 'm3', conn: { defaultPath: '/srv/app' } }), ['/srv/app'])
  // 什么都没有 → /root(而不是 /)
  assert.deepEqual(scope.machineRoots(mk('nope')), ['/root'])
})

test('readWorkbenchRoots:登记的工作区按 localRoot↔remoteRoot 映射,越界的丢弃', () => {
  const r = scope.readWorkbenchRoots('m1')
  assert.deepEqual(r.roots, ['/root/projA', '/root/deep/projB'])
  assert.equal(r.titles['/root/projA'], 'projA')
  // w3 在挂载点之外 → 不该出现
  assert.ok(!r.roots.some((x) => x.includes('nope')))
})

test('readMount:认得 remote-mount.json,拿得到两端根', () => {
  const m = scope.readMount('m1')
  assert.equal(m.remoteRoot, '/root')
  assert.ok(m.localRoot.endsWith('ws-root'))
  assert.equal(scope.readMount('nope'), null)
})

test('toRemoteUnder:本机路径换远程拼写,不在挂载点下给 null', () => {
  const r = scope.readWorkbenchRoots('m1')
  const local = r.roots.length ? null : null   // 只是占位,下面用 mount 反推
  const mount = scope.readMount('m1')
  assert.equal(scope.toRemoteUnder('m1', join(mount.localRoot, 'projA')), '/root/projA')
  assert.equal(scope.toRemoteUnder('m1', '/tmp/elsewhere'), null)
  assert.equal(scope.toRemoteUnder('nope', '/whatever'), null)
  void local
})

test('describeScope:给用户看的范围描述', () => {
  assert.match(scope.describeScope({ kind: 'workspace', roots: ['/a', '/b'] }), /2 个工作区/)
  assert.match(scope.describeScope({ kind: 'machine', roots: ['/root'] }), /挂载根 \/root/)
})
