# AgentViz shell hook (zsh) — turn every terminal into a live AgentViz tab.
#
# Install once:  bash ~/dev/AgentViz/scripts/agentviz.sh install
# (that appends a single `source` line for this file to your ~/.zshrc).
#
# From then on, every new terminal:
#   • registers its own tab (named after the working directory), and
#   • streams its REAL activity — a live Claude Code session if you run `claude`
#     here, otherwise the real commands you type.
#
# Fail-open by design: every emit is backgrounded with a 1s cap and silenced, so
# it NEVER slows your prompt, and if the AgentViz relay isn't running nothing
# happens. GROUNDED: only real commands/sessions are shown — nothing invented.

_AGENTVIZ_REPO="${AGENTVIZ_HOME:-$HOME/dev/AgentViz}"
_AGENTVIZ_ATTACH="$_AGENTVIZ_REPO/scripts/agentviz-attach.sh"
[ -x "$_AGENTVIZ_ATTACH" ] || return 0

# A stable identity + tab for THIS terminal, for its whole lifetime.
if [ -z "$AGENTVIZ_SESSION" ]; then
  export AGENTVIZ_SESSION="term-${HOST%%.*}-$$-${RANDOM}"
fi

_agentviz_port() {
  python3 -c "import json;print(json.load(open('$HOME/.agentviz/relay.json'))['port'])" 2>/dev/null
}

# Fire-and-forget POST to the relay; backgrounded so the prompt never waits.
_agentviz_emit() {
  local p; p="$(_agentviz_port)"; [ -z "$p" ] && return 0
  ( curl -s --max-time 1 -X POST "http://localhost:$p/ingest" \
      -H 'Content-Type: application/json' -d "$1" >/dev/null 2>&1 & ) 2>/dev/null
}

# Minimal JSON string escaping: backslash, double-quote, and drop newlines/tabs.
# A command we can't cleanly escape just yields a dropped event (the relay
# ignores malformed JSON) — never fake data, never a broken prompt.
_agentviz_esc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\t'/ }"
  print -r -- "$s"
}

# One-time registration for this shell (tab + a "shell" agent to hang commands on).
if [ -z "$AGENTVIZ_ATTACHED" ]; then
  export AGENTVIZ_ATTACHED=1
  ( "$_AGENTVIZ_ATTACH" attach "$AGENTVIZ_SESSION" "${PWD:t}" "$PWD" >/dev/null 2>&1 & ) 2>/dev/null
fi

_agentviz_preexec() {
  local cmd="$1"
  # Running `claude` here? Start live-tailing that Claude Code session into this
  # terminal's tab (its agent activity replaces the plain command stream).
  if [[ "$cmd" == claude(|" "*) ]] && [ -z "$AGENTVIZ_CC" ]; then
    export AGENTVIZ_CC=1
    ( "$_AGENTVIZ_ATTACH" tail-cc "$AGENTVIZ_SESSION" "${PWD:t}" "$PWD" >/dev/null 2>&1 & ) 2>/dev/null
  fi
  export AGENTVIZ_CALL="c${EPOCHSECONDS:-$(date +%s)}${RANDOM}"
  local name; name="$(_agentviz_esc "${cmd%% *}")"
  local full; full="$(_agentviz_esc "$cmd")"
  _agentviz_emit "{\"kind\":\"tool_call_pending\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"call_id\":\"$AGENTVIZ_CALL\",\"name\":\"$name\",\"args\":{\"cmd\":\"$full\"}}"
}

_agentviz_precmd() {
  local ec=$?
  [ -z "$AGENTVIZ_CALL" ] && return 0
  _agentviz_emit "{\"kind\":\"tool_result\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"call_id\":\"$AGENTVIZ_CALL\",\"result\":$ec,\"duration_ms\":0}"
  unset AGENTVIZ_CALL
}

_agentviz_exit() {
  _agentviz_emit "{\"kind\":\"agent_complete\",\"session_id\":\"$AGENTVIZ_SESSION\",\"agent_id\":\"shell\",\"exit_status\":\"ok\",\"summary\":\"terminal closed\"}"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _agentviz_preexec
add-zsh-hook precmd _agentviz_precmd
add-zsh-hook zshexit _agentviz_exit
