#!/usr/bin/env node
/**
 * work.mjs —— 远端作业的「结束触发 + 在跑视图」，Router 的最小雏形。
 *
 * 它解决两件不同的事，别混在一起：
 *   1. **结束触发**：作业从「跑着」变「结束」→ 写一条工作项（等人处理）。
 *   2. **在跑视图**：还在跑的作业 **每轮刷新** 一份快照（耗时 / 日志大小 /
 *      多久没新输出）。为什么需要：对话可能早已结束、任务还在跑，等下一个
 *      对话开始时早就过了结束点 —— 中间那段对人和模型都是黑箱。
 *
 * 台账（已结束、等人）和在跑快照**分开存**：前者是低频事件，后者是每 60 秒
 * 都在变的活数据；混在一起会把台账灌满。
 *
 * 用法：
 *   node work.mjs watch [--interval 60] [--once]   扫一轮：写工作项 + 刷新在跑快照
 *   node work.mjs live                             看现在有哪些在跑（含是否卡住）
 *   node work.mjs list [--all]                     在跑 + 等你处理的
 *   node work.mjs show <id|作业id>
 *   node work.mjs close <id> [--note "已处理"]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import {
  advise,
  append,
  formatItem,
  humanMs,
  loadItems,
  loadLive,
  progressBar,
  renderRunning,
  saveLive,
  updateLive,
} from "../plugins/dsh-work/lib/ledger.mjs";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SNAPSHOT = join(DSH_HOME, ".state", "exp-watch.json");
/** 多久没有新输出算「疑似卡住」（分钟）。 */
const STALL_MIN = Number(process.env.DSH_WORK_STALL_MIN) || 10;
const ENDED = new Set(["done", "fail", "ended"]);

/* ------------------------------ 结束态快照 ------------------------------ */

function loadSnapshot() {
  if (!existsSync(SNAPSHOT)) return {};
  try {
    return JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  } catch {
    return {};
  }
}

function saveSnapshot(map) {
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(map, null, 2), "utf8");
}

/* -------------------------------- 远端扫描 -------------------------------- */

/**
 * 取一次远端作业列表与各自状态。
 *
 * 复用 dsh-exp 的 remote.mjs（ssh 目标解析 + 超时控制），不写第二套 SSH。
 */
async function scanExp() {
  const expLib = join(homedir(), ".dsh", "plugins", "dsh-exp", "lib");
  const remotePath = join(expLib, "remote.mjs");
  const cmdsPath = join(expLib, "cmds.mjs");
  if (!existsSync(remotePath) || !existsSync(cmdsPath)) {
    throw new Error("找不到 dsh-exp 的 remote.mjs / cmds.mjs（实验插件没装？）");
  }
  const { runRemote } = await import(remotePath);
  const { listScript, statusScript, parseList, parseStatus } = await import(cmdsPath);

  const listOut = await runRemote(listScript(), { timeoutMs: 60000 });
  const jobs = parseList(listOut.stdout ?? "");

  const detailed = [];
  for (const job of jobs) {
    let status;
    try {
      const out = await runRemote(statusScript({ id: job.id, lines: 20 }), { timeoutMs: 60000 });
      status = parseStatus(out.stdout ?? "");
    } catch {
      status = undefined; // 单个作业取不到不影响其它
    }
    detailed.push({
      id: job.id,
      state: status?.state ?? job.state ?? "unknown",
      exit: status?.exit ?? (job.exit === undefined ? "-" : String(job.exit)),
      started: status?.started ?? job.started,
      finished: status?.finished ?? "-",
      bytes: status?.bytes ?? job.bytes ?? 0,
      logTail: (() => {
        const text = String(status?.log ?? "");
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        return lines.at(-1) ?? job.last ?? "";
      })(),
    });
  }
  return detailed;
}

/* --------------------------------- 一轮 --------------------------------- */

/**
 * 扫一轮：刷新在跑快照；把**新结束**的作业记成工作项。
 * @returns 本轮新增的工作项
 */
export async function scanOnce({ quiet = false } = {}) {
  const jobs = await scanExp();
  const snapshot = loadSnapshot();
  const fresh = [];
  const running = [];

  for (const job of jobs) {
    const before = snapshot[job.id]?.state;
    snapshot[job.id] = { state: job.state, at: new Date().toISOString() };

    if (!ENDED.has(job.state)) {
      running.push(job);
      continue;
    }
    // 只在「从跑着变成结束」时触发；重复扫描不重复记
    if (before && ENDED.has(before)) continue;

    const verdict = advise(job);
    const id = `w-${job.id}`;
    if (loadItems().some((item) => item.id === id)) continue;
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

  // 在跑视图：**每轮都刷新**，哪怕没有新结束的作业 —— 这正是「实时进度」的来源
  const live = updateLive(running, Date.now(), STALL_MIN * 60_000);
  saveLive(live);
  saveSnapshot(snapshot);

  if (!quiet && live.jobs.length > 0) {
    const stalled = live.jobs.filter((job) => job.stalled).length;
    console.log(`[work] 在跑 ${live.jobs.length} 个${stalled ? `（${stalled} 个疑似卡住）` : ""}`);
  }
  return fresh;
}

/* --------------------------------- CLI --------------------------------- */

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
        console.error(`[work] 本轮失败（继续下一轮）: ${error?.message ?? error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  if (cmd === "live") {
    const live = loadLive();
    if (live.jobs.length === 0) {
      console.log(`没有在跑的作业（最后检查：${live.checkedAt ?? "从未"}）`);
      return 0;
    }
    console.log(`在跑 ${live.jobs.length} 个（检查于 ${live.checkedAt}）：`);
    for (const job of live.jobs) {
      const quiet = job.stalled
        ? `⚠ ${humanMs(job.quietMs)} 无新输出，疑似卡住`
        : `${humanMs(job.quietMs)} 无新输出`;
      const size = job.bytes < 1024 ? `${job.bytes}B` : `${(job.bytes / 1024).toFixed(1)}KB`;
      console.log(`  ${job.id} · 已跑 ${humanMs(job.elapsedMs)} · 日志 ${size} · ${quiet}`);
      if (job.progress) console.log(`      进度 ${progressBar(job.progress)}`);
      if (job.lastLine) console.log(`      末行：${job.lastLine}`);
    }
    return 0;
  }

  if (cmd === "list") {
    const items = loadItems().filter((item) => flag("all") || !item.closed);
    const live = loadLive();
    if (live.jobs.length > 0) {
      console.log("── 在跑 ──");
      console.log(renderRunning(live, 10).split("\n").map((line) => `  ${line}`).join("\n"));
      console.log("");
    }
    if (items.length === 0) {
      console.log("没有未关闭的工作项。");
      return 0;
    }
    console.log("── 等你处理 ──");
    for (const item of items) console.log(`${formatItem(item)}\n`);
    return 0;
  }

  if (cmd === "show") {
    const item = loadItems().find((entry) => entry.id === rest[0]);
    if (!item) {
      // 也可能是作业 id：允许直接看它在不在跑
      const live = loadLive().jobs.find((job) => job.id === rest[0]);
      if (live) {
        console.log(`在跑：${live.id} · 已跑 ${humanMs(live.elapsedMs)} · 日志 ${(live.bytes / 1024).toFixed(1)}KB`);
        if (live.lastLine) console.log(`末行：${live.lastLine}`);
        return 0;
      }
      console.error(`没有 ${rest[0]}`);
      return 1;
    }
    console.log(formatItem(item));
    console.log(`    证据: ${JSON.stringify(item.evidence ?? {})}`);
    return 0;
  }

  if (cmd === "close") {
    const item = loadItems().find((entry) => entry.id === rest[0]);
    if (!item) {
      console.error(`没有 ${rest[0]}`);
      return 1;
    }
    append({ op: "close", id: item.id, note: flag("note") || "" });
    console.log(`已关闭 ${item.id}`);
    return 0;
  }

  console.log(`用法: node work.mjs <watch|live|list|show|close> [参数]
  watch [--interval 60] [--once]   扫一轮：写工作项 + 刷新在跑快照
  live                             看现在有哪些在跑（含是否卡住）
  list [--all]                     在跑 + 等你处理的
  show <id|作业id>
  close <id> [--note "..."]`);
  return cmd ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
