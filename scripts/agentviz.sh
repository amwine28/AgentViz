#!/bin/bash
# AgentViz launcher — relay up, browser open, optional demo swarm.
# Usage: agentviz.sh [--demo] [--rebuild] [--no-browser]
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_FILE="$HOME/.agentviz/relay.json"
DEMO=0
REBUILD=0
NO_BROWSER=0

for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=1 ;;
    --rebuild) REBUILD=1 ;;
    --no-browser) NO_BROWSER=1 ;;
  esac
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

# --- demo swarm ------------------------------------------------------
if [ "$DEMO" = 1 ]; then
  echo "[agentviz] launching demo swarm..."
  exec python3 "$REPO/examples/demo_swarm.py"
fi
