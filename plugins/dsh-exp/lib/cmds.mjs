/**
 * cmds.mjs —— 远程实验任务的**纯命令构造与输出解析**（不连网、可单测）。
 *
 * 任务布局（远端 ~/.dsh-exp/jobs/<id>/）：
 *   cmd.sh      用户命令（base64 解码写入，彻底避开引号地狱）
 *   wrapper.sh  记录自身 pid（setsid 后它就是 session/group leader），再 exec cmd.sh
 *   pid         进程号
 *   started     ISO 时间
 *   workdir     提交时的工作目录
 *   log         stdout+stderr
 *
 * 为什么用 setsid：ssh 断开时进程不能被 SIGHUP 带走；且 pid == 进程组 id，
 * 停止时 `kill -TERM -pid` 能一次收掉整棵子进程树（训练脚本常有 dataloader 子进程）。
 */

/** 允许的 id 形态：只由数字/字母/短横线组成，杜绝路径穿越。 */
export const ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z-]{0,63}$/u;

/** 单引号转义，用于拼 shell 命令。 */
export function shq(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/** 生成一个可排序、可读的 id：时间戳 + 随机后缀。 */
export function newJobId(now = Date.now(), rand = Math.random()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "").replace("T", "-");
  const suffix = Math.floor(rand * 36 ** 4).toString(36).padStart(4, "0");
  return `${stamp}-${suffix}`;
}

/** 远端根目录（可用 DSH_EXP_HOME 覆盖远端路径）。 */
export const REMOTE_ROOT = "$HOME/.dsh-exp";

/**
 * 提交脚本。
 * @param params.id - 任务 id。
 * @param params.command - 要执行的 shell 命令（可多行）。
 * @param params.workdir - 远端工作目录（空则用 $HOME）。
 * @returns 一段可直接交给 ssh 执行的 shell 脚本。
 */
export function submitScript({ id, command, workdir }) {
  if (!ID_RE.test(id)) throw new Error(`非法 id: ${id}`);
  const b64 = Buffer.from(String(command), "utf8").toString("base64");
  const wd = workdir ? shq(workdir) : '"$HOME"';
  return [
    "set -u",
    `J="${REMOTE_ROOT}/jobs/${id}"`,
    'mkdir -p "$J"',
    `printf %s ${shq(b64)} | base64 -d > "$J/cmd.sh"`,
    `printf '%s' ${shq(workdir || "")} > "$J/workdir"`,
    'date -u +%FT%TZ > "$J/started"',
    // wrapper：先写自己的 pid，再 exec 用户命令。setsid 后它就是 group leader。
    "cat > \"$J/wrapper.sh\" <<'DSHEXPWRAP'\n#!/bin/bash\nJ=\"$1\"\necho $$ > \"$J/pid\"\nexec bash \"$J/cmd.sh\"\nDSHEXPWRAP",
    `cd ${wd} >/dev/null 2>&1 || { echo "WORKDIR_MISSING"; exit 3; }`,
    'setsid nohup bash "$J/wrapper.sh" "$J" > "$J/log" 2>&1 < /dev/null &',
    // 等 pid 落盘（wrapper 立刻写），最多 2 秒
    'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$J/pid" ] && break; sleep 0.1; done',
    `echo "ID=${id}"`,
    'echo "PID=$(cat "$J/pid" 2>/dev/null || echo -)"',
    'echo "LOG=$J/log"',
  ].join("\n");
}

/**
 * 列表脚本：每行一条 `id|state|started|bytes|lastline`。
 * state 只看 `kill -0`，所以“进程没了”= 已结束（可能成功也可能失败，看日志）。
 */
export function listScript() {
  return [
    "set -u",
    `R="${REMOTE_ROOT}/jobs"`,
    '[ -d "$R" ] || exit 0',
    'for d in "$R"/*/; do',
    '  [ -d "$d" ] || continue',
    '  id=$(basename "$d")',
    '  pid=$(cat "$d/pid" 2>/dev/null || echo "")',
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then st=running; else st=ended; fi',
    '  started=$(cat "$d/started" 2>/dev/null || echo -)',
    '  bytes=$(wc -c < "$d/log" 2>/dev/null | tr -d " " || echo 0)',
    '  last=$(tail -n 1 "$d/log" 2>/dev/null | tr -d "\\r" | cut -c1-160)',
    '  printf "%s|%s|%s|%s|%s\\n" "$id" "$st" "$started" "$bytes" "$last"',
    "done",
  ].join("\n");
}

/**
 * 单任务状态/日志脚本。
 * @param params.id - 任务 id。
 * @param params.lines - 日志尾部行数。
 */
export function statusScript({ id, lines = 40 }) {
  if (!ID_RE.test(id)) throw new Error(`非法 id: ${id}`);
  const n = Math.max(1, Math.min(2000, Number(lines) || 40));
  return [
    "set -u",
    `J="${REMOTE_ROOT}/jobs/${id}"`,
    '[ -d "$J" ] || { echo "JOB_NOT_FOUND"; exit 4; }',
    'pid=$(cat "$J/pid" 2>/dev/null || echo "")',
    'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then st=running; else st=ended; fi',
    'echo "STATE=$st"',
    'echo "PID=${pid:--}"',
    'echo "STARTED=$(cat "$J/started" 2>/dev/null || echo -)"',
    'echo "WORKDIR=$(cat "$J/workdir" 2>/dev/null || echo -)"',
    'echo "BYTES=$(wc -c < "$J/log" 2>/dev/null | tr -d " " || echo 0)"',
    'echo "---LOG_TAIL---"',
    `tail -n ${n} "$J/log" 2>/dev/null || true`,
  ].join("\n");
}

/** 停止脚本：先给整组 TERM，等 5 秒仍在就 KILL。 */
export function stopScript({ id }) {
  if (!ID_RE.test(id)) throw new Error(`非法 id: ${id}`);
  return [
    "set -u",
    `J="${REMOTE_ROOT}/jobs/${id}"`,
    '[ -d "$J" ] || { echo "JOB_NOT_FOUND"; exit 4; }',
    'pid=$(cat "$J/pid" 2>/dev/null || echo "")',
    '[ -n "$pid" ] || { echo "NO_PID"; exit 5; }',
    'if ! kill -0 "$pid" 2>/dev/null; then echo "ALREADY_ENDED"; exit 0; fi',
    'kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    "for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 \"$pid\" 2>/dev/null || { echo \"STOPPED\"; exit 0; }; sleep 0.5; done",
    'kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
    'sleep 0.3',
    'kill -0 "$pid" 2>/dev/null && { echo "STILL_ALIVE"; exit 6; } || { echo "KILLED"; exit 0; }',
  ].join("\n");
}

/**
 * 解析列表输出。
 * @param stdout - listScript 的输出。
 * @returns 任务数组（按 id 倒序，即新的在前）。
 */
export function parseList(stdout) {
  const jobs = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const [id, state, started, bytes, ...rest] = parts;
    if (!ID_RE.test(id)) continue;
    jobs.push({
      id,
      running: state === "running",
      started,
      bytes: Number(bytes) || 0,
      last: rest.join("|"),
    });
  }
  jobs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return jobs;
}

/**
 * 解析状态输出（头部 KEY=VALUE + `---LOG_TAIL---` 之后的日志）。
 * @param stdout - statusScript 的输出。
 */
export function parseStatus(stdout) {
  const text = String(stdout ?? "");
  const marker = "---LOG_TAIL---";
  const at = text.indexOf(marker);
  const head = at < 0 ? text : text.slice(0, at);
  const log = at < 0 ? "" : text.slice(at + marker.length).replace(/^\n/u, "");
  const fields = {};
  for (const line of head.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return {
    running: fields.STATE === "running",
    pid: fields.PID && fields.PID !== "-" ? fields.PID : null,
    started: fields.STARTED || null,
    workdir: fields.WORKDIR || null,
    bytes: Number(fields.BYTES) || 0,
    log,
  };
}
