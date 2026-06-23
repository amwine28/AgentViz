# AgentViz shell hook (zsh) — opt a terminal IN to AgentViz, on demand.
#
# Install once:  bash ~/dev/AgentViz/scripts/agentviz.sh install
# (that appends a single `source` line for this file to your ~/.zshrc).
#
# Installing does NOT make every terminal show up. Sourcing this only *defines*
# the `agentviz` command and arms inert hooks. A terminal appears as a tab ONLY
# when you run, in that terminal:
#
#     agentviz            # opt THIS terminal in + open the AgentViz window
#     agentviz off        # stop streaming this terminal
#     agentviz status     # is this terminal streaming?
#
# Once opted in, the terminal streams its REAL activity — a live Claude Code
# session if you run `claude` here, otherwise the real commands you type.
# Terminals where you never run `agentviz` stream NOTHING. Every emit is
# backgrounded with a 1s cap and silenced, so it never slows your prompt, and
# does nothing if the relay isn't up. GROUNDED: only real activity, never invented.

_AGENTVIZ_REPO="${AGENTVIZ_HOME:-$HOME/dev/AgentViz}"
_AGENTVIZ_ATTACH="$_AGENTVIZ_REPO/scripts/agentviz-attach.sh"
_AGENTVIZ_LAUNCH="$_AGENTVIZ_REPO/scripts/agentviz.sh"
[ -x "$_AGENTVIZ_ATTACH" ] || return 0
zmodload zsh/datetime 2>/dev/null   # provides $EPOCHSECONDS for honest event timestamps

_agentviz_port() {
  python3 -c "import json;print(json.load(open('$HOME/.agentviz/relay.json'))['port'])" 2>/dev/null
}

# Fire-and-forget POST to the relay; backgrounded so the prompt never waits.
_agentviz_emit() {
  local p; p="$(_agentviz_port)"; [ -z "$p" ] && return 0
  ( curl -s --max-time 1 -X POST "http://localhost:$p/ingest" \
      -H 'Content-Type: application/json' -d "$1" >/dev/null 2>&1 & ) 2>/dev/null
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

# The command you run to opt THIS terminal in (or off). Nothing streams until
# this is called — that's the whole point: every tab is user-invoked.
agentviz() {
  case "$1" in
    off)
      if [ -n "$AGENTVIZ_ON" ]; then
        _agentviz_emit "{\"kind\":\"agent_complete\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"exit_status\":\"ok\",\"summary\":\"detached\"}"
      fi
      unset AGENTVIZ_ON AGENTVIZ_CC AGENTVIZ_CALL
      echo "agentviz: this terminal is no longer streaming."
      return 0 ;;
    status)
      echo "agentviz: ${AGENTVIZ_ON:+streaming}${AGENTVIZ_ON:-off} (session ${AGENTVIZ_SESSION:-none})"
      return 0 ;;
  esac

  # Opt in: stable per-terminal id, register the tab + a "shell" agent, and open
  # the AgentViz window (bootstrapping the relay/UI if needed).
  [ -z "$AGENTVIZ_SESSION" ] && export AGENTVIZ_SESSION="term-${HOST%%.*}-$$-${RANDOM}"
  export AGENTVIZ_ON=1
  ( "$_AGENTVIZ_ATTACH" attach "$AGENTVIZ_SESSION" "${PWD:t}" "$PWD" >/dev/null 2>&1 & ) 2>/dev/null
  ( "$_AGENTVIZ_LAUNCH" >/dev/null 2>&1 & ) 2>/dev/null   # ensures relay + opens/focuses the window
  echo "agentviz: streaming this terminal → it now appears as a tab in the AgentViz window."
}

# Hooks below are INERT unless this terminal opted in (AGENTVIZ_ON set).
_agentviz_preexec() {
  [ -n "$AGENTVIZ_ON" ] || return 0
  local cmd="$1"
  # Running `claude` in an opted-in terminal → live-tail that Claude Code session
  # into this terminal's tab (its agent activity replaces the plain command stream).
  if [[ "$cmd" == claude(|" "*) ]] && [ -z "$AGENTVIZ_CC" ]; then
    export AGENTVIZ_CC=1
    ( "$_AGENTVIZ_ATTACH" tail-cc "$AGENTVIZ_SESSION" "${PWD:t}" "$PWD" >/dev/null 2>&1 & ) 2>/dev/null
  fi
  local now="${EPOCHSECONDS:-$(date +%s)}"
  export AGENTVIZ_CALL="c${now}${RANDOM}"
  local name; name="$(_agentviz_esc "${cmd%% *}")"
  local full; full="$(_agentviz_esc "$cmd")"
  _agentviz_emit "{\"kind\":\"tool_call_pending\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"call_id\":\"$AGENTVIZ_CALL\",\"name\":\"$name\",\"args\":{\"cmd\":\"$full\"},\"timestamp\":$now}"
}

_agentviz_precmd() {
  local ec=$?
  [ -n "$AGENTVIZ_ON" ] || return 0
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
