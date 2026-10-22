import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 必须在 import store 之前设好，memoryDir() 是调用时读 env 的。
const DIR = mkdtempSync(join(tmpdir(), "dsh-memory-test-"));
process.env.DSH_MEMORY_DIR = DIR;

const {
  ENTRY_RE,
  appendEntry,
  fileFor,
  formatEntry,
  loadScope,
  memoryDir,
  parseEntries,
  removeEntry,
  renderIndex,
  searchEntries,
  slugWorkspace,
  today,
} = await import("../lib/store.mjs");

test("memoryDir 跟随 DSH_MEMORY_DIR", () => {
  assert.equal(memoryDir(), DIR);
});

test("formatEntry / parseEntries 往返（无 tag）", () => {
  const line = formatEntry({ text: "PC 用 127.0.0.1 登录", id: "abcd1234", date: "2026-10-22" });
  const [entry] = parseEntries(line);
  assert.deepEqual(entry, { id: "abcd1234", text: "PC 用 127.0.0.1 登录", date: "2026-10-22", tags: [] });
});

test("formatEntry / parseEntries 往返（带 tag）", () => {
  const line = formatEntry({ text: "手机走局域网地址", tags: ["手机", "端口"], id: "beef0001", date: "2026-10-22" });
  const [entry] = parseEntries(line);
  assert.deepEqual(entry.tags, ["手机", "端口"]);
  assert.equal(entry.text, "手机走局域网地址");
});

test("formatEntry 把换行压成空格、拒绝空文本", () => {
  const line = formatEntry({ text: "  第一行\n第二行  ", id: "aaaa0001", date: "2026-10-22" });
  assert.ok(!line.includes("\n"), "不应包含换行");
  assert.match(line, /第一行 第二行/u);
  assert.throws(() => formatEntry({ text: "   " }), /不能为空/u);
});

test("parseEntries 容忍手写内容（无法识别的行被跳过，不抛错）", () => {
  const text = [
    "# 标题（手写的）",
    "",
    "- 没有 id 的一行",
    "- 合法的一条  <!-- id:deadbeef · 2026-10-20 -->",
    "  - 缩进的子项",
    "- 带 tag 的一条  <!-- id:cafe0001 · 2026-10-21 · tags:x,y -->",
    "",
  ].join("\n");
  const entries = parseEntries(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "deadbeef");
  assert.equal(entries[1].tags.length, 2);
});

test("searchEntries：多词须全部命中，大小写不敏感，tags 参与匹配", () => {
  const entries = parseEntries(
    [
      "- 手机用局域网 IP 登录  <!-- id:aaaa0002 · 2026-10-22 · tags:手机,端口 -->",
      "- 工作台用 --host 只绑一个地址  <!-- id:bbbb0002 · 2026-10-22 · tags:端口 -->",
      "- 无关的一条  <!-- id:cccc0002 · 2026-10-22 -->",
    ].join("\n"),
  );
  assert.equal(searchEntries(entries, "手机").length, 1);
  assert.equal(searchEntries(entries, "端口").length, 2, "tags 也应被匹配");
  assert.equal(searchEntries(entries, "手机 端口").length, 1, "多词是 AND");
  assert.equal(searchEntries(entries, "LOCALHOST").length, 0);
  assert.equal(searchEntries(entries, "").length, 3, "空查询返回全部");
});

test("renderIndex：全空时返回空串（不注入任何东西）", () => {
  assert.equal(renderIndex([{ label: "全局", entries: [] }]), "");
  assert.equal(renderIndex([]), "");
});

test("renderIndex：有内容时含计数、最近条目与用法提示", () => {
  const entries = parseEntries(
    ["- 较早  <!-- id:aaaa0003 · 2026-10-01 -->", "- 较新  <!-- id:bbbb0003 · 2026-10-22 -->"].join("\n"),
  );
  const text = renderIndex([{ label: "全局", entries }]);
  assert.match(text, /全局 2 条/u);
  assert.match(text, /较新/u);
  assert.match(text, /memory 工具/u);
});

test("renderIndex：遵守 maxChars 硬上限", () => {
  const entries = parseEntries(
    Array.from({ length: 40 }, (_, i) => `- 第 ${i} 条记忆内容有点长用来把索引撑爆  <!-- id:${String(i).padStart(4, "0")}aaaa · 2026-10-22 -->`).join("\n"),
  );
  // recent 默认只取 3 条，必须同时放大 recent 才能真正撑爆索引。
  const text = renderIndex([{ label: "全局", entries }], { maxChars: 200, recent: 40 });
  assert.ok(text.length <= 200, `实际 ${text.length} 字符，应 ≤200`);
  assert.match(text, /截断/u);
});

test("slugWorkspace：稳定、安全、去尾斜杠", () => {
  assert.equal(slugWorkspace("/srv/demo/example_project"), "example_project");
  assert.equal(slugWorkspace("/a/b/c/"), "c");
  assert.equal(slugWorkspace(""), "");
  assert.equal(slugWorkspace(undefined), "");
  assert.match(slugWorkspace("/a/My Project (v2)!"), /^[a-z0-9._-]+$/u);
  // 隐藏目录（~/.dsh、~/.git）不应产生 "ws-.dsh" 这种前导点
  assert.equal(slugWorkspace("/Users/x/.dsh"), "dsh");
  assert.equal(slugWorkspace("/Users/x/.git"), "git");
  assert.equal(slugWorkspace("/"), "root");
});

test("appendEntry / loadScope / removeEntry（落盘与原子写）", () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const e1 = appendEntry("global", { text: "第一条", tags: ["a"] });
  const e2 = appendEntry("global", { text: "第二条" });
  assert.notEqual(e1.id, e2.id, "id 必须唯一");
  assert.equal(e1.date, today());
  const loaded = loadScope("global");
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].text, "第二条");

  // 文件是真 markdown，可读、可 grep
  const raw = readFileSync(fileFor("global"), "utf8");
  assert.match(raw, /^- 第一条 {2}<!-- id:[0-9a-z]+ · \d{4}-\d{2}-\d{2} · tags:a -->$/mu);

  assert.equal(removeEntry("global", e1.id), true);
  assert.equal(loadScope("global").length, 1);
  assert.equal(removeEntry("global", "不存在"), false);
});

test("appendEntry 能修复没有结尾换行的文件（手改过的情况）", () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(fileFor("global"), "- 手写一条没有 id 的行", "utf8");
  const e = appendEntry("global", { text: "程序追加的一条" });
  const raw = readFileSync(fileFor("global"), "utf8");
  assert.ok(raw.includes("手写一条没有 id 的行"), "手写内容不能被吃掉");
  assert.ok(raw.includes(e.id), "新条目要落盘");
  assert.equal(loadScope("global").length, 1, "只有带 id 的那条进解析结果");
});

test("ENTRY_RE 不接受日期格式错误的行", () => {
  assert.equal(ENTRY_RE.test("- x  <!-- id:aaaa0004 · 2026/10/22 -->"), false);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
