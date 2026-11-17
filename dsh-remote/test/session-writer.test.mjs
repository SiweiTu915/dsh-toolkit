import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  buildEvents, conversationsOf, decodeSession, encodeSession, isRemoteMirror, isTemplateHome,
  displayWidth, padDisplay, previewTable, projectDirName, validateWorkspaces, applyImport, readExport,
} = await import("../session-writer.mjs");

test("会话目录名：分隔符换成 -", () => {
  assert.equal(projectDirName("/Users/x/.dsh"), "--Users-x-.dsh--");
  assert.equal(projectDirName("/root/data/a"), "--root-data-a--");
});

test("分区守卫：模板实例 / 远程镜像", () => {
  assert.equal(isTemplateHome("/Users/x/.dsh/dsh-remote/sim-homes/box"), true);
  assert.equal(isTemplateHome("/Users/x/.dsh"), false);
  assert.equal(isRemoteMirror("/Users/x/.dsh/remote-workspaces/box/a"), true);
  assert.equal(isRemoteMirror("/Users/x/Desktop/u"), false);
});

test("conversationsOf：认 5 种导出形状", () => {
  assert.equal(conversationsOf({ conversations: [{ title: "a", messages: [] }] }).length, 1);
  assert.equal(conversationsOf({ messages: [{ role: "user", content: "x" }] })[0].messages.length, 1);
  assert.equal(conversationsOf([{ role: "user", content: "y" }])[0].messages.length, 1);
  const raw = { data: { biz_data: { chat_session: { id: "c1", title: "T" }, chat_messages: [
    { role: "USER", content: "问" }, { role: "ASSISTANT", content: "答", thinking_content: "想" },
  ] } } };
  const conv = conversationsOf(raw)[0];
  assert.equal(conv.id, "c1");
  assert.equal(conv.messages[0].role, "user");
  assert.equal(conv.messages[1].thinking, "想");
  assert.throws(() => conversationsOf({ nope: 1 }), /无法识别/u);
});

test("buildEvents：turn 成对、标题指向第一条用户消息、空消息被跳过", () => {
  const conv = { title: "消融实验", messages: [
    { role: "user", content: "第一问" }, { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" }, { role: "assistant", content: "第二答" },
    { role: "user", content: "" },
  ] };
  const { events, skipped } = buildEvents(conv);
  assert.equal(skipped, 1, "空正文被跳过");
  const starts = events.filter((e) => e.type === "turn/start").length;
  const ends = events.filter((e) => e.type === "turn/end").length;
  assert.equal(starts, 2);
  assert.equal(ends, 2);
  const title = events.find((e) => e.type === "session/title");
  const firstUser = events.find((e) => e.type === "user/message");
  assert.deepEqual(title.data.messageSeqs, [firstUser.seq]);
  // seq 必须连续
  assert.ok(events.every((e, i) => e.seq === i));
});

test("buildEvents：助手回复在前（无用户消息）也能成对", () => {
  const { events } = buildEvents({ title: "t", messages: [{ role: "assistant", content: "只有回答" }] });
  assert.equal(events.filter((e) => e.type === "turn/start").length, 1);
  assert.equal(events.filter((e) => e.type === "session/title").length, 0, "没有用户消息就不造标题");
});

test("encode/decode 往返：多帧、dense、header 保留", () => {
  const { events } = buildEvents({ title: "T", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
  const header = { type: "session", version: 4, id: "session-x", createdAt: 1, cwd: "/tmp", isSeeded: false, delegationDepth: 0, agentPreset: "standard" };
  const buf = encodeSession(events, header);
  const back = decodeSession(buf);
  assert.deepEqual(back.header, header);
  assert.equal(back.events.length, events.length);
  assert.equal(back.dense, true);
});

test("decodeSession：seq 不连续要能识别出来", () => {
  const header = { type: "session", version: 4, id: "s", createdAt: 1, cwd: "/", isSeeded: false, delegationDepth: 0, agentPreset: "standard" };
  const events = [{ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } }, { type: "turn/end", seq: 5, time: 2, data: { turn: 0 } }];
  assert.equal(decodeSession(encodeSession(events, header)).dense, false);
});

test("previewTable：标记已导入、空对话、并统计将写入数", () => {
  const convs = [
    { id: "a", title: "已导", messages: [{ role: "user", content: "x" }] },
    { id: "b", title: "空的", messages: [] },
    { id: "c", title: "新的", messages: [{ role: "user", content: "y" }] },
  ];
  const { text, plan } = previewTable(convs, { sourceFile: "x.json", workspace: "/w", history: { a: { sessionId: "session-abcdef123456" } } });
  assert.match(text, /已导入过/u);
  assert.match(text, /没有用户消息/u);
  assert.equal(plan.filter((p) => p.action === "新建").length, 1);
});

test("validateWorkspaces：缺字段要报出来", () => {
  const ok = validateWorkspaces({ tables: { workspaces: { w: { path: "/a", title: "t", sessionIds: [], createdAt: 1, updatedAt: 1 } } } });
  assert.equal(ok.ok, true);
  const bad = validateWorkspaces({ tables: { workspaces: { w: { path: "/a", title: "t" } } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes("sessionIds"));
});

test("applyImport：临时 home 端到端（写会话 + 注册 + 可解码）", () => {
  const home = mkdtempSync(join(tmpdir(), "sw-home-"));
  const wsPath = join(home, "proj");
  mkdirSync(wsPath, { recursive: true });
  mkdirSync(join(home, "storages"), { recursive: true });
  writeFileSync(join(home, "storages", "workspace.json"), JSON.stringify({
    unit: "x", global: {}, tables: { workspaces: { w1: { path: wsPath, title: "t", sessionIds: [], createdAt: 1, updatedAt: 1 } } },
  }, null, 2));

  const r = applyImport({ convs: [{ id: "c1", title: "导入的", messages: [{ role: "user", content: "问" }, { role: "assistant", content: "答" }] }], workspacePath: wsPath, home });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.written.length, 1);

  const dir = join(home, "sessions", projectDirName(wsPath), r.written[0].sessionId);
  const file = join(dir, "session.v4.jsonl.zstd");
  assert.ok(existsSync(file), "会话文件应存在");
  const back = decodeSession(readFileSync(file));
  assert.equal(back.header.version, 4);
  assert.equal(back.dense, true);
  assert.ok(back.events.some((e) => e.type === "user/message"));

  const store = JSON.parse(readFileSync(join(home, "storages", "workspace.json"), "utf8"));
  assert.equal(store.tables.workspaces.w1.sessionIds.length, 1, "应注册进 workspace.json");
});

test("applyImport：模板实例直接拒绝", () => {
  const r = applyImport({ convs: [], workspacePath: "/w", home: "/Users/x/.dsh/dsh-remote/sim-homes/box" });
  assert.equal(r.ok, false);
  assert.match(r.error, /模板实例/u);
});

test("applyImport：目标工作区不在 workspace.json 时拒绝而不是瞎建", () => {
  const home = mkdtempSync(join(tmpdir(), "sw-home2-"));
  mkdirSync(join(home, "storages"), { recursive: true });
  writeFileSync(join(home, "storages", "workspace.json"), JSON.stringify({ tables: { workspaces: {} } }));
  const r = applyImport({ convs: [{ id: "x", title: "t", messages: [{ role: "user", content: "a" }] }], workspacePath: "/nope", home });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有路径为/u);
});

test("readExport：读真实文件并带指纹", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-file-"));
  const file = join(dir, "e.json");
  writeFileSync(file, JSON.stringify({ conversations: [{ id: "1", title: "t", messages: [{ role: "user", content: "x" }] }] }));
  const { list, sourceHash } = readExport(file);
  assert.equal(list.length, 1);
  assert.equal(sourceHash.length, 40);
});

test("displayWidth/padDisplay：中文算两格", () => {
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("ab"), 2);
  assert.equal(padDisplay("中文", 6), "中文  ");
});
