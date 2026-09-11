/**
 * workbench.mjs —— 一键创建一个「远程挂载工作台」分区。
 *
 * 一个工作台 = 一个独立 DSH_HOME + 一个 web profile + 三个远程 provider +
 * 一份挂载配置 + 一个本机端口。建好之后,这个分区里的
 * read/write/edit/bash/glob/grep 全部直接在远程机器上执行,本机零拷贝。
 *
 * 这里只负责「建目录、写文件、装依赖」;注册进 servers.json 和启动实例由
 * 面板负责(它已经有那套逻辑)。
 *
 * 为什么要自己写 profile 样板而不是拷现成分区:样板就三行 YAML 加一个
 * package.json,程序化生成更可控,也不会把别人的分区状态带进来。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 默认要装进工作台的三个远程 provider(顺序即注入顺序)。 */
export const DEFAULT_PLUGINS = ["dsh-fs-sftp", "dsh-subprocess-sftp", "dsh-bash-sftp", "dsh-directory-picker-sftp"];

/** profile 根文件:dsh 组合树的入口,内容固定。 */
const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

/** 用户 patch 层:工作台不需要额外覆盖,留空。 */
const CORDIS_PATCH_YML = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

/** pnpm 配置:与官方 profile 一致(hoisted + 不自动装 peer)。 */
const PNPM_WORKSPACE_YAML = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** 分区名:英文 id,用作目录名、servers.json 键和实例名(与面板 validateServer 一致)。 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function portFree(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (free) => { socket.destroy(); resolve(free); };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(false));
    socket.on("timeout", () => done(true));
    socket.on("error", () => done(true));
  });
}

/**
 * 拼一个「够用」的 PATH。
 * 面板由 launchd 拉起,PATH 只有 node 目录加 /usr/local/bin 等,而 pnpm 是通过
 * `corepack enable --install-directory "$HOME/.dsh/bin" pnpm` 装的 —— 不补进来
 * 就会得到 `dsh: pnpm not found on PATH`。
 * @param {string} mainHome - 主 DSH_HOME。
 * @returns {string} 给子进程用的 PATH。
 */
function enrichedPath(mainHome) {
  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  let nvmBins = [];
  try {
    nvmBins = readdirSync(nvmRoot).map((v) => join(nvmRoot, v, "bin"));
  } catch { /* 没用 nvm */ }
  const extra = [
    join(mainHome, "bin"),
    dirname(process.execPath),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    ...nvmBins,
  ];
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...extra, ...current])].join(":");
}

/**
 * 从源服务器条目推导 ssh 目标与参数,写进挂载配置。
 *
 * 为什么需要:`dsh-subprocess-sftp`(bash/glob/grep)是**调用本机 ssh 命令**的,
 * 默认只拿到机器名,于是要求 `~/.ssh/config` 里存在同名别名 —— 而「面板里新加一台
 * 机器」并不会创建别名。这里直接用 `用户@主机` + `-p 端口` 表达,新机器就零配置可用。
 *
 * 另外全新机器的 host key 还不在 known_hosts 里,而 ssh 客户端带 `BatchMode=yes`,
 * 遇到未知主机键会直接失败 —— 所以显式 `StrictHostKeyChecking=accept-new`
 * (首次自动接受,之后仍然校验)。
 * @param {object} input - 创建参数(含 conn 与 sourceEntry)。
 * @returns {object} 追加到挂载配置的字段(无主机信息时为空对象,退回按机器名走别名)。
 */
function sshTargetConfig(input) {
  const source = input.sourceEntry ?? {};
  const conn = input.conn ?? source.conn ?? source.mirror ?? {};
  const host = conn.host ?? source.host;
  const user = conn.user ?? source.user ?? "root";
  const port = Number(conn.sshPort ?? source.sshPort ?? 0);
  const out = {};
  if (typeof host !== "string" || host.length === 0 || host === "127.0.0.1" || host === "localhost") return out;
  out.sshTarget = `${user}@${host}`;
  const extra = [];
  if (Number.isInteger(port) && port > 0 && port !== 22) extra.push("-p", String(port));
  extra.push("-o", "StrictHostKeyChecking=accept-new");
  if (typeof conn.keyPath === "string" && conn.keyPath) extra.push("-i", conn.keyPath);
  out.sshExtraArgs = extra;
  return out;
}

/**
 * 从 base 开始找第一个既没被 servers.json 占用、也没在监听的端口。
 * @param {number[]} used - servers.json 里已登记的端口。
 * @param {number} base - 起始端口。
 * @returns {Promise<number>} 可用端口。
 */
export async function pickFreePort(used, base = 3090, span = 80) {
  const taken = new Set(used.filter((n) => Number.isInteger(n)));
  for (let port = base; port < base + span; port += 1) {
    if (taken.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error(`在 ${base}~${base + span - 1} 之间找不到空闲端口`);
}

/**
 * 校验输入并算出将要创建的东西(不落盘),供 UI 预览与确认。
 * @param {object} input - 见 createWorkbench。
 * @param {object} ctx - { mainHome }。
 * @returns {Promise<object>} 计划与将要写入的路径。
 */
export async function planWorkbench(input, ctx) {
  const mainHome = ctx.mainHome;
  const name = String(input.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new Error("分区名只能是英文小写 id(字母数字 . _ -,以字母数字开头)");
  const remoteRoot = String(input.remoteRoot ?? "/root").trim() || "/root";
  if (!remoteRoot.startsWith("/")) throw new Error("远程根目录必须是绝对路径(如 /root)");
  const home = join(mainHome, "dsh-remote", "sim-homes", name);
  const mountRoot = join(mainHome, "remote-workspaces", name);
  const plugins = (input.plugins ?? DEFAULT_PLUGINS).map((p) => String(p));
  const pluginDirs = plugins.map((p) => join(mainHome, "plugins", p));
  const missing = pluginDirs.filter((dir) => !existsSync(join(dir, "package.json")));
  if (missing.length) throw new Error(`缺少插件包: ${missing.join(", ")}`);
  return { name, remoteRoot, home, mountRoot, plugins, pluginDirs, config: input.config ?? {} };
}

/**
 * 创建目标是否为「空目录或不存在」——避免覆盖已有分区。
 * @param {string} dir - 目标目录。
 * @returns {boolean} 可安全创建时为 true。
 */
function dirIsFree(dir) {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * 建一个远程挂载工作台。
 * @param {object} input - { name, remoteRoot, port, label, note, plugins, config }。
 * @param {object} ctx - { mainHome, dshBin, templateHome }。
 * @param {(msg: string) => void} [log] - 进度回调。
 * @returns {Promise<object>} { steps, home, mountRoot, port, serverRecord, bootLog }。
 */
export async function createWorkbench(input, ctx, log = () => {}) {
  const steps = [];
  const step = (title, ok, detail) => {
    steps.push({ title, ok, detail });
    log(`${ok ? "✓" : "✗"} ${title}${detail ? ` — ${detail}` : ""}`);
  };
  let home = null;
  try {
    const plan = await planWorkbench(input, ctx);
    home = plan.home;
    const result = await runCreate(plan, input, ctx, step);
    result.steps = steps;
    return result;
  } catch (error) {
    // 走到哪一步失败、路径是什么,都挂到错误上,面板才能展示 + 自动清理半成品
    error.steps = steps;
    if (home) {
      error.home = home;
      rollbackWorkbench(home);
      error.message = `${error.message}(已回滚半成品目录 ${home})`;
    }
    throw error;
  }
}

/**
 * createWorkbench 的实际流程(步骤回调由外层包装以附加错误上下文)。
 * @param {object} plan - planWorkbench 的结果(校验过的路径与插件清单)。
 * @param {object} input - 原始创建参数(端口 / 显示名 / 备注 / conn 等可选覆盖)。
 * @param {object} ctx - 运行上下文。
 * @param {(title: string, ok: boolean, detail?: string) => void} step - 进度记录。
 * @returns {Promise<object>} 创建结果。
 */
async function runCreate(plan, input, ctx, step) {
  const { name, remoteRoot, home, mountRoot, plugins, pluginDirs } = plan;
  const templateHome = ctx.templateHome ?? ctx.mainHome;

  if (!dirIsFree(home)) throw new Error(`分区目录已存在且非空: ${home}(先删掉或换个名字)`);
  step("校验输入", true, `分区 ${name} · 远程 ${remoteRoot}`);

  // 1) profile 样板
  const profileDir = join(home, "profiles", "web");
  mkdirSync(profileDir, { recursive: true });
  const bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...plugins];
  const dependencies = {};
  for (let i = 0; i < plugins.length; i += 1) dependencies[plugins[i]] = `link:${pluginDirs[i]}`;
  writeFileSync(join(profileDir, "cordis.yml"), CORDIS_YML);
  writeFileSync(join(profileDir, "cordis.patch.yml"), CORDIS_PATCH_YML);
  writeFileSync(join(profileDir, "pnpm-workspace.yaml"), PNPM_WORKSPACE_YAML);
  writeFileSync(join(profileDir, "package.json"), `${JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies,
    dsh: { profile: { bundles, patchReload: "live" } },
  }, null, 2)}\n`);
  step("写入 profile 样板", true, `bundles: ${bundles.join(", ")}`);

  // 2) 共享的 profiles/node_modules(harness 的 bundle 从这里解析)
  const sharedLink = join(home, "profiles", "node_modules");
  const sharedTarget = join(templateHome, "profiles", "node_modules");
  if (!existsSync(sharedTarget)) throw new Error(`模板 home 缺少 profiles/node_modules: ${sharedTarget}`);
  if (!existsSync(sharedLink)) symlinkSync(sharedTarget, sharedLink, "dir");
  step("链接共享 node_modules", true, `${sharedLink} → ${sharedTarget}`);

  // 3) 装插件(pnpm link,无网络依赖)
  const install = spawnSync(ctx.dshBin, ["plugin", "--profile", "web", "install"], {
    cwd: profileDir,
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, PATH: enrichedPath(ctx.mainHome), DSH_HOME: home },
  });
  if (install.status !== 0) {
    step("安装插件", false, (install.stderr || install.stdout || "").trim().split("\n").slice(-3).join(" / "));
    throw new Error("插件安装失败,见上一步输出");
  }
  const linked = plugins.filter((p) => existsSync(join(profileDir, "node_modules", p)));
  if (linked.length !== plugins.length) {
    step("安装插件", false, `只链接上 ${linked.length}/${plugins.length}`);
    throw new Error("插件未全部链接,profile 会加载失败");
  }
  step("安装插件", true, `${plugins.length} 个已链接`);

  // 4) 挂载配置(四个 provider 共用这一份)
  const port = input.port ?? await pickFreePort(ctx.usedPorts ?? []);
  const config = {
    remoteDir: join(ctx.mainHome, "dsh-remote"),
    server: input.sourceServer ?? name,
    remoteRoot,
    localRoot: mountRoot,
    ...sshTargetConfig(input),
    ...plan.config,
  };
  writeFileSync(join(home, "remote-mount.json"), `${JSON.stringify(config, null, 2)}\n`);
  step("写入挂载配置", true, `${remoteRoot} ⇄ ${mountRoot}${config.sshTarget ? ` · ssh ${config.sshTarget}` : ""}`);

  // 5) 本机挂载点(工作区注册表要求它是本机真实目录)
  mkdirSync(mountRoot, { recursive: true });
  step("建立本机挂载点", true, mountRoot);

  // 6) 继承模板 home 的凭证 / 设置 / 技能
  //    少了凭证,新分区的 agent 连模型都调不动(MISSING_CREDENTIAL);少了 skills
  //    链接,它就没有 gpu-partition 那套远程约定。
  //    注意:harness 首次启动会自建一个**空壳** .credentials.yaml(只有浏览器
  //    会话授权、没有 API key),所以不能用「目标不存在才拷」来判断 —— 这里直接
  //    覆盖。创建工作发生在实例启动之前,不存在覆盖用户配置的风险。
  const inherited = [];
  for (const file of [".credentials.yaml", "settings.yaml"]) {
    const src = join(templateHome, file);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(home, file));
    inherited.push(file);
  }
  const skillsSrc = join(templateHome, "skills");
  if (existsSync(skillsSrc) && !existsSync(join(home, "skills"))) {
    symlinkSync(skillsSrc, join(home, "skills"), "dir");
    inherited.push("skills→");
  }
  step("继承凭证/设置/技能", inherited.length > 0, inherited.length > 0
    ? inherited.join(", ")
    : `模板 home(${templateHome})里没有可继承的凭证 —— 新分区需要手动配 API key`);

  const serverRecord = {
    name,
    label: input.label || `${name}(远程挂载)`,
    direct: true,
    host: "127.0.0.1",
    user: "local",
    sshPort: 22,
    dshPort: port,
    localPort: port,
    platform: "linux",
    home,
    note: input.note || `远程挂载工作台:远程 ${remoteRoot} ⇄ 本机 ${mountRoot};read/write/edit/bash/glob/grep 全部在远程执行`,
    ...(input.conn ? { conn: input.conn } : {}),
  };

  return {
    steps: null,
    home,
    mountRoot,
    port,
    serverRecord,
    bootLog: join(ctx.mainHome, "dsh-remote", ".state", `boot-${name}.log`),
  };
}

/**
 * 回滚一个建到一半的工作台(仅删自己刚建的东西)。
 * @param {string} home - 分区 home。
 */
export function rollbackWorkbench(home) {
  try {
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  } catch { /* 回滚尽力而为 */ }
}
