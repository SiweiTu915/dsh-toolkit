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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 台账文件位置（可用 DSH_WORK_LEDGER 覆盖，便于测试）。 */
export function ledgerPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return process.env.DSH_WORK_LEDGER ?? join(home, "workitems.jsonl");
}

/**
 * 当前实例的归属名。
 *
 * 为什么需要：台账文件是**一份**（只有一个 launchd 在写），但主 GUI、各个工作台
 * 实例（`sim-homes/<name>`）读的是同一份 —— 不隔离就会出现「别人的工作台也能看到
 * 我的工作项」。所以每条记录带 `instance`，读的时候按自己的归属过滤：
 *   · 自己实例的
 *   · 标成 `global` 的（真的全局事项）
 *   · 早期没带归属的（视为 global，兼容老数据）
 *
 * 归属名来源：显式 `DSH_WORK_INSTANCE` > `DSH_HOME` 里 `sim-homes/<name>` 的 <name> > `main`。
 * @returns 实例名
 */
export function instanceName() {
  const explicit = process.env.DSH_WORK_INSTANCE;
  if (explicit) return explicit;
  const home = (process.env.DSH_HOME ?? join(homedir(), ".dsh")).replace(/\/+$/u, "");
  const hit = /\/sim-homes\/([^/]+)$/u.exec(home);
  return hit ? hit[1] : "main";
}

/**
 * 一条记录归谁。
 * @returns 归属名（缺省或显式 global 都算 global）
 */
export function ownerOf(item) {
  const owner = String(item?.instance ?? "").trim();
  return owner === "" ? "global" : owner;
}

/** 这条记录对当前实例可见吗。 */
export function visibleTo(item, instance = instanceName()) {
  const owner = ownerOf(item);
  return owner === "global" || owner === instance;
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
export function loadItems({ instance } = {}) {
  const file = ledgerPath();
  const all = fold(existsSync(file) ? readFileSync(file, "utf8") : "");
  if (instance === undefined) return all; // 显式要全部（面板调试/迁移用）
  return all.filter((item) => visibleTo(item, instance));
}

/** 未关闭且**在等人**的工作项。 */
export function pendingItems({ instance } = {}) {
  return loadItems({ instance }).filter(
    (item) => !item.closed && String(item.state ?? "").startsWith("person/"),
  );
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
  // 兜底：既不是 done 也不是 fail，但**已经结束**（典型是被 stop 掉、或进程被
  // 外部杀掉），所以没有退出码。以前这里落到 working 分支，会写出
  // 「仍在运行」这种自相矛盾的话 —— 它是"结束了但不知道为什么结束"。
  if (job.state !== "running") {
    return {
      state: "person/决策",
      waiting: "你",
      summary: `作业 ${job.id} 结束了，但没有记录退出码（可能被停止或异常退出${dur ? `，耗时 ${dur}` : ""}）；末行：${lastLine.slice(0, 120) || "(空)"}`,
      advice: [
        "先看日志末尾判断是被谁停的、停在哪一步。",
        "如果是你手动 stop 的：确认还要不要重跑，别让它悬着。",
        "如果是它自己没的：按失败处理，看日志最后 20 行。",
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

/* ------------------------------- 在跑视图 ------------------------------- */

/**
 * 在跑任务的快照文件。
 *
 * 为什么要单独一份：台账记的是「已经结束、等人处理」的事；而「还在跑」是
 * **每 60 秒都在变**的活数据，写进台账会把它灌满事件。分开存，读的时候合并。
 */
export function livePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return process.env.DSH_WORK_LIVE ?? join(home, "work-live.json");
}

/** 读在跑快照（没有就返回空壳）。 */
export function loadLive({ instance } = {}) {
  const file = livePath();
  if (!existsSync(file)) return { checkedAt: null, jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return {
      checkedAt: parsed.checkedAt ?? null,
      jobs: instance === undefined ? jobs : jobs.filter((job) => visibleTo(job, instance)),
    };
  } catch {
    return { checkedAt: null, jobs: [] };
  }
}

/**
 * 用本轮扫描结果更新在跑快照，并算出「多久没有新输出」。
 *
 * 卡住判定：进程还活着，但日志字节数 **超过阈值时间没变**。
 * 这是最便宜、又最能抓住「跑了两小时其实早挂了」的信号 —— 不依赖 GPU 指标
 * （那台机可能是无卡开机），也不依赖模型判断。
 *
 * @param running - 本轮看到的在跑作业 [{ id, started, bytes, lastLine, finished? }]
 * @param now - 当前时间戳（毫秒，测试可注入）
 * @param stallMs - 多久无新输出算卡住
 * @returns 新的快照对象
 */
export function updateLive(running, now = Date.now(), stallMs = 10 * 60 * 1000) {
  const prev = new Map(loadLive({ instance: undefined }).jobs.map((job) => [job.id, job]));
  const jobs = running.map((job) => {
    const before = prev.get(job.id);
    const bytes = Number(job.bytes) || 0;
    // 字节数变了 = 有新输出；首次见到就记成现在（不给它凭空算出一个"已停滞"
    const changed = before === undefined || before.bytes !== bytes;
    const lastChangeAt = changed ? now : (before.lastChangeAt ?? now);
    const startedMs = Date.parse(job.started ?? "");
    return {
      id: job.id,
      instance: job.instance ?? "global",
      state: "running",
      started: job.started ?? null,
      elapsedMs: Number.isFinite(startedMs) ? now - startedMs : null,
      bytes,
      lastChangeAt,
      quietMs: now - lastChangeAt,
      stalled: now - lastChangeAt > stallMs,
      lastLine: String(job.lastLine ?? job.logTail ?? "").slice(0, 160),
      progress: parseProgress(job.logTail ?? ""),
    };
  });
  return { checkedAt: new Date(now).toISOString(), jobs };
}

/** 把快照写盘（原子写：tmp + rename，别让读者看到半个文件）。 */
export function saveLive(snapshot) {
  const file = livePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  renameSync(tmp, file);
}

/** 人类可读的时长。 */
export function humanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const min = Math.round(ms / 60000);
  if (min < 1) return "<1m";
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`;
}

/**
 * 把在跑任务渲染成**给模型看**的一行行文本（模型和人看到的是同一份数据）。
 * @param snapshot - loadLive/updateLive 的结果。
 * @param limit - 最多几行。
 */
export function renderRunning(snapshot, limit = 4) {
  const jobs = (snapshot?.jobs ?? []).slice(0, limit);
  if (jobs.length === 0) return "";
  return jobs.map((job) => {
    const parts = [
      `在跑 ${humanMs(job.elapsedMs)}`,
      job.id,
      job.bytes < 1024 ? `日志 ${job.bytes}B` : `日志 ${(job.bytes / 1024).toFixed(job.bytes > 102400 ? 0 : 1)}KB`,
    ];
    if (job.progress) parts.push(progressBar(job.progress));
    if (job.stalled) parts.push(`⚠ ${humanMs(job.quietMs)} 无新输出，疑似卡住`);
    else if (job.quietMs > 60000) parts.push(`${humanMs(job.quietMs)} 无新输出`);
    if (job.lastLine) parts.push(`末行：${job.lastLine}`);
    return `- ${parts.join(" · ")}`;
  }).join("\n");
}

/* ------------------------------- 进度解析 ------------------------------- */

/**
 * 从日志尾部猜进度。
 *
 * 为什么只能"猜":通用 shell 作业没有结构化进度,能有百分比的前提是**作业自己
 * 报了总量**。所以认这几种常见写法(不猜格式、只认明确的 `x/y`):
 *   · `epoch 17/30` / `Epoch 17/30`      —— 训练循环最常见
 *   · `PROGRESS 17/30` / `progress=17/30` —— 显式约定,推荐用这个
 *   · `[17/30]` / `step 17/30`           —— tqdm 风格
 * 都匹配不到就返回 undefined —— **绝不编一个假进度**。
 *
 * @param logText - 日志文本(取尾部即可)。
 * @returns {{ done: number, total: number, pct: number, label: string } | undefined}
 */
export function parseProgress(logText) {
  const text = String(logText ?? "");
  const patterns = [
    /PROGRESS[\s:=]+(\d+)\s*\/\s*(\d+)/iu,
    /epoch[\s:=]+(\d+)\s*\/\s*(\d+)/iu,
    /step[\s:=]+(\d+)\s*\/\s*(\d+)/iu,
    /\[(\d+)\s*\/\s*(\d+)\]/u,
  ];
  // 从**后往前**找:最新的进度才有意义(日志前面可能还是 1/30)
  const lines = text.split("\n").filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    for (const pattern of patterns) {
      const hit = pattern.exec(lines[i]);
      if (!hit) continue;
      const done = Number(hit[1]);
      const total = Number(hit[2]);
      if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done > total) continue;
      return { done, total, pct: Math.round((done / total) * 100), label: lines[i].trim().slice(0, 100) };
    }
  }
  return undefined;
}

/** 画一个纯文本进度条(给终端/提示注入用,不依赖 UI)。 */
export function progressBar(progress, width = 12) {
  if (!progress) return "";
  const filled = Math.max(0, Math.min(width, Math.round((progress.pct / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${progress.done}/${progress.total} (${progress.pct}%)`;
}
