// lib/repoint.mjs 的测试 —— 换端点这一次要改三处,少改一处就是「半通状态」,
// 所以把「改全 / 不动无关内容 / 可预览 / 幂等」都钉住。
// 跑法:node --test dsh-remote/test/
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planRepoint, applyRepoint, readEndpoint, sshExtraArgsFor } from '../lib/repoint.mjs'

const SSH_CONFIG = `Host keepme
  HostName untouched.example
  Port 22

Host t
  HostName old.example
  Port 22
  User root
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
`

let sandbox
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-repoint-'))
  mkdirSync(join(sandbox, 'sim-homes', 't'), { recursive: true })
  writeFileSync(join(sandbox, 'servers.json'), JSON.stringify({
    servers: [{ name: 't', conn: { host: 'old.example', user: 'root', sshPort: 22 } }],
  }, null, 2))
  writeFileSync(join(sandbox, 'sim-homes', 't', 'remote-mount.json'), JSON.stringify({
    server: 't', remoteRoot: '/root', sshTarget: 'root@old.example',
  }, null, 2))
  writeFileSync(join(sandbox, 'ssh-config'), SSH_CONFIG)
  writeFileSync(join(sandbox, 'unrelated.txt'), 'do not touch\n')
})

const opts = (extra = {}) => ({
  name: 't', host: 'new.example', port: 2222, user: 'root',
  remoteDir: sandbox, sshConfigFile: join(sandbox, 'ssh-config'), ...extra,
})

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('sshExtraArgsFor:22 端口不写 -p,其它端口要写,末尾统一接受新指纹', () => {
  assert.deepEqual(sshExtraArgsFor(22), ['-o', 'StrictHostKeyChecking=accept-new'])
  assert.deepEqual(sshExtraArgsFor(2222), ['-p', '2222', '-o', 'StrictHostKeyChecking=accept-new'])
})

test('planRepoint:三处改动都列出来,且不写盘', () => {
  const before = readFileSync(join(sandbox, 'servers.json'), 'utf8')
  const p = planRepoint(opts())
  assert.equal(p.ok, true)
  assert.deepEqual(p.changes.map((c) => c.kind).sort(), ['mount', 'servers', 'sshConfig'])
  assert.equal(readFileSync(join(sandbox, 'servers.json'), 'utf8'), before, 'plan 不该写盘')
})

test('planRepoint:参数不合法时明确报错(而不是悄悄写坏)', () => {
  assert.equal(planRepoint(opts({ host: '' })).ok, false)
  assert.equal(planRepoint(opts({ port: 0 })).ok, false)
  assert.equal(planRepoint(opts({ port: 70000 })).ok, false)
  assert.equal(planRepoint(opts({ port: 'abc' })).ok, false)
  assert.equal(planRepoint(opts({ name: 'nope' })).ok, false)
})

test('dry-run:一个字节都不写,也不产生备份', () => {
  const files = ['servers.json', 'sim-homes/t/remote-mount.json', 'ssh-config']
  const before = files.map((f) => readFileSync(join(sandbox, f), 'utf8'))
  const r = applyRepoint(opts({ sshConfig: true, dryRun: true }))
  assert.equal(r.ok, true)
  files.forEach((f, i) => assert.equal(readFileSync(join(sandbox, f), 'utf8'), before[i], `${f} 被写了`))
  assert.deepEqual(r.backups, [])
})

test('apply:三处都改到,并逐个生成备份', () => {
  const r = applyRepoint(opts({ sshConfig: true }))
  assert.equal(r.ok, true)
  assert.equal(r.applied.length, 3)
  assert.equal(r.backups.length, 3)
  for (const b of r.backups) assert.ok(existsSync(b), `备份不存在: ${b}`)

  assert.deepEqual(readJson(join(sandbox, 'servers.json')).servers[0].conn,
    { host: 'new.example', user: 'root', sshPort: 2222 })

  const m = readJson(join(sandbox, 'sim-homes/t/remote-mount.json'))
  assert.equal(m.sshTarget, 'root@new.example')
  assert.deepEqual(m.sshExtraArgs, sshExtraArgsFor(2222))
  assert.equal(m.remoteRoot, '/root', '无关字段不该被动')
})

test('apply:只动同名 Host 块 —— 块内其它行保留,别的块逐字不变', () => {
  applyRepoint(opts({ sshConfig: true }))
  const cfg = readFileSync(join(sandbox, 'ssh-config'), 'utf8')
  const block = cfg.split(/\n(?=Host )/).find((b) => b.startsWith('Host t'))
  assert.match(block, /HostName new\.example/)
  assert.match(block, /Port 2222/)
  assert.match(block, /IdentityFile ~\/\.ssh\/id_ed25519/, '块内其它行必须保留')
  assert.match(block, /ServerAliveInterval 30/)
  const keep = cfg.split(/\n(?=Host )/).find((b) => b.startsWith('Host keepme'))
  assert.equal(keep.trim(), 'Host keepme\n  HostName untouched.example\n  Port 22', '无关 Host 块不该被动')
})

test('apply:sshConfig=false 时明确跳过,不碰 ~/.ssh/config', () => {
  const before = readFileSync(join(sandbox, 'ssh-config'), 'utf8')
  const r = applyRepoint(opts({ sshConfig: false }))
  assert.equal(r.applied.length, 2)
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0], /未开启/)
  assert.equal(readFileSync(join(sandbox, 'ssh-config'), 'utf8'), before)
})

test('apply:幂等 —— 同一端点跑两次结果一致', () => {
  applyRepoint(opts({ sshConfig: true }))
  const a = ['servers.json', 'sim-homes/t/remote-mount.json', 'ssh-config']
    .map((f) => readFileSync(join(sandbox, f), 'utf8'))
  const r2 = applyRepoint(opts({ sshConfig: true }))
  assert.equal(r2.ok, true)
  const b = ['servers.json', 'sim-homes/t/remote-mount.json', 'ssh-config']
    .map((f) => readFileSync(join(sandbox, f), 'utf8'))
  assert.deepEqual(a, b, '同值二次应用不该改变内容')
})

test('apply:没有同名 Host 块时只跳过第三处,不报错', () => {
  writeFileSync(join(sandbox, 'ssh-config'), 'Host other\n  HostName x.example\n')
  const r = applyRepoint(opts({ sshConfig: true }))
  assert.equal(r.ok, true)
  assert.equal(r.applied.length, 2)
  assert.match(r.skipped.join(' '), /没有 Host t 块/)
})

test('readEndpoint:一眼看全三处,且能判一致性', () => {
  const ep = readEndpoint('t', sandbox, join(sandbox, 'ssh-config'))
  assert.deepEqual(ep.conn, { host: 'old.example', user: 'root', sshPort: 22 })
  assert.equal(ep.mounts.length, 1)
  assert.equal(ep.mounts[0].remoteRoot, '/root')
  assert.equal(ep.sshConfig.found, true)
  assert.equal(ep.consistent, true)
  assert.deepEqual(ep.problems, [])

  // 把别名指向别处 → 必须能报出来
  writeFileSync(join(sandbox, 'ssh-config'), 'Host t\n  HostName elsewhere.example\n  Port 22\n')
  const ep2 = readEndpoint('t', sandbox, join(sandbox, 'ssh-config'))
  assert.equal(ep2.consistent, false)
  assert.ok(ep2.problems.some((p) => p.includes('别名')))
})

test('apply:改完不会留下多余的临时文件', () => {
  applyRepoint(opts({ sshConfig: true }))
  const leftovers = readdirSync(sandbox).filter((f) => f.startsWith('.') && f !== '.')
  assert.deepEqual(leftovers, [])
})
