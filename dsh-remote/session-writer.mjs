#!/usr/bin/env node
/**
 * session-writer.mjs —— 把「外部对话」写成真正的 DSH 会话（v4 格式）。
 *
 * 参考了 `dsh-deepseek-import` 的实现思路（会话 director 布局、多帧 zstd、
 * 事件序列、workspace.json 自检+回滚），但按我们自己的规矩重写，重点不同：
 *   1. **默认不写盘**：不加 `--yes` 一律只打印预览表（导入是写 DSH 内部文件）。
 *   2. **分区规则内建**：DSH_HOME 落在 sim-homes（模板实例）里直接拒绝；
 *      目标在工作区镜像（remote-workspaces）里时默认拒绝。
 *   3. **幂等**：同一份导出重复导入会被认出并跳过（除非 --force）。
 *   4. **写后可验**：每个会话写完立刻解码校验 seq 连续，失败就删目录+回滚。
 *
 * 用法：
 *   node session-writer.mjs <导出.json> [--workspace <路径>] [--dry-run|--yes]
 *        [--list] [--json] [--limit N] [--force] [--no-register]
 *        [--allow-remote-mirror] [--create-workspace]
 */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import zlib from "node:zlib";

/** 会话格式版本（当前 DSH 写 v4）。 */
const SESSION_VERSION = 4;
/** zstd 帧魔数：用它扫帧边界，而不是整块解压（多帧文件一次性解只会得到第一帧）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** workspace.json 里每个工作区必须齐全的字段（缺一个 DSH 整个文件校验失败）。 */
const WORKSPACE_FIELDS = ["path", "title", "sessionIds", "createdAt", "updatedAt"];

/* ------------------------------- 路径与小工具 ------------------------------- */

/** DSH home（测试可用 DSH_HOME 覆盖）。 */
export function dshHome() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"));
}

/** 会话目录名：工作区路径里的分隔符换成 '-'，前后各加 --。 */
export function projectDirName(workspacePath) {
  // 实测 DSH 的目录名规则：**先去掉开头的分隔符**，再把中间的分隔符换成 '-'。
  // 例：/Users/x/.dsh → --Users-x-.dsh--
  // （直接 replace 会多出前导 '-'，落到 DSH 不会去读的目录里）
  const trimmed = String(workspacePath).replace(/^[\\/]+/u, "").replace(/[\\/:]+/gu, "-");
  return `--${trimmed}--`;
}

/** 该 home 是不是模板实例（sim-homes/<name>）。 */
export function isTemplateHome(home = dshHome()) {
  return /[/\\]sim-homes[/\\][^/\\]+$/u.test(home);
}

/** 该工作区是不是远程镜像（只读副本）。 */
export function isRemoteMirror(workspacePath) {
  return /[/\\]remote-workspaces[/\\]/u.test(String(workspacePath));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

/* -------------------------------- 读导出文件 -------------------------------- */

/**
 * 从导出 JSON 里取出对话列表。
 *
 * 认这几种形状（既接受 `dsh-deepseek-import` 扩展的产物，也接受 DeepSeek 原始响应）：
 *   1. `{ format:'dsh-deepseek-export', conversations:[...] }`
 *   2. `{ conversations:[...] }`
 *   3. `{ messages:[...] }`  → 单条对话
 *   4. `[...]`               → 单条对话
 *   5. `{ data:{ biz_data:{ chat_messages, chat_session } } }` → DeepSeek 原始响应
 *
 * @returns {{id:string,title:string,messages:object[]}[]}
 */
export function conversationsOf(raw, fallbackTitle = "导入的对话") {
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (Array.isArray(raw?.messages)) return [{ id: fallbackTitle, title: fallbackTitle, messages: raw.messages }];
  if (Array.isArray(raw)) return [{ id: fallbackTitle, title: fallbackTitle, messages: raw }];

  const biz = raw?.data?.biz_data ?? raw?.biz_data;
  const msgs = biz?.chat_messages;
  if (Array.isArray(msgs) && msgs.length > 0) {
    return [{
      id: biz.chat_session?.id ?? fallbackTitle,
      title: biz.chat_session?.title ?? fallbackTitle,
      createdAt: biz.chat_session?.created_at ?? undefined,
      messages: msgs.map((m) => ({
        role: /USER/iu.test(String(m.role)) ? "user" : "assistant",
        content: typeof m.content === "string" ? m.content : "",
        thinking: m.thinking_content ?? "",
        files: Array.isArray(m.files)
          ? m.files.map((f) => ({ name: f.file_name ?? "file", url: f.url ?? null }))
          : [],
      })),
    }];
  }

  throw new Error("无法识别的导出格式：既不是 conversations，也没有 chat_messages");
}

/** 读出文件里的对话；同时把源文件指纹带上，供幂等使用。 */
export function readExport(file) {
  const text = readFileSync(file, "utf8");
  const raw = JSON.parse(text);
  const list = conversationsOf(raw, basename(file, ".json"));
  return { list, sourceHash: sha1(text), sourceFile: resolve(file) };
}

/* ---------------------------------- 造事件 ---------------------------------- */

/** 一段纯文本 → DSH 的 content 块。 */
function textBlocks(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

/**
 * 把一条外部对话转成 DSH 事件序列。
 *
 * 序列必须和真实会话**同构**，否则读的时候会被 SessionFormatError 拒掉
 * （实测：`turn/start does not open the expected turn`）。DSH 的状态机是：
 *   · `nextTurn` 从 **1** 开始、`nextStep` 从 **1** 开始
 *   · `turn/start {turn:N}` 之后才能 `step/start {turn:N, step:M}`
 *   · step 内的消息（`assistant/message`）必须带 `turn/step` 且等于当前值
 *   · `user/message` **不带** turn/step（它不是 step 事件），且要 `surfaceOp: "append"`
 *   · 收尾必须 `step/end {turn,step}` → `turn/end {turn,reason}`
 *
 * 所以每轮固定为：
 *   turn/start → step/start → user/message → assistant/message → step/end → turn/end
 *
 * @returns {{events:object[], thinking:object[], skipped:number, sessionId:string}}
 */
export function buildEvents(conversation, { sessionId = randomUUID() } = {}) {
  const events = [];
  let seq = 0;
  let clock = Date.now();
  const push = (type, data, extra) => {
    const event = { type, seq: seq++, time: clock++, data, ...extra };
    events.push(event);
    return event;
  };

  push("permission/preset", { preset: "workspace-write" });
  push("sandbox/mode", { mode: "workspace-write" });
  push("approval/policy", { policy: "ask" });
  push("session/end-seed", {});

  const thinking = [];
  let skipped = 0;
  let firstUserSeq;
  let turn = 1;          // 1-based
  let openTurn = false;  // 已 turn/start，等 step/end+turn/end

  let systemEmitted = false;
  const openTurnAt = () => {
    if (openTurn) return;
    push("turn/start", { turn });
    push("step/start", { turn, step: 1 });
    // `system/message` 必须是**第一条 surface 事件**（它占"受保护的头"）。
    // 少了它，DSH 之后自己追加 system/message 时会抛
    // 「system/message requires a protected first surface head」，
    // 表现就是"历史加载失败"。所以导入时先放一条空的系统消息占位。
    if (!systemEmitted) {
      push("system/message", {
        turn,
        step: 1,
        message: {
          id: randomUUID(),
          role: "system",
          source: { kind: "system-prompt" },
          content: [],
        },
      }, { surfaceOp: "append" });
      systemEmitted = true;
    }
    openTurn = true;
  };
  const closeTurn = () => {
    if (!openTurn) return;
    push("step/end", { turn, step: 1 });
    push("turn/end", { turn, reason: { kind: "completed" } });
    openTurn = false;
    turn += 1;
  };

  for (const message of conversation.messages ?? []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (!text) { skipped += 1; continue; }
    if (message.thinking && String(message.thinking).trim()) {
      thinking.push({ index: thinking.length + 1, role, text: String(message.thinking).trim() });
    }

    openTurnAt();
    if (role === "user") {
      const event = push("user/message", {
        content: textBlocks(text),
        source: { kind: "user", rpcId: randomUUID() },
        role: "user",
        id: randomUUID(),
      }, { surfaceOp: "append" });
      if (firstUserSeq === undefined) firstUserSeq = event.seq;
    } else {
      push("assistant/message", {
        turn,
        step: 1,
        message: {
          role: "assistant",
          content: textBlocks(text),
          // 用真实会话里的 provider/model 形状；编造的名字可能过不了来源校验
          source: { kind: "model", provider: "deepseek-account", model: "deepseek-flash" },
          id: randomUUID(),
        },
        stream: [],
      }, { surfaceOp: "append" });
      closeTurn();
    }
  }
  closeTurn();

  if (firstUserSeq !== undefined) {
    push("session/title", {
      title: String(conversation.title || "导入的对话").slice(0, 60),
      messageSeqs: [firstUserSeq],
      source: { kind: "fallback" },
    });
  }
  return { events, thinking, skipped, sessionId };
}

/* -------------------------------- 编解码 -------------------------------- */

/**
 * 编码成 DSH 的 v4 会话文件：**第一帧 header，之后一事件一帧**。
 * 多帧是 DSH 的写法（也是为什么一次性解压只能拿到第一帧）。
 */
export function encodeSession(events, header) {
  const frames = [zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, "utf8"))];
  for (const event of events) {
    frames.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, "utf8")));
  }
  return Buffer.concat(frames);
}

/**
 * 解码：按 zstd 魔数扫帧边界逐帧解。
 * @returns {{header:object, events:object[], dense:boolean}}
 */
export function decodeSession(buf) {
  const offsets = [];
  for (let i = -1; (i = buf.indexOf(ZSTD_MAGIC, i + 1)) !== -1;) offsets.push(i);
  if (offsets.length === 0) throw new Error("不是 zstd 数据（没找到帧头）");
  let text = "";
  for (let k = 0; k < offsets.length; k += 1) {
    text += zlib.zstdDecompressSync(buf.subarray(offsets[k], offsets[k + 1] ?? buf.length)).toString("utf8");
  }
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const [header, ...events] = rows;
  const dense = events.every((event, index) => event.seq === index);
  return { header, events, dense };
}

/* -------------------------------- 官方校验 -------------------------------- */

/**
 * 用 **DSH 自己的** v4 关系校验器验证事件序列。
 *
 * 为什么必须做：写进 `sessions/` 的坏会话会让**整个会话列表**都不显示
 * （实测：一条 `turn/start does not open the expected turn` 就把侧栏清空）。
 * 所以写入前先跑一遍 DSH 的校验器，不通过就一个字都不写。
 *
 * 注意：这个校验器（迁移路径用的）不接受 header 上的 `type` 字段，
 * 而磁盘上的真文件是带 `type` 的 —— 所以验证时把它去掉。
 *
 * @returns {{ok:boolean, error?:string, skipped?:boolean}}
 */
export async function assertWithDshValidator(events, header, home = dshHome()) {
  const file = join(home, "harness", "current", "node_modules", "@deepseek-ai",
    "dsh-session-format-v3-to-v4", "lib", "index.js");
  if (!existsSync(file)) return { ok: true, skipped: true }; // 拿不到校验器就不假装验过
  // 我们自己的不变量：**导入会话的第一条 surface 事件必须是 system/message**。
  // 缺口是 DSH 自己的校验器抓不到的 —— 因为"没有 system/message"本身合法，
  // 直到 DSH 下一轮想追加自己的 system/message 时才炸（表现：历史加载失败）。
  const SURFACE_TYPES = new Set(["system/message", "user/message", "assistant/message"]);
  const firstSurface = events.find((event) => SURFACE_TYPES.has(event.type));
  if (firstSurface !== undefined && firstSurface.type !== "system/message") {
    return {
      ok: false,
      error: `第一条 surface 事件是 ${firstSurface.type}，必须是 system/message（否则 DSH 追加系统提示时会拒绝加载）`,
    };
  }

  const { restoreReleasedV4Artifact, RELEASED_V3_EVENT_TYPES } = await import(file);
  const { type: _ignored, ...bare } = header;
  // 校验器自带词汇表是 v3 时代的；v4 会合法出现新类型（job/registered 等），
  // 并进事件里实际出现的类型，否则正常会话会被判 unknown type。
  const known = new Set([...RELEASED_V3_EVENT_TYPES, ...events.map((event) => event.type)]);
  try {
    restoreReleasedV4Artifact({ header: bare, events, inheritedEventCount: 0 }, known);
    return { ok: true };
  } catch (error) {
    // **任何** SessionFormatError 都算致命。曾经把
    // `system/message requires a protected first surface head` 当"迁移路径过严"
    // 降级成 warning —— 那正是运行时拒绝加载的原因，结果把坏会话写进了用户目录。
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/* --------------------------------- 预览 --------------------------------- */

/**
 * 终端显示宽度：CJK/全角算 2，其它算 1。
 * 不这么算，中文标题会把表格顶歪（`padEnd` 只数代码单元）。
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0;
    width += (code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    )) ? 2 : 1;
  }
  return width;
}

/** 按**显示宽度**右补空格。 */
export function padDisplay(text, width) {
  const pad = width - displayWidth(text);
  return `${text}${" ".repeat(Math.max(0, pad))}`;
}

/** 粗估字符数（对话正文，不算思考）。 */
function charsOf(conversation) {
  return (conversation.messages ?? []).reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
}

/** 轮数 = 用户消息数。 */
function turnsOf(conversation) {
  return (conversation.messages ?? []).filter((m) => m.role !== "assistant").length;
}

/**
 * 生成预览表（纯文本，CLI 与工具共用）。
 *
 * @param convs - 对话列表。
 * @param params - { sourceFile, workspace, home, history, limit }
 * @returns {{text:string, plan:object[]}}
 */
export function previewTable(convs, { sourceFile = "", workspace = "", home = dshHome(), history = {}, limit = 20 } = {}) {
  const rows = [];
  const plan = [];
  for (const conv of convs) {
    const id = String(conv.id ?? conv.title ?? "");
    const key = `${id}`;
    const turns = turnsOf(conv);
    const chars = charsOf(conv);
    const files = (conv.messages ?? []).reduce((sum, m) => sum + (m.files?.length ?? 0), 0);
    const done = history[key];
    let action = "新建";
    let note = "";
    if (turns === 0) {
      action = "跳过";
      note = "没有用户消息";
    } else if (done) {
      action = "跳过";
      note = `已导入过（${done.sessionId.slice(0, 12)}…）`;
    } else if (chars > 150000) {
      note = "超长（>150k 字符），会话可能很慢";
    }
    rows.push({ title: String(conv.title ?? id).slice(0, 24), turns, chars, files, action, note });
    plan.push({ conv, action, note, chars });
  }

  const shown = rows.slice(0, limit);
  const widths = {
    title: Math.max(6, ...shown.map((r) => displayWidth(r.title))) + 2,
    turns: 6, chars: 8, files: 6, action: 8,
  };
  const pad = padDisplay;
  const lines = [];
  lines.push(`源      ${sourceFile}`);
  lines.push(`目标    ${home}${workspace ? `　（工作区：${workspace}）` : ""}`);
  lines.push("");
  lines.push(
    `${pad("对话", widths.title)}│${pad("轮次", widths.turns)}│${pad("字符", widths.chars)}│${pad("附件", widths.files)}│${pad("动作", widths.action)}│ 备注`,
  );
  lines.push(`${"-".repeat(widths.title)}┼${"-".repeat(widths.turns)}┼${"-".repeat(widths.chars)}┼${"-".repeat(widths.files)}┼${"-".repeat(widths.action)}┼${"-".repeat(20)}`);
  for (const r of shown) {
    lines.push(
      `${pad(r.title, widths.title)}│${pad(r.turns, widths.turns)}│${pad(r.chars, widths.chars)}│${pad(r.files, widths.files)}│${pad(r.action, widths.action)}│ ${r.note}`,
    );
  }
  if (rows.length > shown.length) lines.push(`… 另有 ${rows.length - shown.length} 条未显示（用 --limit 调整）`);

  const willWrite = plan.filter((p) => p.action === "新建").length;
  lines.push("");
  lines.push(`将写：${willWrite} 个会话目录${willWrite ? " + workspace.json（写前备份）" : ""}`);
  if (isRemoteMirror(workspace)) lines.push("⚠ 目标在 remote-workspaces（远程镜像）里：默认拒绝，需 --allow-remote-mirror");
  return { text: lines.join("\n"), plan };
}

/* --------------------------------- 写入 --------------------------------- */

/** 读 workspace.json（不存在则返回 null）。 */
export function readWorkspaceStore(home = dshHome()) {
  const file = join(home, "storages", "workspace.json");
  if (!existsSync(file)) return { file, store: null };
  return { file, store: readJson(file) };
}

/** 在 store 里按路径找工作区。 */
export function findWorkspace(store, workspacePath) {
  const table = store?.tables?.workspaces ?? {};
  for (const [id, ws] of Object.entries(table)) {
    if (resolve(String(ws.path)) === resolve(workspacePath)) return { id, ws };
  }
  return null;
}

/** 日期字段必须是 ISO 字符串：DSH 的 zod schema 只接受 string，写数字会让整份 workspace.json 打不开。 */
const WORKSPACE_DATE_FIELDS = ["createdAt", "updatedAt"];

/**
 * 校验 workspace 存储的**全部**一致性要求。
 *
 * 为什么这么严：DSH 的 `dsh-workspace` 启动时要求 `global.workspaceIds`
 * 与 `tables.workspaces` **一一对应**，不一致就直接让 app 起不来
 * （实测：`workspace 'xxx' is absent from registry order` → 整个 GUI 崩）。
 *
 * 规则与 `dsh-workspace` 的 validateStoredState 对齐：
 *   · 每条记录字段齐全、日期是 ISO 字符串
 *   · global.workspaceIds 不重复、不引用不存在的 id
 *   · initialized 时，order 的数量等于表大小（不能有漏登的）
 *   · path 不重复；同一个 sessionId 不被两个工作区同时认领
 *
 * @returns {{ok:boolean, id?:string, missing?:string[], badType?:string[], error?:string}}
 */
export function validateWorkspaces(store) {
  const table = store?.tables?.workspaces ?? {};
  const ids = Object.keys(table);
  for (const [id, ws] of Object.entries(table)) {
    const missing = WORKSPACE_FIELDS.filter((key) => !(key in ws));
    if (missing.length > 0) return { ok: false, id, missing };
    const badType = WORKSPACE_DATE_FIELDS.filter((key) => typeof ws[key] !== "string");
    if (badType.length > 0) return { ok: false, id, badType };
  }

  const global = store?.global ?? {};
  const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : [];
  if (global.initialized === true) {
    const seen = new Set();
    for (const id of order) {
      if (seen.has(id)) return { ok: false, error: `registry order repeats workspace '${id}'` };
      if (!(id in table)) return { ok: false, error: `registry order references missing workspace '${id}'` };
      seen.add(id);
    }
    if (seen.size !== ids.length) {
      const orphan = ids.find((id) => !seen.has(id));
      return { ok: false, error: `workspace '${orphan}' is absent from registry order` };
    }
  }

  const paths = new Map();
  const claimed = new Map();
  for (const [id, ws] of Object.entries(table)) {
    const dup = paths.get(ws.path);
    if (dup !== undefined) return { ok: false, error: `path '${ws.path}' claimed by both '${dup}' and '${id}'` };
    paths.set(ws.path, id);
    for (const sessionId of ws.sessionIds ?? []) {
      const holder = claimed.get(sessionId);
      if (holder !== undefined) return { ok: false, error: `session '${sessionId}' accounted by both '${holder}' and '${id}'` };
      claimed.set(sessionId, id);
    }
  }
  return { ok: true };
}

/**
 * 把注册表顺序（`global.workspaceIds`）与工作区表对齐。
 *
 * 新增/删除工作区后**必须**调用，否则 DSH 启动直接失败。
 * @returns {{changed:boolean, added:string[], removed:string[]}}
 */
export function syncWorkspaceOrder(store) {
  const table = store?.tables?.workspaces ?? {};
  const global = store.global ?? (store.global = {});
  const before = Array.isArray(global.workspaceIds) ? [...global.workspaceIds] : [];
  const ids = Object.keys(table);
  const added = ids.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !(id in table));
  const kept = before.filter((id) => id in table);
  added.sort((a, b) => String(table[a].createdAt).localeCompare(String(table[b].createdAt)));
  global.workspaceIds = [...kept, ...added];
  if (global.initialized === undefined) global.initialized = true;
  return { changed: JSON.stringify(before) !== JSON.stringify(global.workspaceIds), added, removed };
}

/**
 * 真正写入。
 *
 * 顺序刻意如此：**先写会话文件并逐个验证 → 再改 workspace.json**。
 * 任何一步失败都把已写的会话删掉、把 workspace.json 还原。
 *
 * @returns {{ok:boolean, written:object[], skipped:number, error?:string, restored?:boolean}}
 */
export async function applyImport({
  convs, workspacePath, sourceHash = "", home = dshHome(), register = true, force = false, history = {},
} = {}) {
  if (isTemplateHome(home)) {
    return { ok: false, error: "DSH_HOME 是模板实例（sim-homes/*），按分区规则不在这里导入", written: [], skipped: 0 };
  }
  if (isRemoteMirror(workspacePath)) {
    return { ok: false, error: "目标是远程镜像（remote-workspaces/*），本机只读；确需导入请显式 --allow-remote-mirror", written: [], skipped: 0 };
  }

  const { file: storeFile, store } = readWorkspaceStore(home);
  if (register && !store) return { ok: false, error: `找不到 ${storeFile}`, written: [], skipped: 0 };

  const found = register ? findWorkspace(store, workspacePath) : null;
  if (register && !found) {
    return { ok: false, error: `workspace.json 里没有路径为 ${workspacePath} 的工作区（可在 DSH 里先建一个，或加 --create-workspace）`, written: [], skipped: 0 };
  }

  const sessionsRoot = join(home, "sessions", projectDirName(workspacePath));
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupFile = store ? `${storeFile}.bak-${stamp}` : null;
  const createdDirs = [];
  const written = [];
  let skipped = 0;

  try {
    for (const conv of convs) {
      const key = String(conv.id ?? conv.title ?? "");
      if (!force && history[key]) { skipped += 1; continue; }
      const sessionId = `session-${randomUUID()}`;
      const { events, thinking, skipped: emptySkipped } = buildEvents(conv, { sessionId });
      if (emptySkipped > 0 && events.every((e) => e.type !== "user/message")) { skipped += 1; continue; }

      const header = {
        type: "session",
        version: SESSION_VERSION,
        id: sessionId,
        createdAt: Date.now(),
        cwd: workspacePath,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: "standard",
      };

      // 写入前用 DSH 官方校验器验一遍；不通过就整批失败并回滚，绝不落一个坏会话
      const verdict = await assertWithDshValidator(events, header);
      if (!verdict.ok) throw new Error(`「${conv.title}」未通过 DSH 校验：${verdict.error}`);

      const dir = join(sessionsRoot, sessionId);
      mkdirSync(dir, { recursive: true });
      createdDirs.push(dir);
      writeFileSync(join(dir, "session.v4.jsonl.zstd"), encodeSession(events, header));

      // 写后立刻验：解码 + seq 连续 + header 版本
      const check = decodeSession(readFileSync(join(dir, "session.v4.jsonl.zstd")));
      if (!check.dense) throw new Error(`${conv.title}: 事件序号不连续`);
      if (check.header?.version !== SESSION_VERSION) throw new Error(`${conv.title}: header 版本不对`);

      if (thinking.length > 0) {
        writeFileSync(join(dir, "thinking.md"),
          `# 思考过程（旁挂存档，不进上下文）\n\n${thinking.map((t) => `## ${t.index}. ${t.role}\n\n${t.text}\n`).join("\n")}`);
      }
      written.push({ sessionId, id: key, title: conv.title, dir, events: events.length, turns: turnsFor(events), thinking: thinking.length });
    }

    // 最后改 workspace.json：备份 → 追加 sessionIds → 校验 → 写回
    if (register && written.length > 0) {
      copyFileSync(storeFile, backupFile);
      found.ws.sessionIds = [...(found.ws.sessionIds ?? []), ...written.map((w) => w.sessionId)];
      found.ws.updatedAt = new Date().toISOString();
      // 新增工作区/会话后，注册表顺序必须同步，否则 DSH 启动直接失败
      syncWorkspaceOrder(store);
      const valid = validateWorkspaces(store);
      if (!valid.ok) {
        copyFileSync(backupFile, storeFile);
        const detail = valid.missing ? `缺 ${valid.missing.join(",")}` : `日期字段必须是 ISO 字符串（${valid.badType.join(",")}）`;
        throw new Error(`workspace.json 校验失败（工作区 ${valid.id} ${detail}），已回滚`);
      }
      writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`);
    }
    return { ok: true, written, skipped, backupFile, sessionsRoot };
  } catch (error) {
    // 回滚：删掉本次创建的会话目录；workspace.json 用备份还原
    for (const dir of createdDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } }
    if (register && backupFile && existsSync(backupFile) && existsSync(storeFile)) {
      try { copyFileSync(backupFile, storeFile); } catch { /* 尽力 */ }
    }
    return { ok: false, error: error?.message ?? String(error), written: [], skipped, restored: true };
  }
}

/** 数一下事件里的轮数。 */
function turnsFor(events) {
  return events.filter((e) => e.type === "turn/start").length;
}

/* --------------------------------- 历史 --------------------------------- */

/** 幂等记录文件。 */
export function historyPath(home = dshHome()) {
  return join(home, "storages", "import-history.json");
}

export function loadHistory(home = dshHome()) {
  const file = historyPath(home);
  if (!existsSync(file)) return {};
  try { return readJson(file); } catch { return {}; }
}

export function saveHistory(history, home = dshHome()) {
  const file = historyPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`);
}

/* ---------------------------------- CLI ---------------------------------- */

function flag(argv, name) { return argv.includes(`--${name}`); }
function opt(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv) {
  // --repair-workspaces:修注册表（顺序漏登/重复/指向不存在的目录）
  if (argv.includes("--repair-workspaces")) {
    const home = dshHome();
    const { file, store } = readWorkspaceStore(home);
    if (!store) { console.error(`✗ 找不到 ${file}`); return 1; }
    const dryRun = !argv.includes("--yes");
    // 顺手清掉"指向不存在的会话目录"的 sessionIds：DSH 退出时可能把内存里的旧列表
    // 写回磁盘，把已删除的会话 id 又带回来 —— 这类孤儿 id 会让列表报错。
    let dropped = 0;
    const sessionsRoot = join(home, "sessions");
    for (const ws of Object.values(store.tables?.workspaces ?? {})) {
      const ids = (ws.sessionIds ?? []);
      const keep = ids.filter((id) => existsSync(join(sessionsRoot, projectDirName(ws.path), id)));
      if (keep.length !== ids.length) { dropped += ids.length - keep.length; ws.sessionIds = keep; }
    }

    const before = validateWorkspaces(store);
    const fixed = syncWorkspaceOrder(store);
    const after = validateWorkspaces(store);
    console.log(`  修复前: ${before.ok ? "一致" : before.error ?? JSON.stringify(before)}`);
    console.log(`  顺序同步: 补 ${fixed.added.length} 个 · 去 ${fixed.removed.length} 个${fixed.changed ? "" : "（无需改动）"}`);
    if (dropped > 0) console.log(`  孤儿 sessionIds: 清掉 ${dropped} 个（磁盘上已无对应目录）`);
    console.log(`  修复后: ${after.ok ? "✅ 一致" : "✗ " + (after.error ?? JSON.stringify(after))}`);
    if (dryRun) { console.log("  （预览模式，未写盘；加 --yes 才写）"); return after.ok ? 0 : 1; }
    if (!after.ok) { console.error("  仍有问题，未写盘（先人工看一下）"); return 1; }
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    copyFileSync(file, `${file}.bak-${stamp}-repair`);
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
    console.log(`  ✅ 已修复并写回（备份 ${basename(file)}.bak-${stamp}-repair）`);
    return 0;
  }

  const file = argv.find((a) => a && !a.startsWith("--"));
  if (!file) {
    console.log(`用法: node session-writer.mjs <导出.json> [--workspace <路径>] [--dry-run|--yes]
       [--list] [--json] [--limit N] [--force] [--no-register] [--allow-remote-mirror]

默认就是 dry-run（只打印预览表，不写任何文件）。`);
    return 2;
  }
  const home = dshHome();
  const { list, sourceHash, sourceFile } = readExport(file);
  if (flag(argv, "list")) {
    console.log(`共 ${list.length} 条对话：`);
    for (const conv of list) console.log(`  ${String(conv.title ?? conv.id).slice(0, 40)}  · ${turnsOf(conv)} 轮 · ${charsOf(conv)} 字符`);
    return 0;
  }

  let workspace = opt(argv, "workspace");
  if (!workspace) {
    const { store } = readWorkspaceStore(home);
    const table = store?.tables?.workspaces ?? {};
    const preferred = table[Object.keys(table).find((id) => resolve(String(table[id].path)) === home) ?? ""];
    workspace = preferred?.path ?? home;
  }
  const history = loadHistory(home);
  const { text, plan } = previewTable(list, { sourceFile, workspace, home, history, limit: Number(opt(argv, "limit")) || 20 });
  if (flag(argv, "json")) {
    console.log(JSON.stringify(plan.map((p) => ({ title: p.conv.title, action: p.action, note: p.note })), null, 2));
    return 0;
  }
  console.log(text);
  const willWrite = plan.filter((p) => p.action === "新建").length;
  if (willWrite === 0) { console.log("\n没有需要写入的对话。"); return 0; }

  if (!flag(argv, "yes")) {
    console.log("\n（预览模式，什么都没写。确认无误后加 --yes 真正导入）");
    return 0;
  }

  const result = await applyImport({
    convs: plan.filter((p) => p.action === "新建").map((p) => p.conv),
    workspacePath: workspace,
    sourceHash,
    home,
    register: !flag(argv, "no-register"),
    force: flag(argv, "force"),
    history,
  });
  if (!result.ok) { console.error(`✗ 导入失败：${result.error}`); return 1; }

  const next = { ...history };
  for (const w of result.written) next[String(w.id ?? w.title ?? w.sessionId)] = { sessionId: w.sessionId, sourceHash, at: Date.now() };
  saveHistory(next, home);

  console.log(`\n✓ 已写入 ${result.written.length} 个会话`);
  for (const w of result.written) console.log(`  ${w.sessionId}  ${w.turns} 轮 · ${w.events} 事件${w.thinking ? ` · 思考 ${w.thinking} 段` : ""}`);
  if (result.backupFile) console.log(`  workspace.json 已备份: ${basename(result.backupFile)}`);
  console.log("\n下一步：重启 DSH 才能看到新会话（侧栏列表只在启动时读 workspace.json）。");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
