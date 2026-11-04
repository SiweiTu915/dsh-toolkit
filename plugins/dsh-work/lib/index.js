/**
 * dsh-work —— 工作项台账的**服务端**一半。
 *
 * 它解决一个具体的痛点：实验跑完了，人不会自动知道。所以：
 *   1. `work` 工具：list / show / close / **judge**（让模型读日志给出判断）
 *   2. 每轮把「在等你」的工作项**注入提示**（不用你想起来去问）
 *   3. 判断分两层：规则在 `ledger.mjs` 的 `advise()`（可复现、零成本），
 *      模型只在 `judge` 里补「说明了什么 / 下一步 / 风险」—— 各做各擅长的事。
 *
 * 为什么判断不放进提示注入里自动做：那会在**每一轮**都烧一次模型调用。做成显式
 * 的 `judge` 动作，是"按需一次"，成本可控，也便于你看到它到底说了什么。
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  advise,
  append,
  formatItem,
  instanceName,
  loadItems,
  loadLive,
  pendingItems,
  renderRunning,
} from "./ledger.mjs";

export const name = "dsh-work";
export const inject = ["tools", "systemPrompt"];

/**
 * 解析宿主的包：远端插件目录里没有 node_modules，
 * 正路是从某个 profile 的 package.json 用 createRequire 解析。
 * @param specifier - 包名。
 */
function resolveHostPackage(specifier) {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const anchors = [
    join(home, "profiles", "web", "package.json"),
    join(home, "package.json"),
    join(homedir(), ".dsh", "harness", "current", "package.json"),
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(specifier);
    } catch {
      /* 换下一个锚点 */
    }
  }
  throw new Error(`无法解析 ${specifier}：请确认它装在某个 profile 里`);
}

/** 延迟加载宿主模块（插件加载时宿主可能还没就绪）。 */
let toolsModule;
async function loadTools() {
  toolsModule ??= await import(pathToFileURL(resolveHostPackage("@deepseek-ai/dsh-tools")).href);
  return toolsModule;
}
let llmModule;
async function loadLlm() {
  llmModule ??= await import(pathToFileURL(resolveHostPackage("@deepseek-ai/dsh-llm")).href);
  return llmModule;
}

/** 取某作业的最新状态与日志（复用 dsh-exp 的远端模块，不写第二套 SSH）。 */
async function fetchJobLog(id, lines = 60) {
  const base = join(homedir(), ".dsh", "plugins", "dsh-exp", "lib");
  const { runRemote } = await import(pathToFileURL(join(base, "remote.mjs")).href);
  const { statusScript, parseStatus } = await import(pathToFileURL(join(base, "cmds.mjs")).href);
  const out = await runRemote(statusScript({ id, lines }), { timeoutMs: 60000 });
  return parseStatus(out.stdout ?? "");
}

/** 给模型的系统指令：三行、带标签、不许复述日志。 */
export const JUDGE_SYSTEM = [
  "你是实验台的助手，读一段远端作业日志，给工程师判断。",
  "只输出三行，每行以标签开头，不要客套、不要复述日志：",
  "原因：最可能的失败/成功原因，必须引用日志里的证据；证据不足就写「证据不足」。",
  "下一步：一个具体动作（一条命令或要改的文件），不要说「检查一下」这种废话。",
  "风险：可能被忽略的点，没有就写「无」。",
].join("\n");

/**
 * 组装判断请求里的用户消息（纯函数，便于单测）。
 * @param item - 台账里的工作项。
 * @param status - parseStatus 的结果。
 * @returns 一段文本。
 */
export function buildJudgePrompt(item, status) {
  const log = String(status?.log ?? "").slice(-6000);
  return [
    `作业 ${item.subject}　状态=${status?.state ?? item.state}　exit=${status?.exit ?? "-"}`,
    `摘要：${item.summary}`,
    status?.finished ? `结束时间：${status.finished}` : "",
    "",
    "日志（末尾，可能被截断）：",
    log || "(空)",
  ].filter(Boolean).join("\n");
}

/** 从 stream 的文本块里取正文（纯函数）。 */
export function textOf(blocks) {
  return (blocks ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
}

/**
 * 让模型读日志给出判断。
 *
 * 模型来自**当前会话路由到的那个**（`session.requestHeader().config`），
 * 不硬编码任何模型名 —— 换了模型设置这里自动跟着走。
 */
export async function judgeItem(ctx, agent, item, signal, deps = {}) {
  const status = await (deps.fetchJobLog ?? fetchJobLog)(item.subject, Number(process.env.DSH_WORK_JUDGE_LINES) || 60);
  const target = agent?.session?.requestHeader?.()?.config;
  if (!target?.provider || !target?.model) {
    throw new Error("拿不到当前会话的模型路由（provider/model），无法做判断");
  }
  const llm = ctx.get("llm");
  if (!llm) throw new Error("宿主没有 llm 服务，无法做判断");

  const { BlockAssembler } = deps.BlockAssembler ? { BlockAssembler: deps.BlockAssembler } : await loadLlm();
  const prompt = buildJudgePrompt(item, status);

  const assembler = new BlockAssembler();
  let failure;
  const stream = llm.stream({
    provider: target.provider,
    model: target.model,
    messages: [
      {
        role: "system",
        content: [{
          type: "text",
          text: JUDGE_SYSTEM,
        }],
      },
      { role: "user", content: [{ type: "text", text: prompt }] },
    ],
    maxTokens: 400,
    sessionId: agent.session.id,
    purpose: "work-judge",
    ...(signal === undefined ? {} : { signal }),
  });

  for await (const chunk of stream) {
    assembler.push(chunk);
    if (chunk.type === "finish" && chunk.reason?.kind !== "stop") {
      failure = chunk.reason;
    }
  }
  if (failure) throw new Error(`模型调用结束异常：${failure.kind}`);

  const text = textOf(assembler.blocks());
  if (!text) throw new Error("模型没有返回文本");
  return text;
}

/* --------------------------------- 工具 --------------------------------- */

const DESCRIPTION = [
  "工作项台账：把「该人接手的事」记下来、查出来、关掉。",
  "典型用法：实验跑完后先 `action=\"list\"` 看有什么在等你；",
  "对失败的作业用 `action=\"judge\"` 让模型读日志给出「原因/下一步/风险」。",
  "工作项由 dsh-remote/work.mjs 在作业结束时自动写入，这里只负责看和判断。",
].join("");

// 0.2.1 的 defineTool 用的是“作者 schema”：
// · parameters 是一张**属性表**（不是 JSON Schema 的 {type,properties}），
//   required 写在属性上（required: true）；
// · output.schema 是**单个值 schema**，对象节点必须显式写 additionalProperties。
const PARAMETERS = {
  action: {
    type: "string",
    enum: ["list", "show", "close", "judge"],
    description: "list=列未关闭的；show=看一条；close=关掉；judge=让模型读日志给判断",
    required: true,
  },
  id: { type: "string", description: "工作项 id（show/close/judge 需要）" },
  note: { type: "string", description: "close 时的备注" },
};

const OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      message: { type: "string", required: true },
    },
  },
  render: (_args, value) => [{ type: "text", text: String(value?.message ?? "") }],
};

export function apply(ctx) {
  ctx.effect(() => {
    // 每轮把「在等你」的项注入提示：不用你想起来去问它。
    ctx.systemPrompt.context({
      name: "work:pending",
      order: 160,
      interpolate: false,
      text: () => {
        try {
          const sections = [];
          // **在跑**放前面:新会话开始时,人/模型最需要知道的是"有没有事正在进行"
          const me = instanceName();
          const running = renderRunning(loadLive({ instance: me }), 4);
          if (running) sections.push(`正在跑的作业（实时快照，由 launchd 每 60s 刷新）：\n${running}`);
          const items = pendingItems({ instance: me });
          if (items.length > 0) {
            const lines = items.slice(0, 5).map((item) => `- ${item.state} · ${item.summary}`);
            const more = items.length > 5 ? `\n（另有 ${items.length - 5} 条，用 work 工具 action="list" 看）` : "";
            sections.push(`待你处理的工作项 ${items.length} 条（用 work 工具处理）：\n${lines.join("\n")}${more}`);
          }
          return sections.join("\n\n");
        } catch {
          return ""; // 台账坏了不能拖垮会话
        }
      },
    });
    return () => {};
  }, "work.systemPrompt");

  ctx.effect(() => {
    let disposed = false;
    loadTools().then(({ defineTool }) => {
      if (disposed) return;
      ctx.tools.register(
        defineTool({
          name: "work",
          description: DESCRIPTION,
          parameters: PARAMETERS,
          output: OUTPUT,
          isConcurrencySafe: () => false, // 写台账，不能并发
          async execute(args, exec) {
            const action = String(args.action ?? "");
            const id = String(args.id ?? "").trim();
            try {
              if (action === "list") {
                const me = instanceName();
                const items = loadItems({ instance: me }).filter((item) => !item.closed);
                const live = renderRunning(loadLive({ instance: me }), 10);
                const parts = [];
                if (live) parts.push(`在跑：\n${live}`);
                if (items.length > 0) parts.push(`等你处理：\n${items.map(formatItem).join("\n\n")}`);
                return { ok: true, message: parts.length ? parts.join("\n\n") : "没有在跑的任务，也没有未关闭的工作项。" };
              }
              if (action === "show") {
                const item = loadItems({ instance: instanceName() }).find((entry) => entry.id === id);
                if (!item) return { ok: false, message: `没有 ${id}` };
                return { ok: true, message: formatItem(item) };
              }
              if (action === "close") {
                const item = loadItems({ instance: instanceName() }).find((entry) => entry.id === id);
                if (!item) return { ok: false, message: `没有 ${id}` };
                append({ op: "close", id: item.id, note: String(args.note ?? "") });
                return { ok: true, message: `已关闭 ${item.id}` };
              }
              if (action === "judge") {
                const item = loadItems({ instance: instanceName() }).find((entry) => entry.id === id);
                if (!item) return { ok: false, message: `没有 ${id}` };
                const text = await judgeItem(ctx, exec.agent, item, exec.signal);
                append({ op: "judge", id: item.id, text });
                return { ok: true, message: `★ ${item.id} 的判断：\n${text}` };
              }
              return { ok: false, message: `未知 action: ${action}` };
            } catch (error) {
              return { ok: false, message: `work ${action} 失败：${error?.message ?? error}` };
            }
          },
        }),
      );
    }).catch((error) => {
      ctx.logger?.warn?.(`dsh-work: 工具注册失败 ${error?.message ?? error}`);
    });
    return () => { disposed = true; };
  }, "work.tool");
}

// 供测试直接导入的纯函数
export { advise };
