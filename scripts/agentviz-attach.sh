#!/bin/bash
# AgentViz per-terminal attach helper.
#
# Called by the shell hook (scripts/agentviz-shell.zsh), not usually by hand.
# Registers THIS terminal as an AgentViz tab and — if a Claude Code session is
# running here — live-tails its transcript into that tab. Bootstraps the relay
# if it isn't already up. Everything is fail-open and silent: if AgentViz can't
# start, your shell is unaffected.
#
# GROUNDED: we only ever stream real activity (a real transcript, real commands).
# A terminal that never ran the hook shows nothing.
#
# Subcommands:
#   attach  <session> <name> [cwd]   register the tab + a "shell" agent
#   tail-cc <session> <name> [cwd]   wait for this cwd's CC transcript, then tail it
#   emit    <json>                   POST one event to the relay (fire-and-forget)
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_FILE="$HOME/.agentviz/relay.json"
SUB="${1:-attach}"

relay_port() { python3 -c "import json;print(json.load(open('$PORT_FILE'))['port'])" 2>/dev/null; }
relay_alive() {
  [ -f "$PORT_FILE" ] || return 1
  local pid
  pid=$(python3 -c "import json;print(json.load(open('$PORT_FILE'))['pid'])" 2>/dev/null) || return 1
  kill -0 "$pid" 2>/dev/null
}
ensure_relay() {
  relay_alive && return 0
  # --no-browser: a background attach must not pop a window open.
  bash "$REPO/scripts/agentviz.sh" --no-browser >/dev/null 2>&1 || true
}
emit() { # $1 = JSON event — fire-and-forget, never blocks the caller
  local port; port="$(relay_port)"; [ -z "$port" ] && return 0
  curl -s --max-time 1 -X POST "http://localhost:$port/ingest" \
    -H 'Content-Type: application/json' -d "$1" >/dev/null 2>&1 || true
}
project_dir() { printf '%s/.claude/projects/%s' "$HOME" "$(printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g')"; }

case "$SUB" in
  attach)
    SID="$2"; NAME="$3"; CWD="${4:-$PWD}"
    [ -z "$SID" ] && exit 0
    ensure_relay
    BRANCH="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    emit "{\"kind\":\"session_start\",\"session_id\":\"$SID\",\"name\":\"$NAME\",\"source\":\"shell\",\"cwd\":\"$CWD\",\"git_branch\":\"$BRANCH\"}"
    emit "{\"kind\":\"agent_spawn\",\"session_id\":\"$SID\",\"agent_id\":\"shell\",\"parent_id\":null,\"name\":\"$NAME\"}"
    ;;

  tail-cc)
    SID="$2"; NAME="$3"; CWD="${4:-$PWD}"
    [ -z "$SID" ] && exit 0
    ensure_relay
    PROJ="$(project_dir "$CWD")"
    # The transcript is created a beat after `claude` launches — wait briefly.
    T=""
    for _ in $(seq 1 20); do
      # shellcheck disable=SC2012
      T="$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1)"
      [ -n "$T" ] && break
      sleep 0.5
    done
    [ -z "$T" ] && exit 0   # no transcript → nothing to tail (grounded: no invention)
    BRANCH="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    cd "$REPO/relay"
    exec npx ts-node --transpile-only src/tail-claude-code.ts \
      --transcript "$T" --session "$SID" --name "$NAME" --cwd "$CWD" --branch "$BRANCH"
    ;;

  emit)
    emit "$2"
    ;;

  *)
    echo "usage: agentviz-attach.sh {attach|tail-cc|emit} ..." >&2
    exit 1
    ;;
esac
