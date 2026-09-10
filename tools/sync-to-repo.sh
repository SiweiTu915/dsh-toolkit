#!/usr/bin/env bash
# 把本机 DSH_HOME 里维护的改造同步到本仓库(工作副本 → 发布副本)
#
# 设计前提:本机是持续使用的生产环境,仓库只是发布副本 —— 两者解耦,不做软链。
# 本脚本负责:拷贝通用文件 → 敏感串扫描(有泄漏就中止) → 展示 diff。
# 提交/推送仍由你确认后手动执行(公开仓库不可逆)。
#
# 用法:
#   bash tools/sync-to-repo.sh [DSH_HOME]        默认 DSH_HOME=~/.dsh
#   EXTRA_SCAN="你的服务器域名|你的邮箱" bash tools/sync-to-repo.sh   # 追加敏感串
set -euo pipefail

DSH_HOME="${1:-$HOME/.dsh}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "工作副本: $DSH_HOME"
echo "发布副本: $REPO"
echo

# ── 1) 拷贝「通用」文件(可安全公开的) ───────────────────────────────────
copy() { # copy <相对路径>
  local rel="$1"
  if [ -f "$DSH_HOME/$rel" ]; then
    mkdir -p "$REPO/$(dirname "$rel")"
    cp "$DSH_HOME/$rel" "$REPO/$rel"
    echo "  ✓ $rel"
  else
    echo "  - $rel (本机不存在,跳过)"
  fi
}

echo "同步工具:"
copy "update-dsh.mjs"     # 仓库内路径 tools/ 由下方移动
copy "migrate-dsh.mjs"

# 工具放到 tools/ 下(仓库结构),本机在根目录
mkdir -p "$REPO/tools"
[ -f "$DSH_HOME/update-dsh.mjs" ]  && cp "$DSH_HOME/update-dsh.mjs"  "$REPO/tools/update-dsh.mjs"  && echo "  ✓ tools/update-dsh.mjs"
[ -f "$DSH_HOME/migrate-dsh.mjs" ] && cp "$DSH_HOME/migrate-dsh.mjs" "$REPO/tools/migrate-dsh.mjs" && echo "  ✓ tools/migrate-dsh.mjs"
rm -f "$REPO/update-dsh.mjs" "$REPO/migrate-dsh.mjs" 2>/dev/null || true

echo "同步远程面板:"
for f in cli.mjs panel.mjs panel.html install-remote.sh install-supervisor.sh supervisor.sh servers.example.json; do
  copy "dsh-remote/$f"
done

echo "同步插件:"
for p in "$DSH_HOME"/plugins/*/; do
  [ -d "$p" ] || continue
  name="$(basename "$p")"
  rm -rf "$REPO/plugins/$name"
  mkdir -p "$REPO/plugins"
  cp -r "$p" "$REPO/plugins/$name"
  echo "  ✓ plugins/$name"
done

echo
echo "以下文件「不自动同步」——仓库里是脱敏后的公开版本,本机是个人版本:"
echo "  · skills/gpu-partition/SKILL.md (本机含你的服务器地址/项目名)"
echo "  · docs/USAGE.md               (本机含你的个人技能清单)"
echo "  · dsh-remote/servers.json / .state / sim-homes (个人数据,已 gitignore)"
echo

# ── 2) 敏感串扫描(有命中就中止) ─────────────────────────────────────
# 高置信度模式:真实密钥材料、个人绝对路径、特定云主机名、带值的密钥/口令赋值。
# 排除:.git、本脚本自身、docs/(文档含示例占位符,由人工审阅)。
PATTERNS='/Users/[A-Za-z0-9._-]{3,}/|ssh-ed25519 AAAA|BEGIN [A-Z ]*PRIVATE KEY|\.seetacloud\.com|autodl-container-|(api[_-]?key|secret|token|passwd|password)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{8,}'

echo "敏感串扫描:"
cd "$REPO"
if hits=$(grep -rnEi "$PATTERNS" . --exclude-dir=.git --exclude-dir=docs --exclude=sync-to-repo.sh 2>/dev/null); then
  echo "  ✗ 发现疑似敏感内容,已中止(请脱敏后重试):"
  echo "$hits" | sed 's/^/    /'
  echo "  (如需忽略误报:调整 tools/sync-to-repo.sh 的 PATTERNS,或用 EXTRA_SCAN 追加你自己的串)"
  exit 1
fi
echo "  ✓ 未发现敏感串"
echo "  · docs/ 与扫描器自身按设计跳过 —— 提交前请看一遍 docs 的 diff"
echo

# ── 3) 展示变更 ────────────────────────────────────────────────────────
echo "变更概览:"
git status --short || true
echo
echo "下一步(确认无误后):"
echo "  cd $REPO && git add -A && git commit -m \"sync: <说明>\" && git push"
