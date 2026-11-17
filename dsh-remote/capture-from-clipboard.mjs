#!/usr/bin/env node
/**
 * capture-from-clipboard.mjs —— 把浏览器里导出的 JSON 从**剪贴板**接过来存盘并预览。
 *
 * 为什么需要：Safari 的扩展弹窗没有 `chrome.downloads`（实测 undefined），
 * 而 `<a download>` + blob 会被 Safari 当成"导航到 blob 页面"，报
 * WebKitBlobResource 错误 1。所以那条路走不通 —— 但**剪贴板一定通**：
 * 导出按钮先写剪贴板，这里 `pbpaste` 取出来，落盘 + 出预览表，人不用手抄。
 *
 * 用法：
 *   node capture-from-clipboard.mjs            # 从剪贴板取，存到 ~/Downloads，并预览
 *   node capture-from-clipboard.mjs --out x.json
 *   node capture-from-clipboard.mjs --workspace <目标工作区路径>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { conversationsOf, previewTable, dshHome } = await import("./session-writer.mjs");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

/** 读 macOS 剪贴板。 */
function readClipboard() {
  const r = spawnSync("pbpaste", [], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`读剪贴板失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`pbpaste 退出码 ${r.status}`);
  return r.stdout ?? "";
}

const text = readClipboard().trim();
if (!text) {
  console.error("✗ 剪贴板是空的。先在浏览器里点「导出选中」（它会把 JSON 写进剪贴板）。");
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(text);
} catch (error) {
  console.error(`✗ 剪贴板内容不是合法 JSON（${error.message}）。`);
  console.error(`  开头 120 字：${text.slice(0, 120)}`);
  console.error("  如果是一段 HTML 或普通文本，说明导出没走到「复制」那一步。");
  process.exit(1);
}

let list;
try {
  list = conversationsOf(raw, "剪贴板导入");
} catch (error) {
  console.error(`✗ 认不出这份 JSON：${error.message}`);
  console.error("  期望形状：{conversations:[…]} 或 {data:{biz_data:{chat_messages:[…]}}}");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
// 默认落在**工作区内**（~/.dsh/storages/incoming）：沙箱一般不允许写 ~/Downloads，
// 而且这样所有导入物都有统一去处，好清理。
const out = opt("out") ?? join(dshHome(), "storages", "incoming", `deepseek-capture-${stamp}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

const workspace = opt("workspace") ?? join(dshHome(), "");
const { text: table } = previewTable(list, { sourceFile: out, workspace, home: dshHome() });
console.log(`✓ 已从剪贴板取出并保存：${out}`);
console.log("");
console.log(table);
console.log("");
console.log("确认无误后导入：");
console.log(`  node session-writer.mjs ${JSON.stringify(out)} --workspace ${JSON.stringify(workspace)} --yes`);
