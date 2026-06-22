#!/bin/bash
# AgentViz launcher — relay up, browser open, optional demo swarm or session replay.
# Usage: agentviz.sh [--demo] [--rebuild] [--no-browser]
#                    [--replay <path-to-claude-code-session.jsonl> [--outcome=1]]
#        agentviz.sh install     # define the `agentviz` command in ~/.zshrc (opt-in per terminal)
#        agentviz.sh uninstall   # remove the shell hook
#        agentviz.sh attach ...  # (internal) register the current terminal
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_FILE="$HOME/.agentviz/relay.json"

# --- subcommands (shell integration) ---------------------------------
# These let the user opt in ONCE so every future terminal becomes a tab.
AGENTVIZ_MARK_BEGIN="# >>> agentviz shell hook >>>"
AGENTVIZ_MARK_END="# <<< agentviz shell hook <<<"

case "${1:-}" in
  install)
    ZSHRC="$HOME/.zshrc"
    if [ -f "$ZSHRC" ] && grep -qF "$AGENTVIZ_MARK_BEGIN" "$ZSHRC"; then
      echo "[agentviz] shell hook already installed in $ZSHRC"
      exit 0
    fi
    {
      echo ""
      echo "$AGENTVIZ_MARK_BEGIN"
      echo "[ -f \"$REPO/scripts/agentviz-shell.zsh\" ] && source \"$REPO/scripts/agentviz-shell.zsh\""
      echo "$AGENTVIZ_MARK_END"
    } >> "$ZSHRC"
    echo "[agentviz] installed the shell hook in $ZSHRC."
    echo "[agentviz] open a new terminal (or: source \"$REPO/scripts/agentviz-shell.zsh\")."
    echo "[agentviz] then, in ANY terminal you want to watch, run:  agentviz"
    echo "[agentviz] only terminals where you run that command appear — nothing is auto-added."
    exit 0
    ;;
  uninstall)
    ZSHRC="$HOME/.zshrc"
    if [ -f "$ZSHRC" ] && grep -qF "$AGENTVIZ_MARK_BEGIN" "$ZSHRC"; then
      # delete the marked block, in place (portable BSD/GNU sed via a temp file)
      sed "/$AGENTVIZ_MARK_BEGIN/,/$AGENTVIZ_MARK_END/d" "$ZSHRC" > "$ZSHRC.agentviz.tmp" \
        && mv "$ZSHRC.agentviz.tmp" "$ZSHRC"
      echo "[agentviz] removed the shell hook from $ZSHRC. Open a new terminal to finish."
    else
      echo "[agentviz] no shell hook found in $ZSHRC"
    fi
    exit 0
    ;;
  attach)
    shift
    exec bash "$REPO/scripts/agentviz-attach.sh" attach "$@"
    ;;
esac

DEMO=0
REBUILD=0
NO_BROWSER=0
REPLAY=""
OUTCOME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --demo) DEMO=1 ;;
    --rebuild) REBUILD=1 ;;
    --no-browser) NO_BROWSER=1 ;;
    --replay) shift; REPLAY="$1" ;;
    --outcome=*) OUTCOME="$1" ;;
  esac
  shift
done

# --- build if needed -------------------------------------------------
if [ "$REBUILD" = 1 ] || [ ! -f "$REPO/ui/dist/index.html" ]; then
  echo "[agentviz] building UI..."
  (cd "$REPO/ui" && npm install --silent && npm run build --silent)
fi
if [ "$REBUILD" = 1 ] || [ ! -f "$REPO/relay/dist/index.js" ]; then
  echo "[agentviz] building relay..."
  (cd "$REPO/relay" && npm install --silent && npm run build --silent)
fi

# --- relay up --------------------------------------------------------
relay_alive() {
  [ -f "$PORT_FILE" ] || return 1
  local pid
  pid=$(python3 -c "import json;print(json.load(open('$PORT_FILE'))['pid'])" 2>/dev/null) || return 1
  kill -0 "$pid" 2>/dev/null
}

if relay_alive; then
  PORT=$(python3 -c "import json;print(json.load(open('$PORT_FILE'))['port'])")
  echo "[agentviz] relay already running on port $PORT"
else
  rm -f "$PORT_FILE"
  echo "[agentviz] starting relay..."
  (cd "$REPO/relay" && nohup node dist/index.js > /tmp/agentviz-relay.log 2>&1 &)
  for _ in $(seq 1 50); do
    relay_alive && break
    sleep 0.1
  done
  if ! relay_alive; then
    echo "[agentviz] relay failed to start — see /tmp/agentviz-relay.log" >&2
    exit 1
  fi
  PORT=$(python3 -c "import json;print(json.load(open('$PORT_FILE'))['port'])")
  echo "[agentviz] relay up on port $PORT"
fi

URL="http://localhost:$PORT"
echo "[agentviz] live 3D world: $URL"

# --- browser ---------------------------------------------------------
if [ "$NO_BROWSER" != 1 ] && [ -z "$AGENTVIZ_NO_BROWSER" ]; then
  open "$URL" 2>/dev/null || true
fi

# --- replay a real Claude Code session -------------------------------
if [ -n "$REPLAY" ]; then
  echo "[agentviz] replaying Claude Code session: $REPLAY"
  exec bash -c "cd '$REPO/relay' && npm run --silent replay -- '$REPLAY' ${OUTCOME}"
fi

# --- demo swarm ------------------------------------------------------
if [ "$DEMO" = 1 ]; then
  echo "[agentviz] launching demo swarm..."
  exec python3 "$REPO/examples/demo_swarm.py"
fi
