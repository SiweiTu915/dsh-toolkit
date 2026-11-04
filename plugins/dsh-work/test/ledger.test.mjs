import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 台账路径依赖 DSH_WORK_LEDGER，必须在 import 之前设好
process.env.DSH_WORK_LEDGER = join(mkdtempSync(join(tmpdir(), "dsh-work-")), "workitems.jsonl");

const { advise, append, fold, formatItem, instanceName, loadItems, ownerOf, parseProgress, pendingItems, progressBar, visibleTo } = await import("../lib/ledger.mjs");

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

test("advise：被停止的作业(ended 且无退出码)不能说成仍在运行", () => {
  const v = advise({ id: "j9", state: "ended", exit: "-", logTail: "stopped by user" });
  assert.equal(v.state, "person/决策", "要进「等你决定」，不能是 working");
  assert.match(v.summary, /没有记录退出码/u);
  assert.doesNotMatch(v.summary, /仍在运行/u);
});

test("advise：真正在跑才标 working", () => {
  const v = advise({ id: "j10", state: "running" });
  assert.equal(v.state, "working");
  assert.match(v.summary, /仍在运行/u);
});

test("parseProgress：认 epoch / PROGRESS / [x/y]，取最新一行", () => {
  assert.deepEqual(parseProgress("epoch 1/30\nepoch 17/30 loss=0.3"), { done: 17, total: 30, pct: 57, label: "epoch 17/30 loss=0.3" });
  assert.equal(parseProgress("PROGRESS 5/10")?.pct, 50);
  assert.equal(parseProgress("[3/8] step")?.done, 3);
});

test("parseProgress：没有明确 x/y 就不给进度（不编）", () => {
  assert.equal(parseProgress("loss=0.31\nstill training..."), undefined);
  assert.equal(parseProgress("epoch 40/30"), undefined, "done > total 视为无效");
  assert.equal(parseProgress(""), undefined);
});

test("progressBar：有分母才画条", () => {
  assert.match(progressBar({ done: 5, total: 10, pct: 50 }), /5\/10 \(50%\)/u);
  assert.equal(progressBar(undefined), "");
});

test("归属：显式 DSH_WORK_INSTANCE 优先", () => {
  process.env.DSH_WORK_INSTANCE = "wb-a";
  assert.equal(instanceName(), "wb-a");
  delete process.env.DSH_WORK_INSTANCE;
});

test("归属：从 DSH_HOME 的 sim-homes/<name> 推断，否则 main", () => {
  process.env.DSH_HOME = "/tmp/dsh-test/.dsh/dsh-remote/sim-homes/wb-a";
  assert.equal(instanceName(), "wb-a");
  process.env.DSH_HOME = "/tmp/dsh-test/.dsh";
  assert.equal(instanceName(), "main");
});

test("可见性：自己的能看，别人的不能看，global 大家都能看", () => {
  assert.equal(visibleTo({ instance: "wb-a" }, "wb-a"), true);
  assert.equal(visibleTo({ instance: "wb-a" }, "main"), false);
  assert.equal(visibleTo({ instance: "global" }, "main"), true);
  assert.equal(visibleTo({}, "anything"), true, "没带归属的老数据按 global 处理");
  assert.equal(ownerOf({ instance: "" }), "global");
});

test("loadItems 带 instance 时只返回本实例与 global", () => {
  append({ op: "add", id: "w-mine", instance: "wb-a", state: "person/决策", waiting: "你", summary: "我的" });
  append({ op: "add", id: "w-other", instance: "wb-b", state: "person/决策", waiting: "你", summary: "别人的" });
  append({ op: "add", id: "w-global", instance: "global", state: "person/决策", waiting: "你", summary: "全局" });
  const mine = loadItems({ instance: "wb-a" }).map((item) => item.id);
  assert.ok(mine.includes("w-mine"));
  assert.ok(mine.includes("w-global"));
  assert.ok(!mine.includes("w-other"), "别人的工作项不能出现");
});
