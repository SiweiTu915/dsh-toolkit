import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 台账路径依赖 DSH_WORK_LEDGER，必须在 import 之前设好
process.env.DSH_WORK_LEDGER = join(mkdtempSync(join(tmpdir(), "dsh-work-")), "workitems.jsonl");

const { advise, append, fold, formatItem, loadItems, pendingItems } = await import("../lib/ledger.mjs");

test("fold：add/close/judge 三种事件折叠成当前视图", () => {
  const text = [
    JSON.stringify({ t: "t1", op: "add", id: "w-a", state: "person/决策", waiting: "你", summary: "作业 a 失败" }),
    JSON.stringify({ t: "t2", op: "add", id: "w-b", state: "person/查看", waiting: "你", summary: "作业 b 跑完" }),
    JSON.stringify({ t: "t3", op: "judge", id: "w-a", text: "原因：OOM" }),
    JSON.stringify({ t: "t4", op: "close", id: "w-b", note: "已看" }),
  ].join("\n");
  const items = fold(text);
  assert.equal(items.length, 2);
  const a = items.find((i) => i.id === "w-a");
  assert.equal(a.judgment, "原因：OOM");
  assert.equal(a.closed, false);
  assert.equal(items.find((i) => i.id === "w-b").closed, true);
});

test("fold：坏行跳过，不让台账陪葬", () => {
  const text = [
    JSON.stringify({ op: "add", id: "w-a", state: "person/决策", summary: "x" }),
    "{ 这不是 JSON",
    JSON.stringify({ op: "add", id: "w-b", state: "person/查看", summary: "y" }),
  ].join("\n");
  assert.equal(fold(text).length, 2);
});

test("append + loadItems：真的落盘并能读回", () => {
  append({ op: "add", id: "w-c", state: "person/决策", waiting: "你", summary: "作业 c 失败", advice: "先看日志" });
  const items = loadItems();
  assert.ok(items.some((i) => i.id === "w-c"));
  assert.equal(pendingItems().filter((i) => i.id === "w-c").length, 1);
});

test("advise：失败给三类排查顺序，成功提醒摘指标", () => {
  const failed = advise({ id: "j1", state: "fail", exit: "7", logTail: "boom" });
  assert.equal(failed.state, "person/决策");
  assert.match(failed.summary, /exit 7/u);
  assert.match(failed.advice, /依赖\/版本/u);

  const ok = advise({ id: "j2", state: "done", exit: "0", logTail: "acc=0.9" });
  assert.equal(ok.state, "person/查看");
  assert.match(ok.advice, /指标/u);
});

test("advise：仍在跑则标 working 且不等你", () => {
  const running = advise({ id: "j3", state: "running" });
  assert.equal(running.state, "working");
  assert.equal(running.waiting, "—");
  assert.equal(running.advice, "");
});

test("advise：耗时可读", () => {
  const v = advise({ id: "j4", state: "done", exit: "0", started: "2026-11-02T00:00:00Z", finished: "2026-11-02T01:30:00Z" });
  assert.match(v.summary, /1h30m/u);
});

test("formatItem：判断用 ★ 标注，备注附在末行", () => {
  const text = formatItem({
    id: "w-x", state: "person/决策", waiting: "你", summary: "作业 x 失败",
    advice: "先看日志", judgment: "原因：依赖缺失", note: "已处理", closed: true,
  });
  assert.match(text, /✓已关闭/u);
  assert.match(text, /★ 原因：依赖缺失/u);
  assert.match(text, /已处理/u);
});

test("pendingItems：只算未关闭且 person/* 的项", () => {
  append({ op: "add", id: "w-d", state: "working", waiting: "—", summary: "在跑" });
  append({ op: "add", id: "w-e", state: "person/决策", waiting: "你", summary: "等你" });
  append({ op: "close", id: "w-e" });
  const ids = pendingItems().map((i) => i.id);
  assert.ok(!ids.includes("w-d"), "working 不算等人");
  assert.ok(!ids.includes("w-e"), "已关闭不算");
});
