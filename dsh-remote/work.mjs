#!/usr/bin/env node
/**
 * work.mjs —— 极简「工作项台账 + 实验结束触发器」，也就是 Router 的最小雏形。
 *
 * 它只做一件事：**把"实验跑完了"从"需要你想起去看"变成一条记录**。
 *
 * 为什么这么设计（对应 super-agent 的骨架，砍到只剩能跑的部分）：
 *   · Trigger  = 远端作业状态从 running 变成 done/fail
 *   · Router   = 这个脚本（轮询 + 判定 + 写台账）
 *   · Worker   = 看结果这件事，仍然交给你/之后的会话
 *   · 台账     = 追加式事件日志（append-only），可以重放，不怕写坏
 *   · 判断     = 先用**确定性规则**（不烧模型），拿不准才留给人
 *
 * 用法：
 *   node work.mjs watch [--interval 60] [--once]   轮询远端作业，状态变化就记一条
 *   node work.mjs list [--all]                     列未关闭的工作项
 *   node work.mjs show <id>
 *   node work.mjs close <id> [--note "已处理"]
 *
 * 台账位置：$DSH_HOME/workitems.jsonl（默认 ~/.dsh/workitems.jsonl），一行一个事件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const LEDGER = process.env.DSH_WORK_LEDGER ?? join(DSH_HOME, "workitems.jsonl");
const SNAPSHOT = join(DSH_HOME, ".state", "exp-watch.json");

/* ---------------------------------- 台账 ---------------------------------- */

/** 追加一条事件（append-only：写坏了也只坏最后一行）。 */
function append(event) {
  const dir = dirname(LEDGER);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), ...event });
  const prev = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "";
  // 上一行没写完（比如被 kill）时补个换行，避免粘成一行
  writeFileSync(LEDGER, `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
  return event.id;
}

/** 把事件流折叠成当前视图：id → 工作项。 */
function fold(text) {
  const items = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; } // 坏行跳过，不让台账陪葬
    if (event.op === "add") items.set(event.id, { ...event, closed: false });
    else if (event.op === "close" && items.has(event.id)) {
      items.set(event.id, { ...items.get(event.id), closed: true, closedAt: event.t, note: event.note });
    }
  }
  return [...items.values()];
}

function loadItems() {
  return fold(existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "");
}

/* ------------------------------ 判断（规则层） ------------------------------ */

/**
 * 给一条结束的作业写「摘要 + 该不该继续」。
 *
 * 这里坚持用规则而不是模型：规则可复现、零成本、不会编。拿不准的情况
 * （比如"跑完了但指标没出现在日志里"）留给人在会话里判断 —— 这正是
 * super-agent 那条纪律的缩小版：**模型不负责造权，规则先筛**。
 *
 * @param {object} job - { id, state, exit, started, finished, logTail }
 * @returns {{ state: string, waiting: string, summary: string, advice: string }}
 */
export function advise(job) {
  const tail = String(job.logTail ?? "").trim();
  const lastLine = tail.split("\n").filter(Boolean).at(-1) ?? "";
  const dur = durationText(job.started, job.finished);

  if (job.state === "fail") {
    return {
      state: "person/决策",
      waiting: "你",
      summary: `作业 ${job.id} 失败（exit ${job.exit}${dur ? `，耗时 ${dur}` : ""}）；末行：${lastLine.slice(0, 120) || "(空)"}`,
      advice: [
        "先看日志最后 20 行，别急着重跑。",
        "按这三类排查：依赖/版本 → 路径/权限 → 显存/OOM。",
        "同一个 id 连试两次都同一处失败，就改为最小复现，别再整跑。",
      ].join("\n"),
    };
  }
  if (job.state === "done") {
    return {
      state: "person/查看",
      waiting: "你",
      summary: `作业 ${job.id} 跑完（exit 0${dur ? `，耗时 ${dur}` : ""}）；末行：${lastLine.slice(0, 120) || "(空)"}`,
      advice: [
        "先把指标摘出来（别只留在 log 里）。",
        "如果这是消融矩阵的一格：记下配置 → 结果，别等齐了再补。",
        "接着该跑哪一格，现在就定，别留到下次想起来。",
      ].join("\n"),
    };
  }
  return {
    state: "working",
    waiting: "—",
    summary: `作业 ${job.id} 仍在运行${dur ? `（已 ${dur}）` : ""}`,
    advice: "",
  };
}

/** 人类可读的耗时。 */
function durationText(started, finished) {
  const a = Date.parse(started ?? "");
  const b = Date.parse(finished ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return "";
  const min = Math.round((b - a) / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`;
}

/* -------------------------------- 远端轮询 -------------------------------- */

/**
 * 取一次远端作业列表与状态。
 *
 * 复用 dsh-exp 的 `remote.mjs`（ssh 目标解析 + 超时控制），避免第二套 SSH 逻辑。
 * 它解析失败时**不能抛**：轮询器挂掉就等于监控没了，比漏一次更糟。
 */
async function scanExp() {
  const remotePath = join(homedir(), ".dsh", "plugins", "dsh-exp", "lib", "remote.mjs");
  const cmdsPath = join(homedir(), ".dsh", "plugins", "dsh-exp", "lib", "cmds.mjs");
  if (!existsSync(remotePath) || !existsSync(cmdsPath)) {
    throw new Error("找不到 dsh-exp 的 remote.mjs / cmds.mjs（实验插件没装？）");
  }
  const { runRemote } = await import(remotePath);
  const { listScript, statusScript, parseList, parseStatus } = await import(cmdsPath);

  const listOut = await runRemote(listScript(), { timeoutMs: 60000 });
  const jobs = parseList(listOut.stdout ?? "");

  const detailed = [];
  for (const job of jobs) {
    // list 只给前 160 字符末行；要判断"该不该继续"必须拿退出码与完整末行
    let status;
    try {
      const out = await runRemote(statusScript({ id: job.id, lines: 20 }), { timeoutMs: 60000 });
      status = parseStatus(out.stdout ?? "");
    } catch {
      status = undefined; // 单个作业取不到不影响其它作业
    }
    detailed.push({
      id: job.id,
      state: status?.STATE ?? job.state ?? "unknown",
      exit: status?.EXIT ?? (job.exit === undefined ? "-" : String(job.exit)),
      started: status?.STARTED ?? job.started,
      finished: status?.FINISHED ?? "-",
      logTail: status?.log ?? job.last ?? "",
    });
  }
  return detailed;
}

/** 读/写快照：只记住"上次看到的状态"，用来识别变化。 */
function loadSnapshot() {
  if (!existsSync(SNAPSHOT)) return {};
  try { return JSON.parse(readFileSync(SNAPSHOT, "utf8")); } catch { return {}; }
}

function saveSnapshot(map) {
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(map, null, 2), "utf8");
}

const ENDED = new Set(["done", "fail", "ended"]);

/**
 * 扫一轮：对比快照，把**新结束**的作业记成工作项。
 * @returns 本轮新增的工作项数组。
 */
export async function scanOnce({ quiet = false } = {}) {
  const jobs = await scanExp();
  const snapshot = loadSnapshot();
  const fresh = [];

  for (const job of jobs) {
    const before = snapshot[job.id]?.state;
    snapshot[job.id] = { state: job.state, at: new Date().toISOString() };
    // 只在"从跑着变成结束"时触发；已经是结束态的重复扫描不重复记
    if (!ENDED.has(job.state)) continue;
    if (before && ENDED.has(before)) continue;

    const verdict = advise(job);
    const id = `w-${job.id}`;
    if (loadItems().some((item) => item.id === id)) continue; // 台账里已有，不重复
    append({
      op: "add",
      id,
      kind: "exp",
      subject: job.id,
      state: verdict.state,
      waiting: verdict.waiting,
      summary: verdict.summary,
      advice: verdict.advice,
      evidence: { job: job.id, exit: job.exit, started: job.started, finished: job.finished },
    });
    fresh.push({ id, ...verdict });
    if (!quiet) console.log(`[work] 新增 ${id} · ${verdict.state}\n  ${verdict.summary}`);
  }

  saveSnapshot(snapshot);
  return fresh;
}

/* ---------------------------------- CLI ---------------------------------- */

function formatItem(item) {
  const closed = item.closed ? "✓已关闭" : "•";
  return [
    `${closed} ${item.id}  [${item.state}]  等:${item.waiting}`,
    `    ${item.summary}`,
    item.advice ? item.advice.split("\n").map((l) => `    → ${l}`).join("\n") : "",
    item.note ? `    备注: ${item.note}` : "",
  ].filter(Boolean).join("\n");
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? (rest[at + 1] && !rest[at + 1].startsWith("--") ? rest[at + 1] : true) : undefined;
  };

  if (cmd === "watch") {
    const interval = Math.max(5, Number(flag("interval")) || 60) * 1000;
    if (flag("once")) {
      const fresh = await scanOnce();
      console.log(`[work] 扫描完成，新增 ${fresh.length} 条`);
      return 0;
    }
    console.log(`[work] 开始轮询，每 ${interval / 1000}s 一次（Ctrl-C 结束）`);
    for (;;) {
      try {
        await scanOnce();
      } catch (error) {
        // 远端抖一下不能让监控停摆
        console.error(`[work] 本轮失败（继续下一轮）: ${error?.message ?? error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  if (cmd === "list") {
    const items = loadItems().filter((item) => flag("all") || !item.closed);
    if (items.length === 0) { console.log("没有待处理的工作项。"); return 0; }
    // 等人处理的排前面
    items.sort((a, b) => (a.state.startsWith("person/") === b.state.startsWith("person/") ? 0 : a.state.startsWith("person/") ? -1 : 1));
    for (const item of items) console.log(`${formatItem(item)}\n`);
    return 0;
  }

  if (cmd === "show") {
    const item = loadItems().find((entry) => entry.id === rest[0]);
    if (!item) { console.error(`没有 ${rest[0]}`); return 1; }
    console.log(formatItem(item));
    console.log(`    证据: ${JSON.stringify(item.evidence ?? {})}`);
    return 0;
  }

  if (cmd === "close") {
    const item = loadItems().find((entry) => entry.id === rest[0]);
    if (!item) { console.error(`没有 ${rest[0]}`); return 1; }
    append({ op: "close", id: item.id, note: flag("note") || "" });
    console.log(`已关闭 ${item.id}`);
    return 0;
  }

  console.log(`用法: node work.mjs <watch|list|show|close> [参数]
  watch [--interval 60] [--once]   轮询远端作业，状态从"跑着"变"结束"时记一条
  list [--all]                     列未关闭的工作项
  show <id>
  close <id> [--note "..."]`);
  return cmd ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
