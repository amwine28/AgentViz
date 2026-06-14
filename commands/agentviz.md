---
description: Launch the AgentViz live 3D agent world — relay up, browser open, demo optional
allowed-tools: Bash, Read
---

Launch AgentViz.

Arguments: $ARGUMENTS

First locate the AgentViz repo, in this order: the `$AGENTVIZ_HOME` env var, else
`~/AgentViz`, else `~/Desktop/AgentViz`, else the current working directory if it
contains `scripts/agentviz.sh`. Call that `$REPO`. If none exist, ask the user where
they cloned it.

1. Run the launcher:
   - No arguments → `bash "$REPO/scripts/agentviz.sh"`
   - `demo` in arguments → `bash "$REPO/scripts/agentviz.sh" --demo` **as a background task** (the demo swarm runs ~75s; do not block on it)
   - `rebuild` in arguments → add `--rebuild`
2. Read the relay port from the launcher output (or `~/.agentviz/relay.json`) and tell the user the URL (`http://localhost:<port>`). The launcher already opens the browser.
3. If the launcher fails, read `/tmp/agentviz-relay.log` and report the actual error.

Notes for instrumenting the current session's agents: any Python process can join the world with
```python
from agentviz import session  # pip install -e "$REPO/sdk"
s = session(name="my-run")     # auto-discovers the running relay via ~/.agentviz/relay.json
```
Wrap work in `async with s.agent("name") as a:` blocks; use `a.tool_call(...)`, `a.log(...)`, `a.report_usage(...)`, `s.send_message(...)`. Events appear live in the 3D world. Emission is fail-open — a down relay never crashes the wrapped code.
