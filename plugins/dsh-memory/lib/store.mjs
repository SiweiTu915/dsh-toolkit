/**
 * store.mjs —— memory 的纯逻辑（不依赖 cordis，可单测）。
 *
 * 设计约束（这几条决定了它的可靠性）：
 *   1. **文件是唯一真相**：Markdown、一条一行、可 grep、可手改、可 diff。
 *      工具只是入口，不是数据库。
 *   2. **每条必须带回得去的 id**：否则无法 forget/update，记忆只会不断堆积。
 *   3. **写入必须原子**：先写临时文件再 rename。半截文件比丢一条记忆更糟 ——
 *      它会让整份记忆库解析失败。
 *   4. **解析要容忍手写内容**：不符合格式的行忽略而不是抛错（用户手改是常态）。
 *
 * 存储位置：$DSH_MEMORY_DIR 或 ~/.dsh/memory/
 *   global.md          跨项目事实
 *   ws-<slug>.md       按工作区（取 cwd 的目录名做 slug）
 *
 * 条目格式（人能读、正则能解析）：
 *   - 文本内容  <!-- id:ab12cd34 · 2026-10-22 · tags:a,b -->
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** 条目行格式。tags 段可省略；id 至少 4 位十六进制；日期固定 ISO 日期。 */
export const ENTRY_RE =
  /^- (?<text>.*?) {2}<!-- id:(?<id>[0-9a-z]{4,}) · (?<date>\d{4}-\d{2}-\d{2})(?: · tags:(?<tags>\S*))? -->$/u;

/** 生成一个短 id（8 位十六进制）。 */
export function newId() {
  return randomBytes(4).toString("hex");
}

/** 今天（ISO 日期）。 */
export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * 把一个工作区目录压成 slug（用于 ws-<slug>.md）。
 * @param cwd - 绝对目录，通常取会话的工作目录。
 * @returns 稳定、可用作文件名的 slug；拿不到时返回 ""。
 */
export function slugWorkspace(cwd) {
  if (!cwd) return "";
  const cleaned = String(cwd).replace(/\/+$/u, "");
  const base = basename(cleaned) || "root";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    // 去掉前导/尾随的点与横线：否则 ~/.dsh 会生成 "ws-.dsh.md" 这种怪名字。
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 40) || "root";
}

/**
 * 解析一份记忆文件。
 * @param text - 文件内容（可以是空、可以是手写的）。
 * @returns 条目数组；无法识别的行被跳过。
 */
export function parseEntries(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.startsWith("- ")) continue;
    const m = ENTRY_RE.exec(line);
    if (!m || !m.groups) continue;
    out.push({
      id: m.groups.id,
      text: m.groups.text,
      date: m.groups.date,
      tags: m.groups.tags ? m.groups.tags.split(",").filter(Boolean) : [],
    });
  }
  return out;
}

/**
 * 渲染一条记忆为一行文本。
 * @param entry - 至少含 text；id/date 缺省时自动补。
 */
export function formatEntry(entry) {
  const id = entry.id || newId();
  const date = entry.date || today();
  const tags = entry.tags && entry.tags.length ? ` · tags:${entry.tags.join(",")}` : "";
  const text = String(entry.text ?? "").replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("memory: 条目文本不能为空");
  return `- ${text}  <!-- id:${id} · ${date}${tags} -->`;
}

/**
 * 关键词检索。空格分隔的多个词要求**全部**命中（文本或 tags 里）。
 * 不用向量：v1 的目标是"可预测"，子串匹配对短事实足够，且没有索引成本。
 */
export function searchEntries(entries, query) {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return entries;
  const terms = q.split(/\s+/u);
  return entries.filter((e) => {
    const hay = `${e.text} ${e.tags.join(" ")}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * 渲染要注入提示的索引。**必须短**：它每轮都进上下文。
 * @param scopes - [{ label, entries }]，按希望的展示顺序。
 * @param options.maxChars - 硬上限；超出就截断并提示"还有更多"。
 * @param options.recent - 每个作用域展示最近几条。
 * @returns 索引文本；全部为空时返回 ""（不注入任何东西）。
 */
export function renderIndex(scopes, { maxChars = 600, recent = 3 } = {}) {
  const nonEmpty = scopes.filter((s) => s.entries.length > 0);
  if (nonEmpty.length === 0) return "";
  const counts = nonEmpty.map((s) => `${s.label} ${s.entries.length} 条`).join(" · ");
  const lines = [`记忆（memory）：${counts}`];
  for (const s of nonEmpty) {
    // 越新的越靠后，所以取尾部。
    for (const e of s.entries.slice(-recent)) {
      lines.push(`- [${s.label}] ${e.text.length > 120 ? `${e.text.slice(0, 120)}…` : e.text}`);
    }
  }
  lines.push('需要用 memory 工具: action="search" 检索、action="list" 列全部、action="save" 写入、action="forget" 删除。');
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20).trimEnd()}\n…（索引已截断）`;
  return text;
}

/** 记忆目录（可被 DSH_MEMORY_DIR 覆盖）。 */
export function memoryDir() {
  return process.env.DSH_MEMORY_DIR || join(homedir(), ".dsh", "memory");
}

/**
 * 作用域 → 文件路径。
 * @param scope - "global" 或 slug（工作区）。
 */
export function fileFor(scope) {
  return scope === "global" ? join(memoryDir(), "global.md") : join(memoryDir(), `ws-${scope}.md`);
}

/** 读一个作用域；文件不存在视为空。 */
export function loadScope(scope) {
  const file = fileFor(scope);
  if (!existsSync(file)) return [];
  return parseEntries(readFileSync(file, "utf8"));
}

/** 原子写：临时文件 + rename，避免半截文件毁掉整份记忆。 */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 追加一条。
 * @returns 落盘后的条目（含 id/date）。
 */
export function appendEntry(scope, { text, tags = [] }) {
  const entry = { text, tags, id: newId(), date: today() };
  const file = fileFor(scope);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const head = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
  writeAtomic(file, `${head}${formatEntry(entry)}\n`);
  return entry;
}

/**
 * 删除一条。
 * @returns true 表示确实删掉了；false 表示没找到（或文件不存在）。
 */
export function removeEntry(scope, id) {
  const file = fileFor(scope);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  let removed = false;
  const kept = lines.filter((line) => {
    const m = ENTRY_RE.exec(line.trimEnd());
    if (m?.groups?.id === id) {
      removed = true;
      return false;
    }
    return true;
  });
  if (removed) writeAtomic(file, kept.join("\n"));
  return removed;
}
