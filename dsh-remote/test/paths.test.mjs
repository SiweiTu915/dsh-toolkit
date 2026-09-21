// lib/paths.mjs 的纯函数测试 —— 路径归一 / 包含判定是围栏的地基,
// 错在这里会在别处变成「越权」,所以逐个钉住。
// 跑法:node --test dsh-remote/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shq, isWindowsPath, normalizeRemotePath, joinRemotePath,
  dirnameRemote, relPathUnder, toLocalPath, toRemotePath, makeIgnore,
} from '../lib/paths.mjs'

test('normalizeRemotePath:折叠 . 与 ..,保留前导 /', () => {
  assert.equal(normalizeRemotePath('/a//b/../c'), '/a/c')
  assert.equal(normalizeRemotePath('/a/./b/'), '/a/b')
  assert.equal(normalizeRemotePath('/'), '/')
  assert.equal(normalizeRemotePath(''), '')
  assert.equal(normalizeRemotePath('/a/b/../../..'), '/')
})

test('normalizeRemotePath:Windows 盘符与 UNC 不做 POSIX 化', () => {
  assert.equal(normalizeRemotePath('D:\\Code\\\\x\\..'), 'D:\\Code')
  assert.equal(normalizeRemotePath('C:/Users/x/../y'), 'C:\\Users\\y')
  assert.equal(normalizeRemotePath('\\\\srv\\share\\a'), '\\\\srv\\share\\a')
  assert.ok(isWindowsPath('D:\\x'))
  assert.ok(!isWindowsPath('/x'))
})

test('relPathUnder:是「路径段包含」而不是字符串前缀', () => {
  assert.equal(relPathUnder('/root/ws', '/root/ws/a.py'), 'a.py')
  assert.equal(relPathUnder('/root/ws', '/root/ws'), '')
  // 这两个是最容易写错的地方:
  assert.equal(relPathUnder('/root/ws', '/root/wsx'), null)
  assert.equal(relPathUnder('/root/ws', '/root'), null)
  assert.equal(relPathUnder('/root/ws', '/etc/passwd'), null)
})

test('relPathUnder:/ 作为根时任何绝对路径都在其下', () => {
  assert.equal(relPathUnder('/', '/etc/passwd'), 'etc/passwd')
  assert.equal(relPathUnder('/', '/'), '')
})

test('joinRemotePath / dirnameRemote 沿用 base 的风格', () => {
  assert.equal(joinRemotePath('/a/b', 'c'), '/a/b/c')
  assert.equal(joinRemotePath('D:\\a', 'c'), 'D:\\a\\c')
  assert.equal(joinRemotePath('/a/b/', '/c'), '/a/b/c')
  assert.equal(dirnameRemote('/a/b/c'), '/a/b')
  assert.equal(dirnameRemote('/a'), '/')
  assert.equal(dirnameRemote('D:\\a\\b'), 'D:\\a')
})

test('toRemotePath / toLocalPath:rel 会先被清洗', () => {
  assert.equal(toRemotePath('/root', 'x/y'), '/root/x/y')
  assert.equal(toRemotePath('/root', ''), '/root')
  assert.equal(toRemotePath('/root', './x//y/'), '/root/x/y')
  assert.equal(toLocalPath('/mnt/p', 'x/y'), '/mnt/p/x/y')
})

test('shq:单引号安全转义', () => {
  assert.equal(shq("a'b"), "'a'\\''b'")
  assert.equal(shq('/plain/path'), "'/plain/path'")
})

test('makeIgnore:gitignore 风格 + 取反 + 目录前缀', () => {
  const ig = makeIgnore(['*.log', 'build/**', '!keep.log'])
  assert.ok(ig('a.log'))
  assert.ok(!ig('keep.log'))       // 后面的取反覆盖前面
  assert.ok(ig('build/x/y'))
  assert.ok(!ig('src/main.py'))
})
