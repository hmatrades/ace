#!/bin/bash
# ACE daemon launchd installer
#
# Usage: bash scripts/setup-daemon.sh {install | uninstall | status}

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.ace.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="$(which node)"
DAEMON_SCRIPT="${REPO_DIR}/src/daemon.js"

cmd="${1:-install}"

case "$cmd" in
  install)
    if [ ! -x "$NODE_BIN" ]; then
      echo "ERROR: node not found on PATH" >&2
      exit 1
    fi
    if [ ! -f "$DAEMON_SCRIPT" ]; then
      echo "ERROR: daemon script not found at $DAEMON_SCRIPT" >&2
      exit 1
    fi

    mkdir -p "$(dirname "$PLIST_PATH")"
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${DAEMON_SCRIPT}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/.claude/ace.daemon.out.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.claude/ace.daemon.err.log</string>
</dict>
</plist>
EOF

    # Unload first if running (ignore errors)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "✓ ACE daemon installed and started"
    echo "  plist: $PLIST_PATH"
    echo "  log:   $HOME/.claude/ace.log"
    echo "  stop:  bash $0 uninstall"
    ;;

  uninstall)
    if [ -f "$PLIST_PATH" ]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm "$PLIST_PATH"
      echo "✓ ACE daemon uninstalled"
    else
      echo "not installed"
    fi
    ;;

  status)
    if [ -f "$PLIST_PATH" ]; then
      echo "plist: $PLIST_PATH (installed)"
      launchctl list | grep "$LABEL" || echo "not running"
    else
      echo "not installed"
    fi
    node "$DAEMON_SCRIPT" status
    ;;

  *)
    echo "usage: $0 {install|uninstall|status}" >&2
    exit 1
    ;;
esac
