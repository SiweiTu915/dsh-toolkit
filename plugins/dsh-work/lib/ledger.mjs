/**
 * ledger.mjs —— 工作项台账（追加式事件日志）。
 *
 * 设计要点（都是踩过的坑换来的）：
 *   · **追加式**：只 append 事件（add / close / judge），不原地改。写坏最多坏最后一行，
 *     折叠时跳过坏行即可 —— 台账不能因为一次写失败就整个失效。
 *   · **文件为真相**：`$DSH_HOME/workitems.jsonl`，任何工具/脚本都能读，不依赖进程状态。
 *   · **判断分两层**：规则（advise）先给一个可复现的结论；模型（judge）再补"说明了什么/
 *     下一步"。规则不烧钱、不会编，模型只负责它擅长的部分。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 台账文件位置（可用 DSH_WORK_LEDGER 覆盖，便于测试）。 */
export function ledgerPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return process.env.DSH_WORK_LEDGER ?? join(home, "workitems.jsonl");
}

/** 追加一条事件。 */
export function append(event) {
  const file = ledgerPath();
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), ...event });
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
  return event.id;
}

/**
 * 折叠事件流成当前视图。
 * @param text - 台账文件内容。
 * @returns 工作项数组（保持首次出现的顺序）。
 */
export function fold(text) {
  const items = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 坏行跳过，不让台账陪葬
    }
    if (event.op === "add") {
      items.set(event.id, { ...event, closed: false });
    } else if (event.op === "close" && items.has(event.id)) {
      items.set(event.id, { ...items.get(event.id), closed: true, closedAt: event.t, note: event.note });
    } else if (event.op === "judge" && items.has(event.id)) {
      items.set(event.id, { ...items.get(event.id), judgment: event.text, judgedAt: event.t });
    }
  }
  return [...items.values()];
}

/** 读全部工作项。 */
export function loadItems() {
  const file = ledgerPath();
  return fold(existsSync(file) ? readFileSync(file, "utf8") : "");
}

/** 未关闭且**在等人**的工作项。 */
export function pendingItems() {
  return loadItems().filter((item) => !item.closed && String(item.state ?? "").startsWith("person/"));
}

/** 人类可读的耗时。 */
export function durationText(started, finished) {
  const a = Date.parse(started ?? "");
  const b = Date.parse(finished ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return "";
  const min = Math.round((b - a) / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`;
}

/**
 * 规则层判断：给一条结束的作业写「摘要 + 该不该继续」。
 *
 * 坚持用规则而不是模型：可复现、零成本、不会编。拿不准的（"跑完了但指标没在日志里"）
 * 留给人或留给模型层 —— 规则只做它能确定的那部分。
 *
 * @param job - { id, state, exit, started, finished, logTail }
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

/** 渲染成给人看的多行文本。 */
export function formatItem(item) {
  const head = `${item.closed ? "✓已关闭" : "•"} ${item.id}  [${item.state}]  等:${item.waiting}`;
  const lines = [head, `    ${item.summary}`];
  if (item.advice) lines.push(...item.advice.split("\n").map((line) => `    → ${line}`));
  if (item.judgment) lines.push(...String(item.judgment).split("\n").map((line) => `    ★ ${line}`));
  if (item.note) lines.push(`    备注: ${item.note}`);
  return lines.join("\n");
}
