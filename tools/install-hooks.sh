#!/usr/bin/env bash
# 把仓库里的 hook 装进 .git/hooks(.git 不被版本控制,所以新克隆后要跑一次)。
#
# 用法:
#   bash tools/install-hooks.sh              # 安装 pre-commit
#   bash tools/install-hooks.sh --uninstall  # 卸掉
#
# 装的是什么:.git/hooks/pre-commit → tools/pre-commit(提交前扫暂存区)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null || (cd "$here/.." && pwd))"
dest="$root/.git/hooks/pre-commit"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$dest"
  echo "已卸载 $dest"
  exit 0
fi

[ -f "$root/tools/pre-commit" ] || { echo "找不到 tools/pre-commit" >&2; exit 1; }
mkdir -p "$root/.git/hooks"
cp "$root/tools/pre-commit" "$dest"
chmod +x "$dest"
echo "已安装 $dest"

# 自检:跑一次看它认不认得当下暂存区(有命中是正常的 —— 那正说明扫描器在工作)
if bash "$dest"; then
  echo "自检:当前暂存区干净"
else
  echo "自检:当前暂存区有命中(扫描器工作正常;要么脱敏,要么确认误报后加例外)"
fi
