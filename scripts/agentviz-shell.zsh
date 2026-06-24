# AgentViz shell hook (zsh) — opt a terminal IN to AgentViz, on demand.
#
# Install once:  bash ~/dev/AgentViz/scripts/agentviz.sh install
# (that appends a single `source` line for this file to your ~/.zshrc).
#
# Then, in any terminal you want to watch, run:
#     agentviz            # opt THIS terminal in + open the AgentViz app window
#     agentviz off        # stop streaming this terminal
#     agentviz status     # is this terminal streaming?
#
# Once opted in, the terminal streams its REAL activity — a live Claude Code
# session if you run `claude` here, otherwise the real commands you type. The hook
# is SELF-HEALING: it re-registers automatically if the relay restarts, so a live
# terminal never goes dark. Every emit is backgrounded with a 1s cap and silenced,
# so it never slows your prompt. GROUNDED: only real activity, never invented.

_AGENTVIZ_REPO="${AGENTVIZ_HOME:-$HOME/dev/AgentViz}"
_AGENTVIZ_ATTACH="$_AGENTVIZ_REPO/scripts/agentviz-attach.sh"
_AGENTVIZ_LAUNCH="$_AGENTVIZ_REPO/scripts/agentviz.sh"
[ -x "$_AGENTVIZ_ATTACH" ] || return 0
zmodload zsh/datetime 2>/dev/null   # provides $EPOCHSECONDS for honest event timestamps

# "port|started_at" IFF the relay process is actually alive; empty otherwise.
# Pure sed + kill -0 (no python) so it's cheap enough to run every prompt.
_agentviz_relay_info() {
  local f="$HOME/.agentviz/relay.json"
  [ -f "$f" ] || return 0
  local port pid started
  port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$f" 2>/dev/null)
  pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$f" 2>/dev/null)
  started=$(sed -n 's/.*"started_at":\([0-9]*\).*/\1/p' "$f" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  print -r -- "${port}|${started}"
}

# Fire-and-forget POST to the live relay; backgrounded so the prompt never waits.
_agentviz_emit() {  # $1 = a JSON object OR array of events
  [ -n "$_AGENTVIZ_PORT" ] || return 0
  ( curl -s --max-time 1 -X POST "http://localhost:$_AGENTVIZ_PORT/ingest" \
      -H 'Content-Type: application/json' -d "$1" >/dev/null 2>&1 & ) 2>/dev/null
}

# Keep this terminal registered with the CURRENT relay. Brings a dead/missing
# relay back up, and re-emits the opening session_start+agent_spawn whenever the
# relay is new or restarted (its started_at changed) — so the tab/agent survives
# relay restarts. Cheap when nothing changed. Sets _AGENTVIZ_PORT.
_agentviz_sync() {
  [ -n "$AGENTVIZ_ON" ] || return 0
  local info; info="$(_agentviz_relay_info)"
  if [ -z "$info" ]; then
    _AGENTVIZ_PORT=""; _AGENTVIZ_RELAY_AT=""
    ( "$_AGENTVIZ_ATTACH" ensure >/dev/null 2>&1 & ) 2>/dev/null   # restart it; re-sync next prompt
    return 0
  fi
  _AGENTVIZ_PORT="${info%%|*}"
  local started="${info##*|}"
  [ "$started" = "$_AGENTVIZ_RELAY_AT" ] && return 0   # same relay → already registered
  _AGENTVIZ_RELAY_AT="$started"
  local b n; b="$(git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"; n="${PWD:t}"
  # opening triplet as ONE array → atomic + ordered (no racing curls)
  _agentviz_emit "[{\"kind\":\"session_start\",\"session_id\":\"$AGENTVIZ_SESSION\",\"name\":\"$n\",\"source\":\"shell\",\"cwd\":\"$PWD\",\"git_branch\":\"$b\"},{\"kind\":\"agent_spawn\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"parent_id\":null,\"name\":\"$n\"}]"
}

# Minimal JSON string escaping: backslash, double-quote, drop newlines/tabs.
_agentviz_esc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\t'/ }"
  print -r -- "$s"
}

# Pick up a Claude Code session already running in this dir (newest transcript
# written in the last 3 min) — preexec only catches NEW `claude` launches.
_agentviz_pickup_cc() {
  setopt local_options no_nomatch   # an unmatched *.jsonl glob must not print an error
  local proj t
  proj="$HOME/.claude/projects/${PWD//[^A-Za-z0-9]/-}"
  t="$(ls -t "$proj"/*.jsonl 2>/dev/null | head -1)"
  if [ -n "$t" ] && [ $(( ${EPOCHSECONDS:-$(date +%s)} - $(stat -f %m "$t" 2>/dev/null || echo 0) )) -lt 180 ]; then
    export AGENTVIZ_CC=1
    ( "$_AGENTVIZ_ATTACH" tail-cc "$AGENTVIZ_SESSION" "${PWD:t}" "$PWD" >/dev/null 2>&1 & ) 2>/dev/null
  fi
}

# The command you run to opt THIS terminal in (or off).
agentviz() {
  case "$1" in
    off)
      [ -n "$AGENTVIZ_ON" ] && _agentviz_emit "{\"kind\":\"agent_complete\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"exit_status\":\"ok\",\"summary\":\"detached\"}"
      unset AGENTVIZ_ON AGENTVIZ_CC AGENTVIZ_CALL _AGENTVIZ_RELAY_AT
      echo "agentviz: this terminal is no longer streaming."
      return 0 ;;
    status)
      echo "agentviz: ${AGENTVIZ_ON:+streaming}${AGENTVIZ_ON:-off} (session ${AGENTVIZ_SESSION:-none}, relay port ${_AGENTVIZ_PORT:-none})"
      return 0 ;;
  esac

  [ -z "$AGENTVIZ_SESSION" ] && export AGENTVIZ_SESSION="term-${HOST%%.*}-$$-${RANDOM}"
  export AGENTVIZ_ON=1
  _AGENTVIZ_RELAY_AT=""   # force a (re)register on the sync below

  # SYNCHRONOUSLY ensure the relay is up + open the chromeless app window. Doing
  # this before we emit guarantees a stable relay/port (no cold-start race where
  # two background starts fight over the port and split the events from the UI).
  "$_AGENTVIZ_LAUNCH" --app-window >/dev/null 2>&1

  _agentviz_sync       # register this terminal with the now-running relay
  _agentviz_pickup_cc  # and stream an in-progress Claude Code run, if any
  echo "agentviz: streaming this terminal → see it in the AgentViz app window."
}

# Hooks below are INERT unless this terminal opted in (AGENTVIZ_ON set).
_agentviz_preexec() {
  [ -n "$AGENTVIZ_ON" ] || return 0
  _agentviz_sync   # relay alive + (re)register if it restarted, before we emit
  local cmd="$1"
  if [[ "$cmd" == claude(|" "*) ]] && [ -z "$AGENTVIZ_CC" ]; then
    export AGENTVIZ_CC=1
    ( "$_AGENTVIZ_ATTACH" tail-cc "$AGENTVIZ_SESSION" "${PWD:t}" "$PWD" >/dev/null 2>&1 & ) 2>/dev/null
  fi
  local now="${EPOCHSECONDS:-$(date +%s)}"
  AGENTVIZ_CALL="c${now}${RANDOM}"
  local name full; name="$(_agentviz_esc "${cmd%% *}")"; full="$(_agentviz_esc "$cmd")"
  _agentviz_emit "{\"kind\":\"tool_call_pending\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"call_id\":\"$AGENTVIZ_CALL\",\"name\":\"$name\",\"args\":{\"cmd\":\"$full\"},\"timestamp\":$now}"
}

_agentviz_precmd() {
  local ec=$?
  [ -n "$AGENTVIZ_ON" ] || return 0
  _agentviz_sync
  [ -z "$AGENTVIZ_CALL" ] && return 0
  _agentviz_emit "{\"kind\":\"tool_result\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"call_id\":\"$AGENTVIZ_CALL\",\"result\":$ec,\"duration_ms\":0,\"timestamp\":${EPOCHSECONDS:-$(date +%s)}}"
  unset AGENTVIZ_CALL
}

_agentviz_exit() {
  [ -n "$AGENTVIZ_ON" ] || return 0
  _agentviz_emit "{\"kind\":\"agent_complete\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"exit_status\":\"ok\",\"summary\":\"terminal closed\",\"timestamp\":${EPOCHSECONDS:-$(date +%s)}}"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _agentviz_preexec
add-zsh-hook precmd _agentviz_precmd
add-zsh-hook zshexit _agentviz_exit
