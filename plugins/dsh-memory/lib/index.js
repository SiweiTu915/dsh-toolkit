/**
 * dsh-memory —— 跨会话记忆。
 *
 * 为什么要它：会话之间不共享记忆。稳定事实（用户的偏好、机器的端口规则、
 * 某个项目为什么这么设计）每次都要重新解释一遍，代价高且容易前后不一致。
 *
 * 设计上的三个取舍：
 *
 * 1. **文件是唯一真相**（~/.dsh/memory/*.md）。可 grep、可 diff、可手改；
 *    与仓库里 CHANGELOG / MAINTAINING 的用法一致。工具只是入口。
 * 2. **提示里只放索引**（硬上限 600 字符）。全量记忆塞进提示会挤占上下文、
 *    毁掉 prompt 缓存，而且绝大多数当轮无关。所以要细节时由 agent 主动 search。
 * 3. **动态内容放 `context()` 而不是 `section()`**：`section` 会被冻结进
 *    system/message 日志（resume 时不重写），动态索引放进去会让会话的已登录
 *    提示词对不上；`context()` 才是每次装配重算的。
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendEntry,
  loadScope,
  memoryDir,
  removeEntry,
  renderIndex,
  searchEntries,
  slugWorkspace,
} from "./store.mjs";

/**
 * 解析 harness 自带的包（这里只要 `@deepseek-ai/dsh-tools` 的 defineTool）。
 *
 * 为什么不能直接 `import "@deepseek-ai/dsh-tools"`：本插件在 ~/.dsh/plugins/ 下，
 * 不在任何 node_modules 里，裸 specifier 解析不到 harness 的安装目录。
 * 正路是从某个 profile 的 package.json 用 createRequire 解析（pnpm 会把依赖链
 * 装在 profile 的 node_modules 里），失败再退回 harness 安装目录。
 */
async function loadHarnessModule(specifier) {
  const homes = [process.env.DSH_HOME, join(homedir(), ".dsh")].filter(Boolean);
  const candidates = [];
  for (const home of homes) {
    try {
      for (const name of readdirSync(join(home, "profiles"))) {
        candidates.push(join(home, "profiles", name, "package.json"));
      }
    } catch { /* 没有 profiles 目录 */ }
    candidates.push(join(home, "harness", "current", "node_modules"));
  }
  for (const candidate of candidates) {
    try {
      if (candidate.endsWith("package.json")) {
        if (!existsSync(candidate)) continue;
        return await import(pathToFileURL(createRequire(candidate).resolve(specifier)).href);
      }
      const direct = join(candidate, ...specifier.split("/"), "lib", "index.js");
      if (existsSync(direct)) return await import(pathToFileURL(direct).href);
    } catch { /* 换下一个候选 */ }
  }
  return import(specifier); // 最后兜底：让错误信息直观点
}

const { defineTool } = await loadHarnessModule("@deepseek-ai/dsh-tools");

/** Cordis 插件名。 */
export const name = "memory";

/** 需要工具注册表、提示词注册表、以及"当前工作目录"服务（用来定作用域）。 */
export const inject = ["tools", "systemPrompt", "workingDirectory"];

/** 索引注入的硬上限（字符）。每轮都进上下文，宁短勿长。 */
const INDEX_MAX_CHARS = 600;

const DESCRIPTION = `跨会话记忆：把"以后仍然成立的事实"记下来，下次会话自动看到摘要。

什么时候用：
- 用户表达了偏好/约定/环境规则（"手机上用局域网地址"、"这个项目的端口是 X"）
- 弄清了一个以后还会再问的结论（某台机器的约束、某个目录为什么这么摆）
- 不要用它记"这次做了什么"——那是 CHANGELOG 的事，不是记忆

作用域：global（跨项目）| workspace（跟当前工作目录绑定，默认）

动作：
- save    text=… tags=a,b scope=…    追加一条，返回 id
- search  query=… [scope=…]           关键词检索（多个词需全部命中）
- list    [scope=…] [limit=…]         列出条目（带 id）
- forget  id=… [scope=…]              删除一条`;

/** 工具输出：保持极简（一条人能读的 message），减少 schema 校验风险。 */
const OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      message: { type: "string", required: true },
    },
  },
  render: (_args, value) => [{ type: "text", text: value.message }],
};

const PARAMETERS = {
  action: {
    type: "string",
    required: true,
    enum: ["save", "search", "list", "forget"],
    description: "save 写入 / search 检索 / list 列出 / forget 删除",
  },
  text: {
    type: "string",
    description: "save 时的记忆内容。要写成**一句独立成立的事实**，不要写'刚才做了 X'",
  },
  tags: {
    type: "string",
    description: "可选，逗号分隔的标签（例如 端口,手机,gpu）",
  },
  query: {
    type: "string",
    description: "search 的关键词；多个词以空格分隔，要求全部命中",
  },
  scope: {
    type: "string",
    enum: ["global", "workspace"],
    description: "global 跨项目 / workspace 跟当前目录绑定（默认 workspace）",
  },
  id: {
    type: "string",
    description: "forget 时必填：条目 id（list/search 的输出里有）",
  },
  limit: {
    type: "number",
    description: "list 最多返回多少条（默认 20）",
  },
};

/**
 * 把一条条目渲染成一行（给模型看）。
 * @param entry - 存储条目。
 * @param scopeLabel - 展示用的作用域名。
 */
function lineOf(entry, scopeLabel) {
  const tags = entry.tags.length ? ` [${entry.tags.join(",")}]` : "";
  return `- ${entry.text}${tags}  (id:${entry.id} · ${scopeLabel} · ${entry.date})`;
}

/**
 * 注册提示索引与 memory 工具。
 * @param ctx - 含 {@link inject} 的插件上下文。
 */
export function apply(ctx) {
  /** 当前会话的工作目录（同步读，失败则 undefined）。 */
  const cwdOf = (session) => {
    try {
      return session === undefined || session === null ? undefined : ctx.workingDirectory.get(session);
    } catch {
      return undefined;
    }
  };

  /** 把 args.scope 解析成存储作用域键（"global" 或 slug）。 */
  const scopeKeyOf = (requested, session) => {
    if (requested === "global") return "global";
    const slug = slugWorkspace(cwdOf(session));
    // 拿不到工作目录时退回 global：宁可记宽一点，也不要写到 ws-.md 这种无名文件里。
    return slug || "global";
  };

  // ── 提示注入：只放索引，且永不抛错（抛错会让每一轮装配失败）──
  ctx.systemPrompt.context({
    name: "memory:index",
    order: 150, // 在 APPROVAL_POLICY(115)/SUBAGENT(120) 之后、HARNESS_SOURCE(200) 之前
    interpolate: false,
    text: (context) => {
      try {
        const session = context.agent?.session;
        const slug = slugWorkspace(cwdOf(session));
        const scopes = [{ label: "全局", entries: loadScope("global") }];
        if (slug) scopes.push({ label: `工作区:${slug}`, entries: loadScope(slug) });
        return renderIndex(scopes, { maxChars: INDEX_MAX_CHARS });
      } catch {
        return ""; // 记忆坏了也不能拖垮会话
      }
    },
  });

  // ── 工具 ──
  ctx.tools.register(
    defineTool({
      name: "memory",
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: OUTPUT,
      // 读写同一批文件，不能并发：并发写会互相覆盖（虽然写入是原子的）。
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const session = exec.agent?.session;
        const action = String(args.action);

        try {
          if (action === "save") {
            const text = String(args.text ?? "").trim();
            if (!text) return { ok: false, message: "save 需要 text（一句独立成立的事实）。" };
            const key = scopeKeyOf(args.scope, session);
            const tags = String(args.tags ?? "")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            const entry = appendEntry(key, { text, tags });
            return {
              ok: true,
              message: `已记下 (id:${entry.id} · ${key} · ${entry.date})\n${formatLine(entry)}`,
            };
          }

          if (action === "search") {
            const query = String(args.query ?? "").trim();
            if (!query) return { ok: false, message: "search 需要 query。" };
            const key = scopeKeyOf(args.scope, session);
            const scopes = key === "global" ? ["global"] : ["global", key];
            const hits = [];
            for (const s of scopes) {
              for (const e of searchEntries(loadScope(s), query)) hits.push(lineOf(e, s));
            }
            return {
              ok: true,
              message: hits.length
                ? `命中 ${hits.length} 条：\n${hits.join("\n")}`
                : `没有命中「${query}」。可以换关键词，或用 action="list" 看全部。`,
            };
          }

          if (action === "list") {
            const key = scopeKeyOf(args.scope, session);
            const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 20;
            const scopes = key === "global" ? ["global"] : ["global", key];
            const lines = [];
            let total = 0;
            for (const s of scopes) {
              const entries = loadScope(s);
              total += entries.length;
              // 只展示最近的 limit 条（越新越靠后）。
              for (const e of entries.slice(-limit)) lines.push(lineOf(e, s));
            }
            return {
              ok: true,
              message: total === 0
                ? `还没有任何记忆（目录：${memoryDir()}）。`
                : `共 ${total} 条，展示 ${lines.length} 条：\n${lines.join("\n")}`,
            };
          }

          if (action === "forget") {
            const id = String(args.id ?? "").trim();
            if (!id) return { ok: false, message: "forget 需要 id（先用 list/search 查）。" };
            const key = scopeKeyOf(args.scope, session);
            for (const s of key === "global" ? ["global"] : [key, "global"]) {
              if (removeEntry(s, id)) return { ok: true, message: `已删除 id:${id}（${s}）。` };
            }
            return { ok: false, message: `没找到 id:${id}。用 action="list" 看看现有 id。` };
          }

          return { ok: false, message: `未知 action:${action}` };
        } catch (error) {
          return { ok: false, message: `memory ${action} 失败：${error?.message ?? error}` };
        }
      },
    }),
  );
}

/** formatLine：给 save 的输出用（不依赖作用域标签）。 */
function formatLine(entry) {
  const tags = entry.tags.length ? ` [${entry.tags.join(",")}]` : "";
  return `- ${entry.text}${tags}`;
}
