#!/usr/bin/env bash
# 安装/卸载 dsh-remote 本地常驻服务(launchd)
#   bash install-supervisor.sh [install|uninstall|status]  默认 install
set -euo pipefail

LABEL="com.dsh.remote"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.dsh-remote-logs"
mkdir -p "$LOG_DIR"

CMD="${1:-install}"
mkdir -p "$HOME/Library/LaunchAgents"

case "$CMD" in
  install)
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${DIR}/supervisor.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/launchd.err.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    echo "✓ 已安装并启动 ${LABEL}(面板 + 隧道自动恢复)"
    echo "  面板: http://127.0.0.1:4100"
    echo "  日志: $LOG_DIR/supervisor.log"
    ;;
  uninstall)
    launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ 已卸载 ${LABEL}"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "(未运行)"
    ;;
  *)
    echo "用法: $0 [install|uninstall|status]"; exit 1
    ;;
esac
