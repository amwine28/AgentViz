# AgentViz — Design Spec
_Date: 2026-05-28_

## Summary

AgentViz is a SaaS platform that makes agentic workflows visible and controllable. Developers instrument their agents with a lightweight SDK; anyone — technical or not — can open a browser and see a live graph of every agent in the run, what they're doing, and what they're saying to each other. From the same UI, users can pause agents, approve tool calls before they fire, inject instructions mid-run, and spawn new agents.

**V1 success criterion:** A developer runs `pip install agentviz`, wraps their agent in one line, and within 2 minutes sees a live graph in their browser with tool call approval working.

---

## Users

| User | Role |
|---|---|
| **Developer** | Installs SDK, instruments agent code, deploys the relay |
| **Operator / stakeholder** | Opens the browser UI to watch, understand, and control a running session |

Developers set it up once. Everyone else just opens a URL.

---

## Architecture

Four layers. V1 ships the first three.

```
┌─────────────────────────────────────────────────────┐
│  Layer 1 — Agent Processes                          │
│  Python agents instrumented with agentviz-py SDK    │
│  Emits events over WebSocket to relay               │
│  Receives control commands back from relay          │
└────────────────────┬────────────────────────────────┘
                     │ WebSocket (bidirectional)
┌────────────────────▼────────────────────────────────┐
│  Layer 2 — Local Relay Server  (localhost:3333)     │
│  Node.js WebSocket server                           │
│  Event bus: fan-out SDK events to all browsers      │
│  Command router: UI commands → correct agent        │
│  Session buffer: in-memory log; late clients catch up│
└──────────┬──────────────────────────┬───────────────┘
           │ WebSocket                │ (v2) HTTPS forward
┌──────────▼───────────┐   ┌─────────▼───────────────┐
│  Layer 3 — Browser   │   │  Layer 4 — Cloud (v2)   │
│  React + force graph │   │  Replay, sharing, auth  │
│  localhost:3333      │   │  billing, team dashboards│
└──────────────────────┘   └─────────────────────────┘
```

The relay is the hub. The SDK connects as a client; browsers connect as clients. The relay fans events out and routes commands back. This means multiple browsers can watch the same session simultaneously without any coordination logic in the SDK.

---

## Layer 1: Python SDK (`agentviz-py`)

### Install & init

```python
pip install agentviz
```

```python
import agentviz

session = agentviz.session(name="finance-run")  # connects to relay at localhost:3333
```

### Wrapping agents

```python
# Declare an agent
with session.agent("cfo-orchestrator") as agent:
    # spawn a child
    with session.agent("ramp-coder", parent="cfo-orchestrator") as child:
        ...
```

### Sending inter-agent messages

```python
session.send_message(
    from_agent="cfo-orchestrator",
    to_agent="ramp-coder",
    content="Code all pending transactions for the Operations department."
)
```

### Tool call approval

```python
# Wrap a tool call — relay notifies UI, blocks until approved or timeout
result = await agent.tool_call(
    name="ramp_edit_transaction",
    args={"id": "txn_9f3a", "category": "SaaS"},
    fn=lambda: ramp_edit_transaction(id="txn_9f3a", category="SaaS")
)
# If denied: raises ToolCallDenied — developer handles it
```

Approval timeout is configurable (default: 30s auto-approve). If the user has approval mode off, `tool_call()` resolves immediately without blocking.

### Event types emitted

| Event | Payload |
|---|---|
| `agent_spawn` | `agent_id`, `parent_id`, `name`, `timestamp` |
| `agent_status` | `agent_id`, `status` (running / waiting / complete / error) |
| `tool_call_pending` | `agent_id`, `call_id`, `name`, `args` |
| `tool_result` | `agent_id`, `call_id`, `result`, `duration_ms` |
| `agent_message` | `from_agent_id`, `to_agent_id`, `content`, `timestamp` |
| `log` | `agent_id`, `content`, `level` |
| `agent_complete` | `agent_id`, `exit_status`, `summary` |

### Control commands received

| Command | Effect |
|---|---|
| `tool_approve` | Resolves pending tool call future |
| `tool_deny` | Rejects pending tool call future with `ToolCallDenied` |
| `agent_pause` | Sets agent into pause state — developer polls `agent.is_paused()` |
| `agent_resume` | Clears pause state |
| `agent_stop` | Raises `AgentStopped` inside the agent context |
| `inject_message` | Delivers a string to `agent.injected_messages` queue |
| `spawn_agent` | Emits `spawn_request` event — developer registers a handler |

---

## Layer 2: Local Relay Server

**Runtime:** Node.js (ships bundled with the Python SDK — `agentviz` auto-starts it on `session()` if not already running).

**Responsibilities:**
- Accept WebSocket connections from SDK clients and browser clients
- Fan out all SDK events to all connected browsers
- Route UI commands to the correct SDK client by `agent_id`
- Maintain an in-memory session buffer (last 1000 events) so browsers that connect mid-session catch up immediately
- Serve the browser UI as static files on `GET /`

**Startup:** The Python SDK spawns the relay as a subprocess on first `session()` call. If port 3333 is already in use (relay already running), it connects to the existing one. Developer can also start it manually: `agentviz relay`.

**No persistence in v1.** Session buffer is in-memory only. Relay exits when the last SDK client disconnects.

---

## Layer 3: Browser UI

**Stack:** React 18, Vite, `d3-force` for the graph layout, plain CSS (no component library — keeps the bundle small and the aesthetic custom).

### Graph canvas

- **Background:** Dark (#0d0d14), subtle dot grid, slight radial gradient — Obsidian-like
- **Layout:** 2D force-directed. Not full 3D — ships 10x faster and reads just as well for a DAG
- **Nodes:** Circles, sized by depth (root is largest). Color = status:
  - Purple + pulse glow = orchestrator / root
  - Blue + pulse = running
  - Green = complete
  - Yellow = waiting / paused
  - Red = error
- **Node label:** agent name below node; small `root` / `child` tag above for depth context
- **Interactions:** scroll to zoom, drag canvas to pan, click node to open detail panel

### Edge types

| Edge | Style |
|---|---|
| Spawn edge | Solid gray line with directional arrow |
| Message edge (orchestrator ↔ agent) | Animated purple dashed line |
| Message edge (agent ↔ agent / peer) | Animated blue dashed line |

Message edges show a **count badge** (e.g., "3 msgs") at the midpoint. Clicking the edge or badge opens the **message thread panel**.

### Message thread panel

Slides in from the right (replaces the node detail panel). Shows:
- Agent names and direction (A ↔ B)
- Chronological message list: sender, recipient, timestamp, full content
- Most recent message highlighted
- Dismiss with ✕ to return to node detail or empty state

### Node detail panel (right sidebar)

Opens on node click. Contains:

1. **Header** — agent name, status badge, elapsed time
2. **Controls** — Pause / Stop / Spawn child (buttons)
3. **Tool calls** — chronological list:
   - Completed: tool name, truncated args, result summary
   - Pending approval: tool name, args, Approve / Deny buttons (highlighted row)
4. **Inject prompt** — textarea + send button at bottom; injects a message into the agent's queue

### Top bar

Session name · live agent count · status dot · Pause All · Stop button

---

## MVP Scope (V1)

### In scope
- Python SDK (`agentviz-py`) — all event types, tool call approval, inter-agent messaging
- Local relay server — auto-started by SDK, serves browser UI
- Browser UI — graph, node detail panel, message thread, control surface
- Install-to-graph in under 2 minutes

### Explicitly out of scope (v2+)
- TypeScript / JavaScript SDK
- Claude Code hook auto-instrumentation (zero-code setup)
- Cloud sync and shareable session URLs
- Session replay and history
- Auth, billing, team dashboards
- 3D graph rendering

---

## Data Flow: Tool Call Approval

```
Agent calls agent.tool_call(name, args, fn)
  → SDK emits tool_call_pending to relay
  → SDK blocks on asyncio.Future
    → Relay fans event to all browser clients
      → UI highlights pending row, shows Approve / Deny
        → User clicks Approve
          → Browser sends tool_approve{call_id} to relay
            → Relay routes to SDK client
              → SDK resolves Future
                → fn() executes
                  → SDK emits tool_result
```

If timeout elapses before user action: Future auto-resolves (approve). Configurable via `session(approval_timeout=30)`.

---

## Business Model

| Tier | What you get | Price |
|---|---|---|
| **Local (free)** | Full SDK + relay + UI, unlimited local sessions | Free forever |
| **Cloud (paid)** | Shareable session URLs, replay, team dashboards, multi-user control | Subscription (v2) |

Free tier drives developer adoption. Cloud tier is where recurring revenue lives — teams want to share sessions with non-technical stakeholders without everyone needing a local relay.

---

## Open Questions (resolved before v2)

- What format does `spawn_agent` use when triggered from the UI? (Likely: agent name + prompt string, developer registers a factory handler)
- Should the relay persist sessions to disk optionally in v1, even without cloud? (Nice-to-have, not blocking)
- Package name: `agentviz` on PyPI or `agentviz-py`?
