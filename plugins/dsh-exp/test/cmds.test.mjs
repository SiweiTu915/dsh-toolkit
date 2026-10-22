import assert from "node:assert/strict";
import test from "node:test";

const {
  ID_RE,
  newJobId,
  parseList,
  parseStatus,
  shq,
  statusScript,
  stopScript,
  submitScript,
} = await import("../lib/cmds.mjs");

test("shq 正确转义单引号", () => {
  assert.equal(shq("abc"), "'abc'");
  assert.equal(shq("a'b"), `'a'\\''b'`);
});

test("newJobId 合法且可排序", () => {
  const a = newJobId(Date.UTC(2026, 9, 22, 10, 0, 0), 0.1);
  const b = newJobId(Date.UTC(2026, 9, 22, 11, 0, 0), 0.2);
  assert.match(a, ID_RE);
  assert.ok(a < b, "时间早的 id 应更小，便于按 id 倒序");
});

test("submitScript：命令以 base64 传递，多行也不破坏引号", () => {
  const cmd = `python train.py --name "exp 1"\n  --lr 1e-3\n`;
  const s = submitScript({ id: "20261022-1000-abcd", command: cmd, workdir: "/root/proj" });
  const b64 = Buffer.from(cmd, "utf8").toString("base64");
  assert.ok(s.includes(b64), "应包含命令的 base64");
  assert.ok(!s.includes('--name "exp 1"'), "原始命令不应直接出现在脚本里");
  assert.ok(s.includes("base64 -d"), "应在远端解码");
  assert.ok(s.includes("setsid"), "必须用 setsid 隔离");
  assert.ok(s.includes("wrapper.sh"), "应写入 wrapper 以记录 pid");
  assert.ok(s.includes("cd '/root/proj'"), "应进入指定工作目录");
});

test("submitScript / statusScript / stopScript 拒绝非法 id（防路径穿越）", () => {
  for (const bad of ["../x", "a/b", "", "a b", "-leading"]) {
    assert.throws(() => submitScript({ id: bad, command: "true" }), /非法 id/u);
    assert.throws(() => statusScript({ id: bad }), /非法 id/u);
    assert.throws(() => stopScript({ id: bad }), /非法 id/u);
  }
});

test("statusScript 的日志行数被夹在合理区间", () => {
  assert.match(statusScript({ id: "abc", lines: 0 }), /tail -n 40/u);
  assert.match(statusScript({ id: "abc", lines: 99999 }), /tail -n 2000/u);
  assert.match(statusScript({ id: "abc", lines: 5 }), /tail -n 5/u);
});

test("parseList：解析、跳过垃圾行、按 id 倒序", () => {
  const stdout = [
    "20261022-1000-aaaa|running|2026-10-22T10:00:00Z|1024|epoch 3 loss=0.12",
    "垃圾行",
    "20261022-1200-bbbb|ended|2026-10-22T12:00:00Z|0|",
    "",
  ].join("\n");
  const jobs = parseList(stdout);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, "20261022-1200-bbbb", "新的在前");
  assert.equal(jobs[1].running, true);
  assert.equal(jobs[1].last, "epoch 3 loss=0.12");
  assert.equal(jobs[0].bytes, 0);
});

test("parseStatus：分开头部字段与日志正文", () => {
  const stdout = [
    "STATE=running",
    "PID=4242",
    "STARTED=2026-10-22T10:00:00Z",
    "WORKDIR=/root/proj",
    "BYTES=2048",
    "---LOG_TAIL---",
    "line-1",
    "line-2",
  ].join("\n");
  const st = parseStatus(stdout);
  assert.equal(st.running, true);
  assert.equal(st.pid, "4242");
  assert.equal(st.workdir, "/root/proj");
  assert.equal(st.bytes, 2048);
  assert.equal(st.log, "line-1\nline-2");
});

test("parseStatus：已结束时 running=false，pid 为 null", () => {
  const st = parseStatus("STATE=ended\nPID=-\n---LOG_TAIL---\ndone\n");
  assert.equal(st.running, false);
  assert.equal(st.pid, null);
  assert.equal(st.log, "done\n");
});
