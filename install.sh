#!/bin/bash
# ACE — one-command installer
#
# Installs:
#   1. `flag` CLI globally via npm link
#   2. Claude Code hook (SessionStart $ACE block)
#   3. launchd daemon (auto-ingest from claude-mem)
#
# Usage: bash install.sh [--no-daemon] [--no-hook]

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WITH_DAEMON=1
WITH_HOOK=1

for arg in "$@"; do
  case "$arg" in
    --no-daemon) WITH_DAEMON=0 ;;
    --no-hook)   WITH_HOOK=0 ;;
    -h|--help)
      echo "usage: bash install.sh [--no-daemon] [--no-hook]"
      exit 0
      ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "  ACE installer"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# 1. npm install + link
echo "▸ installing dependencies..."
cd "$REPO_DIR"
npm install --silent

echo "▸ linking \`flag\` CLI globally..."
npm link >/dev/null 2>&1 || {
  echo "  npm link failed — you may need 'sudo npm link' on some systems."
  echo "  As a fallback, symlinking to ~/.local/bin"
  mkdir -p ~/.local/bin
  ln -sf "$REPO_DIR/src/flag.js" ~/.local/bin/flag
  chmod +x "$REPO_DIR/src/flag.js"
}

# 2. Hook
if [ "$WITH_HOOK" = "1" ]; then
  echo "▸ installing Claude Code hook..."
  bash "$REPO_DIR/scripts/install-plugin.sh" install
fi

# 3. Daemon
if [ "$WITH_DAEMON" = "1" ]; then
  echo "▸ installing auto-ingest daemon..."
  bash "$REPO_DIR/scripts/setup-daemon.sh" install
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ACE installed ✓"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  CLI:    flag top"
echo "  Ingest: flag ingest \"your observation here\""
echo "  Graph:  flag graph outreach"
echo "  Docs:   $REPO_DIR/README.md"
echo ""
echo "  Flag store:    ~/.claude/flags.json"
echo "  Notes dir:     ~/.claude/notes/"
echo "  Daemon log:    ~/.claude/ace.log"
echo ""
echo "  Start a new Claude Code session to see the \$ACE block in action."
echo ""
