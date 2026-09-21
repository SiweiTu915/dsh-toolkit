#!/usr/bin/env bash
# 跑纯逻辑测试(路径 / 围栏 / 换端点)。
#
# 为什么这些要有测试:三个真 bug(rename 覆盖必挂、editText 版本守卫恒真、
# 悬空软链能逃出围栏)全都是「手工试过几条 happy path」漏掉的,而它们的共同点是
# **逻辑都在纯函数里** —— 纯函数没有理由不测。
#
# 用法:bash tools/run-tests.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null || (cd "$here/.." && pwd))"
cd "$root/dsh-remote"
# 注意:`node --test <目录>` 在部分版本上会被当成模块解析,这里显式给文件
shopt -s nullglob
files=(test/*.test.mjs)
if [ ${#files[@]} -eq 0 ]; then
  # 「0 个测试也算通过」是最该防的假绿 —— 宁可直接失败
  echo "找不到测试文件(test/*.test.mjs);仓库里是不是没同步 test/?" >&2
  exit 1
fi
exec node --test "${files[@]}" 
