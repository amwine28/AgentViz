<div align="center">

# AgentViz

### Watch your agents think — as a live 3D world you can fly around.

![AgentViz live 3D agent world](docs/assets/agentviz-demo.gif)

*Agents are glowing nodes. Messages pulse along the edges. A tool call waiting on
your approval is an unmissable golden ring. Toggle to a clean 2D graph the moment
you need to actually debug.*

[Quickstart](#quickstart) · [The four views](#the-four-views) · [Efficiency audit](#efficiency-audit) · [SDK](#sdk) · [How it works](#how-it-works)

</div>

---

## Why

Multi-agent systems are invisible. You launch an orchestrator, it spawns workers,
they message each other and call tools — and all you get is a wall of interleaved
log lines. AgentViz turns that stream into something you can **see**: a live world
where structure, timing, and stalls are obvious at a glance.

- **3D is the spectacle** — for demos, for wonder, for understanding shape.
- **2D is the instrument** — a stable graph for serious debugging.
- **FLOW is the story** — a swimlane transcript of who said what, in what order.
- **The audit is the verdict** — a rule-based efficiency score, never a vibe.

Everything renders from a single event stream. Point any Python agents at it, or
drop `/agentviz` into a Claude Code session.

## Quickstart

Two minutes, zero config. Requires Python ≥ 3.11 and Node ≥ 18.

```bash
git clone https://github.com/amwine28/AgentViz.git
cd AgentViz

# install the SDK (editable)
pip install -e sdk

# build + launch the world (starts the relay, opens your browser),
# and fire a choreographed demo swarm so you see it move:
bash scripts/agentviz.sh --demo
```

Your browser opens to the live 3D world and a demo mission begins: three squads
spawn in waves, messages pulse between them, two tool calls wait for **your**
approval (golden rings — approve or deny them in the queue), and one rogue agent
fails dramatically in error-red.

Already have your own agents? See [SDK](#sdk) — it's one context manager.

## The four views

Switch any time with the toggle in the top bar, or press **`V`** to cycle.

| View | For | What you get |
|------|-----|--------------|
| **3D** | wonder, demos | Glowing status-colored nodes in space, message particles, pulsing approval rings, fly-to camera, bloom. |
| **2D** | debugging | Stable force graph. **Edge thickness = message volume, node size = activity.** Hub & bottleneck called out. |
| **FLOW** | causality | Swimlane sequence diagram — one lane per agent, spawn branches, labeled message arrows, tool marks. Noisy runs fold into expandable sections. |
| **Audit** | verdict | An efficiency score with itemized, fact-based findings (lives in the 2D panel). |

## Efficiency audit

Spawning more agents isn't free. AgentViz scores every run **0–100 (A–F)** — and
every point deducted traces to a *verifiable fact in the event stream*, never a
model's opinion:

- **Dead weight** — agents spawned that made no tool calls and sent no messages
  (could fewer agents do the job?)
- **Duplicate roles** — sibling agents that ran identical tool sets (merge candidates)
- **Token skew** — one agent burning >50% of tokens while producing <25% of outputs
- **Denied / timed-out tool calls** and **error exits** — requested work that never ran

Each finding names its rule, the agents involved, and the reason. The whole audit —
plus node feature vectors and weighted edges — exports in one click as
**NetworkX node-link JSON**:

```python
import json, networkx as nx
G = nx.node_link_graph(json.load(open("my-run.graph.json")))
# every agent run is now a graph dataset: feed it to NetworkX, PyTorch Geometric, anything.
```

## Replay a real Claude Code session

Already ran a multi-agent Claude Code session? Watch it play back — in 3D, FLOW, and
with a credit map — straight from its transcript, no instrumentation:

```bash
bash scripts/agentviz.sh --replay ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl --outcome=1
```

This reads the session's top-level JSONL plus its sub-agent sidechain transcripts,
reconstructs the spawn hierarchy and handoffs, and streams them into the live world.
`--outcome=1` attaches the terminal reward (you ran it, you know it passed) so the CREDIT
lens populates. Outcomes are always external — never guessed from the transcript.

On a real converging session (sub-agents reporting back to one orchestrator), the CREDIT
lens will honestly say *"results converge at the orchestrator — reachability is near-useless
here, run counterfactual replay for causal credit"* rather than fabricate per-agent numbers.
That honesty is the point.

## SDK

Wrap any async Python agents. Emission is **fail-open** — a down or slow relay never
stalls or crashes your code; events buffer and reconnect on their own.

```python
import asyncio
from agentviz import session, ToolCallDenied

async def main():
    s = session(name="my-run")        # auto-discovers a running relay
    await s.connect()                 # auto-starts one if none

    async with s.agent("orchestrator") as orch:
        async with s.agent("worker", parent_id=orch.agent_id) as w:
            await w.log("starting work")

            # a tool call the human can approve/deny in the UI.
            # default policy: deny on timeout — never silently approved.
            result = await w.tool_call(
                name="fetch_data",
                args={"source": "api"},
                fn=lambda: {"rows": 42},
                approval_timeout=30,
            )

            await w.report_usage(input_tokens=1200, output_tokens=300,
                                 model="claude-sonnet-4-6", cost_usd=0.012)
            await s.send_message("worker", "orchestrator", "done")

asyncio.run(main())
```

Highlights: `agent.log()`, async tool functions, per-agent token/cost reporting,
and live control from the UI (pause / resume / stop / inject / approve / deny) with
sent → applied/failed acknowledgement.

### `/agentviz` in Claude Code

Copy the slash command into your Claude config so a session's agents appear with
no manual wrapping:

```bash
mkdir -p ~/.claude/commands && cp commands/agentviz.md ~/.claude/commands/
# then in Claude Code:  /agentviz        (or /agentviz demo)
```

## How it works

```
 your agents ──(SDK, fail-open)──▶  relay  ──(WebSocket fan-out)──▶  browser
   Python / Claude Code            (Node, ws)                       (React)
                                        │                               │
                                  50k ring buffer,              one store (reducer)
                                  session-scoped,                      │
                                  auto-port                  ┌─────────┼─────────┐
                                                            3D        2D / FLOW   audit
```

- **One store, four renderers.** A pure reducer over the event stream is the single
  source of truth. 3D (three.js / `3d-force-graph`), 2D (D3), FLOW (SVG), and the
  audit all derive from the same state — no renderer-specific state.
- **Reliability floor.** Per-agent sequence numbers (the UI shows *"N events dropped"*
  rather than rendering a wrong graph), a session-scoped buffer that survives a normal
  run, fail-open emission with bounded buffering and reconnect, and command
  acknowledgements.
- **Auto port.** The relay picks a free port and writes `~/.agentviz/relay.json`; the
  SDK and browser discover it. No hardcoded ports.

## Project layout

```
sdk/      Python SDK (session, agent, fail-open relay client, events)
relay/    Node WebSocket relay (fan-out, session buffer, command routing)
ui/       React app (store + 3D/2D/FLOW renderers, audit, graph export)
examples/ demo_swarm.py, basic_run.py, integration_test.py
scripts/  agentviz.sh launcher
```

## Development

```bash
cd sdk   && python3 -m pytest -q                              # SDK tests
cd relay && npm install && npm test                           # relay tests (jest)
cd ui    && npm install && npm run build && npx vitest run    # UI build + tests
python3 examples/integration_test.py                          # end-to-end, no browser
```

## Status & non-goals

A focused, working visualization-and-live-control tool — built to be an
*interesting project that works*, not infrastructure to depend on. Not in scope:
auth, billing, hosted/SaaS, long-term persistence, or fleet-scale durability.

## License

[MIT](LICENSE) © 2026 Aaron Winegrad
