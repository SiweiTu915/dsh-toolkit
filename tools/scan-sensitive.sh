#!/usr/bin/env bash
# 敏感串扫描 —— **单一实现**,两个入口都调它,免得两处模式漂移:
#
#   tools/pre-commit           扫「暂存区」(= 真正要提交的内容),git commit 时自动跑
#   <本机的 sync-to-repo.sh>   扫「工作树」(= 同步完成后、提交之前)
#
# 模式分两层,**为什么这么分**:
#   通用层(本文件里)  只放与具体个人/厂商无关的东西:密钥材料、个人绝对路径、凭据赋值。
#                      本文件是公开的,所以绝不能写进去「你用了哪家云」「你的项目叫什么」。
#   本机层(.sync-scan-extra,从不进仓库)  放厂商域名、主机名片段、项目名等。
#                      加新词的门槛:这个词出现在公开仓库里会让你不舒服吗?会,就加进去。
#
# 用法:
#   bash tools/scan-sensitive.sh --worktree    # 扫当前工作树(排除 .git / docs)
#   bash tools/scan-sensitive.sh --staged      # 扫暂存区(git commit 之前的真实内容)
#
# 退出码:0 = 干净;1 = 命中(调用方应当中止提交);2 = 环境不对。
set -uo pipefail

MODE="${1:---worktree}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

PATS=()
# 个人绝对路径
PATS+=('/Users/[A-Za-z0-9._-]{3,}/')
# 密钥材料
PATS+=('BEGIN [A-Z ]*PRIVATE KEY')
PATS+=('-----BEGIN')
PATS+=('ssh-ed25519 AAAA')
PATS+=('ssh-rsa AAAA')
PATS+=('ghp_[A-Za-z0-9]{20,}')
PATS+=('github_pat_')
PATS+=('AKIA[0-9A-Z]{16}')
PATS+=('sk-[A-Za-z0-9]{20,}')
PATS+=('xox[baprs]-')
# 「键 = "值"」形态的凭据赋值(值要求有一定长度,避免把代码里的空串/短串当命中)
Q="[\"']"
PATS+=("(api[_-]?key|secret|passwd|password)${Q}?[[:space:]]*[:=][[:space:]]*${Q}[^\"']{8,}")
# 未加引号的赋值:要求值够长**且不含点** —— 否则 `password: explicit.password`
# 这类「把别的字段赋给 password 字段」的普通代码会被误报(实测踩到)
PATS+=("(api[_-]?key|secret|token|passwd|password)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_-]{24,}")

# 本机追加层:一行一个 ERE,以 # 注释
EXTRA_FILE="$DSH_HOME/.sync-scan-extra"
EXTRA_N=0
if [ -f "$EXTRA_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    PATS+=("$line")
    EXTRA_N=$((EXTRA_N + 1))
  done < "$EXTRA_FILE"
fi
# 命令行临时追加
if [ -n "${EXTRA_SCAN:-}" ]; then PATS+=("$EXTRA_SCAN"); fi

PATTERNS="$(IFS='|'; printf '%s' "${PATS[*]}")"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "敏感串扫描($MODE,通用模式 + 本机追加 $EXTRA_N 条):"

if [ "$MODE" = "--staged" ]; then
  # 扫暂存区:这才是「这次提交真正会写进历史」的内容
  cd "$(git -C "$SELF_DIR" rev-parse --show-toplevel 2>/dev/null)" || exit 2
  hits="$(git grep --cached -nEi "$PATTERNS" -- . \
            ':(exclude)tools/scan-sensitive.sh' ':(exclude)tools/pre-commit' 2>/dev/null)"
  where="暂存区"
else
  cd "$SELF_DIR/.." || exit 2
  hits="$(grep -rnEi "$PATTERNS" . \
            --exclude-dir=.git --exclude-dir=docs \
            --exclude=sync-to-repo.sh --exclude=scan-sensitive.sh --exclude=pre-commit 2>/dev/null)"
  where="工作树"
fi

if [ -n "$hits" ]; then
  echo "  ✗ $where 命中疑似敏感内容,已中止:"
  printf '%s\n' "$hits" | sed 's/^/    /'
  echo "  (误报:改写那段文字即可;确认无误要强行提交用 git commit --no-verify。$EXTRA_FILE 只能**新增**要拦的串,给不了例外)"
  exit 1
fi
echo "  ✓ 未发现敏感串"
exit 0
