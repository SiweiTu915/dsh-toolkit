/**
 * dsh-exp —— 远程实验任务管理（提交 / 列表 / 状态 / 日志 / 停止）。
 *
 * 为什么需要它：实验跑在 GPU 机上动辄几十分钟到几小时，靠 `bash` 里一条
 * `nohup ... &` 手打很容易丢（会话一断、日志路径忘、pid 找不到）。
 * 这个工具把「起任务 → 落到固定目录 → 记录 pid 与日志 → 能查能停」固化成一条路径。
 *
 * 三个设计取舍：
 * 1. **任务目录在远端**（`~/.dsh-exp/jobs/<id>/`），不依赖本机状态。本机重启/换机器
 *    都不会丢任务视图；`list` 读的就是远端真实进程。
 * 2. **setsid 起进程**：ssh 断开不被 SIGHUP 带走；且 pid 就是进程组 id，
 *    `stop` 能一次收掉整棵树（训练脚本常有 dataloader 子进程）。
 * 3. **不注入提示词**：状态要连远端才知道，每轮注入等于每轮一次 SSH，太贵。
 *    由 agent 在需要时调 `exp list`。
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listScript, newJobId, parseList, parseStatus, statusScript, stopScript, submitScript } from "./cmds.mjs";
import { describeTarget, runRemote } from "./remote.mjs";

/** Cordis 插件名。 */
export const name = "exp";

/** 只要工具注册表。 */
export const inject = ["tools"];

/** 与 dsh-memory 同一套动态解析：插件目录下裸 import 拿不到 harness 包。 */
async function loadHarnessModule(specifier) {
  const homes = [process.env.DSH_HOME, join(homedir(), ".dsh")].filter(Boolean);
  const candidates = [];
  for (const home of homes) {
    try {
      for (const entry of readdirSync(join(home, "profiles"))) {
        candidates.push(join(home, "profiles", entry, "package.json"));
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
  return import(specifier);
}

const { defineTool } = await loadHarnessModule("@deepseek-ai/dsh-tools");

const DESCRIPTION = `在 GPU 机上管理长跑的实验任务（提交/列表/状态/日志/停止）。

任务跑在远端 \`~/.dsh-exp/jobs/<id>/\`，日志落盘、pid 记录、用 setsid 隔离：
即使 ssh 断开也不会被挂断，停止时能一次收掉整棵子进程树。

动作：
- submit  command=… [workdir=…]  起一个后台任务，返回 id 与日志路径（不阻塞）
- list                            列出所有任务：运行中/已结束 + 最后一行日志
- status  id=… [lines=…]          看状态与日志尾部
- logs    id=… [lines=…]          只看日志尾部
- stop    id=…                    先 TERM 整组，5 秒不退则 KILL

注意：submit 只是**启动**，不会等它跑完；判断结果要看 status 里的日志尾部。`;

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
    enum: ["submit", "list", "status", "logs", "stop"],
    description: "submit 起任务 / list 列表 / status 状态 / logs 日志 / stop 停止",
  },
  command: { type: "string", description: "submit 时必填：要执行的 shell 命令（可多行）" },
  workdir: { type: "string", description: "submit 时可选：远端工作目录，默认 $HOME" },
  id: { type: "string", description: "status/logs/stop 时必填：任务 id" },
  lines: { type: "number", description: "status/logs 返回的日志尾部行数（默认 40）" },
};

/** 把列表格式化成一段可读文本。 */
function formatList(jobs) {
  if (jobs.length === 0) return "还没有任何实验任务。用 action=\"submit\" 起一个。";
  const lines = jobs.map((j) => {
    const flag = j.running ? "运行中" : "已结束";
    const size = j.bytes >= 1024 ? `${(j.bytes / 1024).toFixed(1)}KB` : `${j.bytes}B`;
    return `- ${j.id}  ${flag}  ${j.started}  ${size}${j.last ? ` | ${j.last}` : ""}`;
  });
  const running = jobs.filter((j) => j.running).length;
  return `共 ${jobs.length} 个任务（运行中 ${running}）:\n${lines.join("\n")}`;
}

/**
 * 注册 exp 工具。
 * @param ctx - 含 tools 服务的插件上下文。
 */
export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "exp",
      description: `${DESCRIPTION}\n\n当前目标机器：${describeTarget()}`,
      parameters: PARAMETERS,
      output: OUTPUT,
      // 同一时刻可能有多条写入同一任务目录（log 由远端写，注册表只在远端），
      // 但 stop/status 之间不该并发，保守起见不并行。
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = String(args.action);
        try {
          if (action === "submit") {
            const command = String(args.command ?? "").trim();
            if (!command) return { ok: false, message: "submit 需要 command。" };
            const id = newJobId();
            const r = runRemote(submitScript({ id, command, workdir: args.workdir ? String(args.workdir) : "" }), {
              timeoutMs: 60_000,
            });
            if (!r.ok) {
              return { ok: false, message: `提交失败（ssh 退出码 ${r.code}）：${(r.stderr || r.stdout).trim().slice(0, 600)}` };
            }
            if (r.stdout.includes("WORKDIR_MISSING")) {
              return { ok: false, message: `远端工作目录不存在：${args.workdir}\n先确认路径（远端拼写），或不传 workdir 用 $HOME。` };
            }
            const pid = /PID=(.*)/u.exec(r.stdout)?.[1]?.trim() ?? "-";
            const log = /LOG=(.*)/u.exec(r.stdout)?.[1]?.trim() ?? `~/.dsh-exp/jobs/${id}/log`;
            return {
              ok: true,
              message: `已提交 id:${id}（pid ${pid}）\n日志：${log}\n用 action="status" id="${id}" 看进展；它只是启动，不会等跑完。`,
            };
          }

          if (action === "list") {
            const r = runRemote(listScript(), { timeoutMs: 60_000 });
            if (!r.ok) return { ok: false, message: `读取任务列表失败：${(r.stderr || "").trim().slice(0, 600)}` };
            return { ok: true, message: formatList(parseList(r.stdout)) };
          }

          if (action === "status" || action === "logs") {
            const id = String(args.id ?? "").trim();
            if (!id) return { ok: false, message: `${action} 需要 id（先用 list 查）。` };
            const lines = Number.isFinite(Number(args.lines)) && Number(args.lines) > 0 ? Number(args.lines) : 40;
            const r = runRemote(statusScript({ id, lines }), { timeoutMs: 60_000 });
            if (!r.ok && r.stdout.includes("JOB_NOT_FOUND")) {
              return { ok: false, message: `没有 id:${id} 这个任务。用 action="list" 看现有的。` };
            }
            if (!r.ok) return { ok: false, message: `读取状态失败：${(r.stderr || r.stdout).trim().slice(0, 600)}` };
            const st = parseStatus(r.stdout);
            const head = `id:${id} ${st.running ? "运行中" : "已结束"} · pid ${st.pid ?? "-"} · 开始 ${st.started ?? "-"} · 日志 ${st.bytes}B`;
            const body = action === "logs" ? st.log : `${head}\nworkdir: ${st.workdir ?? "-"}\n--- 日志尾部 ---\n${st.log}`;
            return { ok: true, message: body };
          }

          if (action === "stop") {
            const id = String(args.id ?? "").trim();
            if (!id) return { ok: false, message: "stop 需要 id。" };
            const r = runRemote(stopScript({ id }), { timeoutMs: 90_000 });
            const out = r.stdout.trim();
            if (!r.ok && out.includes("JOB_NOT_FOUND")) {
              return { ok: false, message: `没有 id:${id} 这个任务。` };
            }
            const verdict = out.includes("STOPPED") || out.includes("KILLED") || out.includes("ALREADY_ENDED");
            return {
              ok: verdict,
              message: verdict ? `已停止 id:${id}（${out.split("\n").pop()}）` : `停止结果未确定：${(out || r.stderr).trim().slice(0, 400)}`,
            };
          }

          return { ok: false, message: `未知 action:${action}` };
        } catch (error) {
          return { ok: false, message: `exp ${action} 失败：${error?.message ?? error}` };
        }
      },
    }),
  );
}
