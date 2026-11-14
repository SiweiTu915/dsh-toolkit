#!/usr/bin/env node
/**
 * doctor.mjs —— 插件装载自查。把"改了没生效"从猜变成一眼。
 *
 * 为什么需要：今天连续踩了三次装载失败，每次都要去翻 startup 日志才看明白：
 *   ① 包缺 `main` → `Cannot find package '.../dsh-work/index.js'`
 *   ② 声明了 `dsh.client` 但没有 `exports["./client"]` → 客户端 bundle 静默不加载
 *   ③ profile 里的 symlink 指向不存在 → 解析失败
 * 这三类都能**静态**查出来，不必等重启。
 *
 * 用法：
 *   node ~/.dsh/dsh-remote/doctor.mjs            # 查所有 profile 里的自有插件
 *   node ~/.dsh/dsh-remote/doctor.mjs --verbose  # 每条检查都打印
 *
 * 退出码：0 全通过；1 有失败项。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const VERBOSE = process.argv.includes("--verbose");

/** 读 JSON，坏了返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 一条检查结果。 */
const results = [];
function check(scope, name, ok, detail) {
  results.push({ scope, name, ok, detail });
  if (VERBOSE || !ok) {
    const mark = ok ? "✓" : "✗";
    console.log(`  ${mark} [${scope}] ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

/** 找出所有 profile 目录（主 home + 各工作台分区）。 */
function profiles() {
  const out = [];
  const main = join(DSH_HOME, "profiles");
  if (existsSync(main)) {
    for (const entry of readdirSync(main, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const dir = join(main, entry.name);
      // 只认"真的是 profile"的目录(有 package.json 且声明了 dsh.profile),别把杂目录算进来
      if (!readJson(join(dir, "package.json"))?.dsh?.profile) continue;
      out.push({ label: `main/${entry.name}`, dir });
    }
  }
  const sims = join(DSH_HOME, "dsh-remote", "sim-homes");
  if (existsSync(sims)) {
    for (const entry of readdirSync(sims, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const prof = join(sims, entry.name, "profiles", "web");
      if (existsSync(prof)) out.push({ label: `${entry.name}/web`, dir: prof });
    }
  }
  return out;
}

/**
 * 查一个插件包本身的装载条件（与它装在哪个 profile 无关）。
 * @param dir - 插件目录（含 package.json）。
 */
function checkPackage(dir) {
  const name = dir.split("/").pop();
  const pkg = readJson(join(dir, "package.json"));
  if (!check("pkg", `${name}: package.json 可解析`, pkg !== null, pkg ? "" : "JSON 坏了或不存在")) return;

  // ① 服务端入口
  const mainRel = pkg.main ?? pkg.exports?.["."]?.default ?? pkg.exports?.["."];
  const mainPath = typeof mainRel === "string" ? join(dir, mainRel) : null;
  check("pkg", `${name}: 入口文件存在`, Boolean(mainPath && existsSync(mainPath)),
    mainPath ? (existsSync(mainPath) ? mainPath.replace(dir, ".") : `缺 ${mainRel}（宿主会报 Cannot find package .../index.js）`) : "package.json 没有 main/exports[\".\"]");

  // ② 客户端入口（只对声明了 dsh.client 的包）
  if (pkg.dsh?.client) {
    const clientRel = pkg.exports?.["./client"]?.default ?? pkg.exports?.["./client"];
    const clientPath = typeof clientRel === "string" ? join(dir, clientRel) : null;
    check("pkg", `${name}: 客户端入口 exports["./client"]`, Boolean(clientPath && existsSync(clientPath)),
      clientPath ? (existsSync(clientPath) ? clientPath.replace(dir, ".") : `缺 ${clientRel}`) : "声明了 dsh.client 却没有 exports[\"./client\"]（客户端 bundle 会静默不加载）");
  }

  // ③ 版本声明（engines.dsh 可选，但写了就要能读懂）
  if (pkg.engines?.dsh) {
    check("pkg", `${name}: engines.dsh 已声明`, true, pkg.engines.dsh);
  }
}

/** 查一个 profile 里的链接、解析、bundles。 */
function checkProfile({ label, dir }) {
  const pkg = readJson(join(dir, "package.json"));
  if (!check("profile", `${label}: package.json 可解析`, pkg !== null)) return;
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const require = createRequire(join(dir, "package.json"));

  for (const name of bundles) {
    // 自有的（我们自己的插件）才查链接；官方包由 pnpm 装，resolvv 就够
    // 只要 ~/.dsh/plugins 下有同名目录就算"自有插件",就该查链接
    const own = existsSync(join(DSH_HOME, "plugins", name));
    if (own) {
      const link = join(dir, "node_modules", name);
      const linked = existsSync(link);
      let target = null;
      try { target = linked ? realpathSync(link) : null; } catch { target = null; }
      check("profile", `${label}: ${name} 的 link 有效`, Boolean(target && existsSync(join(target, "package.json"))),
        linked ? (target ? `→ ${target}` : "link 断了（相对路径写错？）") : "没有 node_modules 链接（宿主会 skipping profile bundle）");
    }
    // 解析：宿主的兜底顺序是「profile → dsh 安装目录」，这里必须一致，
    // 否则会把"其实能从安装目录解析到"的包误报成坏掉。
    let resolved = null;
    try { resolved = require.resolve(name); } catch { resolved = null; }
    if (!resolved) {
      try {
        resolved = createRequire(join(DSH_HOME, "harness", "current", "package.json")).resolve(name);
      } catch { resolved = null; }
    }
    check("profile", `${label}: ${name} 可解析`, Boolean(resolved), resolved ? "" : "require.resolve 失败（会 skipping profile bundle）");
  }
}

/** 最近一次启动日志里的装载错误。 */
function checkStartupLogs() {
  const logs = [];
  const mainLogs = join(DSH_HOME, "logs");
  if (existsSync(mainLogs)) logs.push({ label: "main", dir: mainLogs });
  const sims = join(DSH_HOME, "dsh-remote", "sim-homes");
  if (existsSync(sims)) {
    for (const entry of readdirSync(sims, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(sims, entry.name, "logs");
      if (existsSync(dir)) logs.push({ label: entry.name, dir });
    }
  }

  for (const { label, dir } of logs) {
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("startup-")).sort();
    } catch { continue; }
    const latest = files.at(-1);
    if (!latest) continue;
    let text = "";
    try { text = readFileSync(join(dir, latest), "utf8"); } catch { continue; }
    // 历史失败日志不该当成"当前问题":只看最近 2 小时的
    let recent = false;
    try { recent = Date.now() - statSync(join(dir, latest)).mtimeMs < 2 * 3600_000; } catch { /* 读不到就不管 */ }
    if (!recent) continue;
    const failed = /failed to import|skipping profile bundle|did not activate/.test(text);
    check("log", `${label}: 最近启动无装载错误`, !failed,
      failed ? `见 ${join(dir, latest)}（若刚改过代码，可能需要重启才生效）` : latest);
  }
}

/** 主流程。 */
function main() {
  console.log(`插件自查（DSH_HOME=${DSH_HOME}）\n`);

  const pluginsDir = join(DSH_HOME, "plugins");
  if (existsSync(pluginsDir)) {
    console.log("== 插件包 ==");
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(pluginsDir, entry.name);
      if (!existsSync(join(dir, "package.json"))) continue;
      checkPackage(dir);
    }
  }

  const profs = profiles();
  if (profs.length > 0) {
    console.log("== profile 装配 ==");
    for (const prof of profs) checkProfile(prof);
  }

  console.log("== 最近启动日志 ==");
  checkStartupLogs();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项检查：${results.length - failed.length} 通过，${failed.length} 失败`);
  if (failed.length > 0) {
    console.log("\n失败项：");
    for (const f of failed) console.log(`  ✗ [${f.scope}] ${f.name} — ${f.detail}`);
  }
  return failed.length === 0 ? 0 : 1;
}

process.exit(main());
