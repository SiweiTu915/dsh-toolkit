import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_WORK_LEDGER = join(mkdtempSync(join(tmpdir(), "dsh-work-j-")), "workitems.jsonl");

const { append, loadItems } = await import("../lib/ledger.mjs");
const { JUDGE_SYSTEM, buildJudgePrompt, judgeItem, textOf } = await import("../lib/index.js");

/** 最小 BlockAssembler 替身：只收 text 块与 finish。 */
class FakeAssembler {
  constructor() { this.texts = []; this.finish = undefined; }
  push(chunk) {
    if (chunk.type === "text") this.texts.push(chunk.text);
    if (chunk.type === "finish") this.finish = chunk.reason;
  }
  blocks() { return this.texts.map((text) => ({ type: "text", text })); }
}

function fakeCtx(chunks) {
  return {
    get: (name) => (name === "llm" ? {
      stream(options) {
        fakeCtx.lastOptions = options;
        return (async function* () { for (const chunk of chunks) yield chunk; })();
      },
    } : undefined),
  };
}

const agent = { session: { id: "s1", requestHeader: () => ({ config: { provider: "deepseek-official", model: "deepseek-chat" } }) } };
const item = { id: "w-x", subject: "job-1", state: "person/决策", summary: "作业 job-1 失败（exit 1）" };
const status = { state: "fail", exit: "1", finished: "2026-11-02T00:00:00Z", log: "ModuleNotFoundError: No module named 'torch'" };

test("buildJudgePrompt：包含作业标识、摘要、结束时间与日志", () => {
  const p = buildJudgePrompt(item, status);
  assert.match(p, /job-1/u);
  assert.match(p, /exit=1/u);
  assert.match(p, /ModuleNotFoundError/u);
  assert.match(p, /2026-11-02/u);
});

test("buildJudgePrompt：日志超长只留末尾 6000 字符", () => {
  const p = buildJudgePrompt(item, { ...status, log: `${"x".repeat(7000)}TAIL` });
  assert.ok(p.length < 7000);
  assert.match(p, /TAIL/u);
});

test("textOf：只取 text 块并去空白", () => {
  assert.equal(textOf([{ type: "text", text: " a " }, { type: "thinking", text: "no" }, { type: "text", text: "b" }]), "a \nb");
});

test("judgeItem：成功时返回模型文本，并把判断写进台账", async () => {
  append({ op: "add", id: "w-j", state: "person/决策", waiting: "你", summary: "作业 job-1 失败", subject: "job-1" });
  const chunks = [{ type: "text", text: "原因：缺 torch" }, { type: "text", text: "下一步：pip install torch" }, { type: "finish", reason: { kind: "stop" } }];
  const ctx = fakeCtx(chunks);
  const text = await judgeItem(ctx, agent, item, undefined, { fetchJobLog: async () => status, BlockAssembler: FakeAssembler });
  assert.match(text, /缺 torch/u);
  assert.match(text, /pip install/u);
  // 请求形状：用了会话路由到的模型，且带了 purpose
  assert.equal(fakeCtx.lastOptions.provider, "deepseek-official");
  assert.equal(fakeCtx.lastOptions.model, "deepseek-chat");
  assert.equal(fakeCtx.lastOptions.purpose, "work-judge");
  assert.equal(fakeCtx.lastOptions.messages[0].content[0].text, JUDGE_SYSTEM);
});

test("judgeItem：模型异常结束要抛错，不能把半截当结论", async () => {
  const ctx = fakeCtx([{ type: "text", text: "半截" }, { type: "finish", reason: { kind: "error" } }]);
  await assert.rejects(
    () => judgeItem(ctx, agent, item, undefined, { fetchJobLog: async () => status, BlockAssembler: FakeAssembler }),
    /异常/u,
  );
});

test("judgeItem：拿不到模型路由就明确报错", async () => {
  const noRoute = { session: { id: "s2", requestHeader: () => ({}) } };
  await assert.rejects(
    () => judgeItem(fakeCtx([]), noRoute, item, undefined, { fetchJobLog: async () => status, BlockAssembler: FakeAssembler }),
    /模型路由/u,
  );
});

test("judgeItem：模型返回空文本要报错", async () => {
  const ctx = fakeCtx([{ type: "finish", reason: { kind: "stop" } }]);
  await assert.rejects(
    () => judgeItem(ctx, agent, item, undefined, { fetchJobLog: async () => status, BlockAssembler: FakeAssembler }),
    /没有返回文本/u,
  );
});
