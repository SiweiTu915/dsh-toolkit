#!/bin/bash
# restart-web.sh —— 安全重启主 GUI（默认 3080）。
#
# 为什么需要它：直接再敲一遍启动命令很常见的结果是
#   EADDRINUSE 127.0.0.1:3080 → 新进程退出 → 你以为重启了，其实还是旧进程。
# 这个脚本先**停干净**（TERM → 等 → KILL），确认端口真的空了，再起新的，
# 并检查新进程是否真的活着。
#
# 用法：
#   ./restart-web.sh            # 重启 3080
#   ./restart-web.sh --status   # 只看现在是谁占着，不动
#   ./restart-web.sh 3090       # 换端口

set -uo pipefail

PORT="${1:-3080}"
if [ "$PORT" = "--status" ]; then PORT=3080; STATUS_ONLY=1; else STATUS_ONLY=0; fi
DSH_BIN="${DSH_BIN:-$HOME/.dsh/bin/dsh}"
LOG_DIR="$HOME/.dsh/logs"
mkdir -p "$LOG_DIR"

holders() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u
}

show() {
  local pids
  pids="$(holders)"
  if [ -z "$pids" ]; then
    echo "  端口 ${PORT}：空闲"
  else
    echo "  端口 ${PORT}：被占用 → ${pids}"
  fi
}

echo "== 重启前 =="
show

if [ "$STATUS_ONLY" = "1" ]; then
  exit 0
fi

# 1) 停：TERM，等最多 10 秒，再 KILL 兜底
pids="$(holders)"
if [ -n "$pids" ]; then
  echo "== 停止 =="
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    [ -z "$(holders)" ] && break
    sleep 0.5
  done
  pids="$(holders)"
  if [ -n "$pids" ]; then
    echo "  还有进程不退，改为 KILL: $pids"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    sleep 1
  fi
fi

# 2) 确认端口真的空了 —— 这一步不做，就会出现"以为重启了"
for _ in $(seq 1 10); do
  [ -z "$(holders)" ] && break
  sleep 0.5
done
if [ -n "$(holders)" ]; then
  echo "✗ 端口 ${PORT} 仍被占用，放弃启动（避免又起一个立刻退出的进程）"
  show
  exit 1
fi
echo "  已确认端口空闲"

# 3) 起
STAMP="$(date +%Y%m%dT%H%M%S)"
LOG="$LOG_DIR/web-$PORT-$STAMP.log"
echo "== 启动 =="
echo "  日志: ${LOG}"
if [ ! -x "$DSH_BIN" ]; then
  echo "✗ 找不到 ${DSH_BIN}（可用 DSH_BIN=... 指定）"
  exit 1
fi
nohup "$DSH_BIN" web --port "$PORT" >"$LOG" 2>&1 &
NEW_PID=$!
echo "  pid: $NEW_PID"

# 4) 等它就绪，并检查是否真的活着
for _ in $(seq 1 40); do
  sleep 0.5
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "✗ 新进程已退出，请看日志:"
    tail -20 "$LOG" | sed 's/^/    /'
    exit 1
  fi
  [ -n "$(holders)" ] && break
done

if [ -z "$(holders)" ]; then
  echo "✗ 等了 20 秒端口仍未监听，请看日志:"
  tail -20 "$LOG" | sed 's/^/    /'
  exit 1
fi

echo "== 就绪 =="
show
# 不在这里提取登录链接:主 GUI 通常已有 30 天 cookie,直接开即可;
# 真需要时从日志里拿(启动那一行)。
echo "  直接打开: http://127.0.0.1:${PORT}/"
echo "  若要求登录,链接在日志里: ${LOG}"
echo "  ── 加载失败检查（应为空）:"
grep -inE "failed to import|EADDRINUSE|did not activate" "$LOG" | head -5 | sed 's/^/    /' || true
