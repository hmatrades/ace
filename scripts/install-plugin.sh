#!/bin/bash
# ACE Claude Code hook installer
#
# Adds SessionStart + UserPromptSubmit hooks to ~/.claude/settings.local.json
# so Claude sees the $ACE block on every session boot.
#
# Usage: bash scripts/install-plugin.sh {install | uninstall | status}

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_SCRIPT="${REPO_DIR}/plugin/hooks/ace-hook.js"
SETTINGS_PATH="$HOME/.claude/settings.local.json"
NODE_BIN="$(which node)"

cmd="${1:-install}"

require_node() {
  if [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: node not found on PATH" >&2
    exit 1
  fi
}

case "$cmd" in
  install)
    require_node
    if [ ! -f "$HOOK_SCRIPT" ]; then
      echo "ERROR: hook script missing at $HOOK_SCRIPT" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$SETTINGS_PATH")"

    # Merge hooks into existing settings.local.json using node (handles JSON safely)
    $NODE_BIN -e "
      const fs = require('fs');
      const path = '$SETTINGS_PATH';
      let s = {};
      try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
      s.hooks = s.hooks || {};

      const ctx = {
        matcher: 'startup|clear|compact',
        hooks: [{ type: 'command', command: 'node \"$HOOK_SCRIPT\" context', timeout: 15 }],
      };
      const up = {
        hooks: [{ type: 'command', command: 'node \"$HOOK_SCRIPT\" user-prompt', timeout: 10 }],
      };

      s.hooks.SessionStart = (s.hooks.SessionStart || []).filter(h =>
        !(h.hooks||[]).some(e => (e.command||'').includes('ace-hook.js'))
      );
      s.hooks.SessionStart.push(ctx);

      s.hooks.UserPromptSubmit = (s.hooks.UserPromptSubmit || []).filter(h =>
        !(h.hooks||[]).some(e => (e.command||'').includes('ace-hook.js'))
      );
      s.hooks.UserPromptSubmit.push(up);

      fs.writeFileSync(path, JSON.stringify(s, null, 2));
      console.log('✓ ACE hooks added to ' + path);
    "
    echo ""
    echo "Next session start will include a \$ACE block at the top of Claude's context."
    echo "Uninstall:  bash $0 uninstall"
    ;;

  uninstall)
    require_node
    if [ ! -f "$SETTINGS_PATH" ]; then
      echo "nothing to uninstall — $SETTINGS_PATH missing"
      exit 0
    fi
    $NODE_BIN -e "
      const fs = require('fs');
      const path = '$SETTINGS_PATH';
      const s = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (s.hooks) {
        for (const ev of Object.keys(s.hooks)) {
          s.hooks[ev] = (s.hooks[ev] || []).filter(h =>
            !(h.hooks||[]).some(e => (e.command||'').includes('ace-hook.js'))
          );
          if (!s.hooks[ev].length) delete s.hooks[ev];
        }
      }
      fs.writeFileSync(path, JSON.stringify(s, null, 2));
      console.log('✓ ACE hooks removed');
    "
    ;;

  status)
    if [ ! -f "$SETTINGS_PATH" ]; then
      echo "no settings.local.json — ACE not installed"
      exit 0
    fi
    grep -q "ace-hook.js" "$SETTINGS_PATH" && echo "✓ ACE hooks installed in $SETTINGS_PATH" || echo "✗ ACE hooks not installed"
    ;;

  *)
    echo "usage: $0 {install|uninstall|status}" >&2
    exit 1
    ;;
esac
