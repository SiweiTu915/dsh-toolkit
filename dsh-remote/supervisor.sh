#!/usr/bin/env bash
# dsh-remote supervisor — 由 launchd 常驻运行:
#   1) 启动时后台恢复所有隧道 / direct 实例(cli.mjs connect --all,幂等)
#   2) 前台常驻 panel.mjs,崩溃自动拉起(带崩溃循环保护)
# 日志: ~/.dsh-remote-logs/supervisor.log / panel.log / connect.log
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.dsh-remote-logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/supervisor.log"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# launchd 环境 PATH 很精简(nvm 的 node 不在里面),显式解析 node 绝对路径
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  log "✗ 找不到 node,退出(等 launchd 重启)"
  exit 1
fi
# launchd 环境 PATH 很精简:补上 node 目录 + $HOME/.dsh/bin(corepack 装的 pnpm 和 dsh shim 在那里,
# 否则面板里调 `dsh plugin` 会报 pnpm not found)
export PATH="$(dirname "$NODE_BIN"):$HOME/.dsh/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

log "supervisor 启动 (DIR=$DIR, NODE=$NODE_BIN)"

# 让手机/平板也能用**同一个**面板:绑定本机局域网地址(每次启动现查,DHCP 变了也不怕)。
# 取不到就退回回环 —— 面板宁可不对外,也不能绑错地址。
PANEL_HOST_IP=""
for ifc in en0 en1 en2; do
  PANEL_HOST_IP="$(ipconfig getifaddr "$ifc" 2>/dev/null || true)"
  [ -n "${PANEL_HOST_IP}" ] && break
done
if [ -n "${PANEL_HOST_IP}" ]; then
  export PANEL_HOST="${PANEL_HOST_IP}"
  log "面板绑定 ${PANEL_HOST_IP}（其他设备需带 token 进入；本机回环免 token）"
else
  log "未取到局域网 IP，面板只绑回环"
fi

# 局域网 IP 变化时自我重启:panel 会重新绑新地址,cli.mjs connect --all 会给各实例
# 补齐转发器。**实例本身绑回环,不会被重启** —— 不会打断正在跑的会话。
# 为什么需要:转发器/面板只在启动时绑一次地址,DHCP 换 IP 后旧地址失效,
# 表现就是「PC 能开、手机打不开」。
WATCH_IP="${PANEL_HOST_IP}"
(
  while true; do
    sleep 30
    NOW_IP="$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null || true)"
    if [ -n "${NOW_IP}" ] && [ "${NOW_IP}" != "${WATCH_IP}" ]; then
      log "局域网 IP 变化 ${WATCH_IP:-无} → ${NOW_IP}，重启 supervisor 以重新绑定"
      kill -TERM $$ 2>/dev/null
      exit 0
    fi
  done
) &

# 1) 后台恢复隧道 / 直启实例(已有在运行的会被 cli.mjs 跳过,幂等)
nohup "$NODE_BIN" "$DIR/cli.mjs" connect --all >> "$LOG_DIR/connect.log" 2>&1 &

# 2) 前台常驻面板,崩溃自动拉起
failcount=0
while true; do
  log "启动 panel.mjs"
  "$NODE_BIN" "$DIR/panel.mjs" >> "$LOG_DIR/panel.log" 2>&1
  code=$?
  if [ "$code" = "0" ]; then failcount=0; else failcount=$((failcount + 1)); fi
  delay=5
  [ "$failcount" -ge 3 ] && delay=30   # 连续崩溃(如端口被占)拉长间隔,避免刷日志
  log "panel 退出 (code=$code),${delay}s 后重启"
  sleep "$delay"
done
