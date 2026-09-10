#!/usr/bin/env bash
# dsh-remote 服务器端一键安装与启动脚本
#
# 在远程服务器上执行（Linux/macOS）：
#   bash install-remote.sh [port]          首次安装并启动
#   bash install-remote.sh --update [port] 更新 dsh 到最新版并重启服务
#
# 做什么：
#   1. 检查 Node.js（需要 >= 22，推荐 24）
#   2. 安装 @deepseek-ai/dsh CLI
#   3. 用 systemd (Linux) 或 launchd (macOS) 注册常驻服务，或给出 nohup 启动命令
#   4. 输出连接信息（供本地 dsh-remote 控制面板使用）
#
# 注意：dsh web 只绑定 127.0.0.1（框架刻意拒绝 0.0.0.0），
#       远程访问必须走 SSH 隧道 —— 这正是 dsh-remote 的做法，安全且无需额外认证配置。
set -euo pipefail

PORT="${1:-3080}"
UPDATE=0
if [ "${1:-}" = "--update" ]; then
  UPDATE=1
  PORT="${2:-3080}"
fi
INSTALL_DIR="${DSH_INSTALL_DIR:-$HOME/.dsh-remote-install}"
LOG_DIR="$HOME/.dsh-remote-logs"

echo "=== dsh-remote 服务器端安装 ==="
echo "端口: ${PORT}"

# ── 1. 检查 Node ────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node。请先安装 Node.js >= 22:"
  echo "    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "  或使用 nvm:  https://github.com/nvm-sh/nvm"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node 版本过低: $(node --version)，需要 >= 22"
  exit 1
fi
echo "✓ Node $(node --version)"

# ── 2. 安装/更新 dsh ────────────────────────────────────────────────────────
if [ "$UPDATE" = "1" ]; then
  echo "更新 @deepseek-ai/dsh 到最新版 …"
  npm install -g @deepseek-ai/dsh@latest || { echo "✗ 更新失败"; exit 1; }
  echo "✓ dsh 已更新: $(dsh --version 2>/dev/null || echo '版本未知')"
elif command -v dsh >/dev/null 2>&1; then
  echo "✓ dsh 已安装: $(dsh --version 2>/dev/null || echo '版本未知')"
else
  echo "安装 @deepseek-ai/dsh …"
  npm install -g @deepseek-ai/dsh || { echo "✗ 安装失败"; exit 1; }
  echo "✓ dsh 安装完成"
fi

# ── 3. 初始化 web profile（首次会自动初始化）─────────────────────────────────
if [ ! -d "$HOME/.dsh/profiles/web" ]; then
  echo "初始化 web profile …"
  dsh --profile web --help >/dev/null 2>&1 || true
fi

# ── 4. 注册常驻服务 ─────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"

detect_init() {
  if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    echo "systemd-root"
  elif command -v systemctl >/dev/null 2>&1; then
    echo "systemd-user"
  elif [ "$(uname)" = "Darwin" ]; then
    echo "launchd"
  else
    echo "nohup"
  fi
}

INIT="$(detect_init)"
echo "服务方式: ${INIT}"

if [ "$UPDATE" = "1" ]; then
  # 服务已注册（来自之前的安装），只重启以加载新版本
  echo "重启服务加载新版本 …"
  case "$INIT" in
    systemd-root)
      systemctl restart "dsh-web-${PORT}.service"
      ;;
    systemd-user)
      systemctl --user restart "dsh-web-${PORT}.service"
      ;;
    launchd)
      PLIST="$HOME/Library/LaunchAgents/com.dsh.web.${PORT}.plist"
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST"
      ;;
    nohup)
      START_SCRIPT="$INSTALL_DIR/start-dsh-${PORT}.sh"
      if [ -f "$INSTALL_DIR/dsh-web-${PORT}.pid" ]; then
        kill "$(cat "$INSTALL_DIR/dsh-web-${PORT}.pid")" 2>/dev/null || true
        sleep 1
      fi
      "$START_SCRIPT"
      ;;
  esac
  echo "✓ 服务已重启"
else
  case "$INIT" in
  systemd-root)
    UNIT="/etc/systemd/system/dsh-web-${PORT}.service"
    cat > "$UNIT" <<EOF
[Unit]
Description=DSH Web (port ${PORT})
After=network.target

[Service]
User=$(whoami)
WorkingDirectory=$HOME
ExecStart=$(command -v node) $(npm root -g)/@deepseek-ai/dsh/lib/bin.js web --port ${PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "dsh-web-${PORT}.service"
    systemctl start "dsh-web-${PORT}.service"
    echo "✓ systemd 服务已启动: systemctl status dsh-web-${PORT}.service"
    ;;
  systemd-user)
    mkdir -p "$HOME/.config/systemd/user"
    UNIT="$HOME/.config/systemd/user/dsh-web-${PORT}.service"
    cat > "$UNIT" <<EOF
[Unit]
Description=DSH Web (port ${PORT})

[Service]
WorkingDirectory=$HOME
ExecStart=$(command -v node) $(npm root -g)/@deepseek-ai/dsh/lib/bin.js web --port ${PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "dsh-web-${PORT}.service"
    systemctl --user start "dsh-web-${PORT}.service"
    echo "✓ systemd(user) 服务已启动: systemctl --user status dsh-web-${PORT}.service"
    ;;
  launchd)
    PLIST="$HOME/Library/LaunchAgents/com.dsh.web.${PORT}.plist"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.web.${PORT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$(npm root -g)/@deepseek-ai/dsh/lib/bin.js</string>
    <string>web</string>
    <string>--port</string><string>${PORT}</string>
  </array>
  <key>WorkingDirectory</key><string>${HOME}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/dsh-web-${PORT}.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/dsh-web-${PORT}.err.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "✓ launchd 服务已启动: launchctl list | grep com.dsh.web.${PORT}"
    ;;
  nohup)
    START_SCRIPT="$INSTALL_DIR/start-dsh-${PORT}.sh"
    mkdir -p "$INSTALL_DIR"
    cat > "$START_SCRIPT" <<EOF
#!/usr/bin/env bash
cd "$HOME"
exec nohup node $(npm root -g)/@deepseek-ai/dsh/lib/bin.js web --port ${PORT} \\
  >> "$LOG_DIR/dsh-web-${PORT}.log" 2>&1 &
echo \$! > "$INSTALL_DIR/dsh-web-${PORT}.pid"
EOF
    chmod +x "$START_SCRIPT"
    "$START_SCRIPT"
    echo "✓ 已用 nohup 启动 (pid 见 $INSTALL_DIR/dsh-web-${PORT}.pid)"
    echo "  手动重启: bash $START_SCRIPT"
    ;;
  esac
fi

# ── 5. 输出连接信息 ─────────────────────────────────────────────────────────
sleep 2
echo ""
echo "=== 安装完成 ==="
echo "服务器: $(hostname) ($(uname -s))"
echo "远程 dsh web 端口: ${PORT} (仅绑定 127.0.0.1)"
echo ""
echo "本地连接步骤:"
echo "  1. 在本地 dsh-remote 的 servers.json 中添加:"
echo "     { \"name\": \"<名称>\", \"host\": \"<本机IP>\", \"user\": \"$(whoami)\","
echo "       \"sshPort\": 22, \"dshPort\": ${PORT}, \"localPort\": ${PORT} }"
echo "  2. node ~/.dsh/dsh-remote/cli.mjs connect <名称>"
echo "  3. node ~/.dsh/dsh-remote/cli.mjs open <名称>"
echo ""
echo "日志: $LOG_DIR/dsh-web-${PORT}.log"
