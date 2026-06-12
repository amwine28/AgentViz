# AgentViz Roadmap
*Synthesized from 5 stress-test user personas: non-technical stakeholder, first-time developer, senior ML engineer, UI/UX designer, startup founder*

---

## Strategic Summary

AgentViz is not primarily an observability tool. It is the only **agent control plane** in the market: a synchronous, in-the-loop approval gate that blocks tool execution until a human decides. Once a team wraps destructive tool calls in `agent.tool_call()`, AgentViz is in their critical path — not a logging sidecar. That is the moat. LangSmith answers "what did the agent do?" AgentViz answers "should the agent be allowed to do this, right now?"

Every priority below flows from that insight: fix what makes the control surface dangerous to use (Tier 0), then build what makes it viral (Tier 1), then build what makes it irreplaceable (Tier 2).

---

## Tier 0 — Critical Fixes (before any marketing)
*These are bugs or UX failures that make the product dangerous or broken in its core use case.*

### 0.1 Approval UX is unsafe for real-world use
**Sources:** UX designer (§1–4), non-technical stakeholder

The three worst issues, in order of severity:

1. **Pending approvals are invisible at the graph level.** A node with a pending tool-call looks identical to one that's happily running (both blue, `Graph.tsx:114`). To find a pending approval you must click every node one at a time. With 8+ agents and a 30-second timeout this guarantees misses.
   - Fix: Add a pulsing amber halo to nodes with `tool_calls.some(tc => tc.pending)` in `Graph.tsx`.
   - Add a "⚠ N approvals pending" badge to `TopBar` that selects the oldest pending agent when clicked.

2. **Tool-call args are unreadable.** Args render as a truncated single-line JSON blob in 9px gray (`NodeDetailPanel.tsx:47-49`). You cannot read what you're approving.
   - Fix: `JSON.stringify(tc.args, null, 2)` in a `max-height` scroll box with `whiteSpace: "pre-wrap"`, larger font.

3. **Approve/Deny buttons are 9px, adjacent, and have no confirmation on Deny.** Misclicking Approve on a destructive action is a real risk.
   - Fix: Increase to 12px+, add spacing between buttons. Add `window.confirm` on Stop All (`TopBar.tsx:27`).

4. **No timeout countdown.** The 30-second approval clock (`approval_timeout`) is invisible in the UI. Operators don't know if they have 28 seconds or 2.
   - Fix: Show elapsed time in the tool-call row once `pending: true`, computed from `timestamp`.

5. **The two side panels are mutually exclusive** (`store.ts:38-41`). Opening a message thread for context closes the approval panel. You can never see both at once.
   - Fix: Allow both panels to be pinned simultaneously, or add a persistent "Approvals" strip above the main panel.

### 0.2 Tool errors are silently swallowed
**Source:** senior ML engineer (Scale #9), first-time developer

`agent.py:102` — if `fn()` raises, no event is emitted. The agent errors out but the browser sees nothing. This makes production debugging impossible.
- Fix: Wrap `fn()` in try/except, emit a `tool_result` with `error: true` and the exception message.

### 0.3 The 1000-event ring buffer corrupts long runs
**Source:** senior ML engineer (Scale #1)

`buffer.ts` silently evicts the oldest events past 1000. A 21-agent run producing 2,000–5,000 events means `agent_spawn` events are gone by run end. Any browser connecting mid-run or refreshing gets a catch-up payload where half the agents never existed — the reducer silently drops every tool/status/complete event for missing agents (`store.ts:64-66`). The graph degrades over time.
- Immediate fix: Increase buffer to 10,000 as a stopgap.
- Real fix: Persistence (Tier 1.1).

### 0.4 Logs and completion summaries are captured and discarded
**Source:** UX designer (§Information Architecture), non-technical stakeholder

`agent.logs` is populated in `store.ts` but no component renders it. `agent_complete.summary` is dropped in the reducer (`store.ts:114-119`). The richest diagnostic data in the system is thrown away.
- Fix: Add a "Logs" section to `NodeDetailPanel` (colored by level). Store and render `summary` on completed nodes.

### 0.5 Distribution is broken outside the dev repo
**Source:** first-time developer

`pip install agentviz` works but the relay auto-start (`session.py:28-31`) hardcodes `["node", "dist/index.js"]` relative to `__file__`. This path doesn't exist in any installed package. Users get a confusing crash instead of a helpful error.
- Fix: Bundle the relay binary in the Python package, or add an `agentviz relay` CLI command that finds the right path.
- Fix: Add a `README.md` with a 5-step quick-start. The current "open localhost:3333 in your browser" instruction assumes the UI was already built.

---

## Tier 1 — High Impact (next 6 weeks)
*These turn AgentViz from a demo into a product people pay for.*

### 1.1 Cloud relay + shareable persistent session URLs
**Sources:** startup founder (#1), senior ML engineer (Reliability §), first-time developer

This is both the first revenue feature and the #1 viral moment. The demo: dev runs a local agent, pastes a session URL in Slack, their PM watches the graph live and approves a tool call from their phone. That screen-recording is what gets shared.

Architecturally cheap because:
- The UI is already a pure reducer over an event stream (`store.ts`). A reconnecting viewer already works via the buffer catch-up path (`relay.ts:40-43` + `batch_events` in the store).
- You just need to persist the buffer to a durable store (SQLite to start) and host the relay.

Required pieces:
- `run_id` on every session (today's relay has no identity — two concurrent runs interleave into one graph)
- Durable event log (append-only, keyed by `run_id`)
- Hosted relay endpoint that replaces `ws://localhost:3333`
- Auth + shareable URLs with read-only vs. approve-access roles

### 1.2 Global Approvals Inbox
**Sources:** UX designer (#1 feature), non-technical stakeholder, senior ML engineer

A persistent panel (or primary view) listing every pending approval across all agents: agent name, tool name, pretty-printed args, live countdown ring, big Approve/Deny buttons. Sorted by time-to-expiry. This is the feature that makes AgentViz a cockpit for supervised AI, not just a pretty graph.

The data is already in the store (`agents[*].tool_calls.filter(tc => tc.pending)`). This is mostly a rendering job.

### 1.3 One-line auto-instrumentation for LangGraph and CrewAI
**Sources:** startup founder (#2), first-time developer, senior ML engineer (Integration §)

The current manual `agent.tool_call(name, args, fn)` wrapping requires rewriting every tool call site. Auto-instrumentation is the difference between 200 and 20,000 stars.

- LangGraph: a `BaseCallbackHandler` subclass that emits spawn/message/tool events automatically
- CrewAI: a task/agent wrapper
- OpenAI Agents SDK: a lifecycle hook

Goal: `import agentviz; agentviz.auto()` — zero manual instrumentation, full event stream.

### 1.4 Global Activity Feed (Event Stream view)
**Sources:** UX designer (#2 feature), non-technical stakeholder, senior ML engineer (§Missing Observability)

A reverse-chronological stream of every event (spawn, message, tool call, result, error, complete) with relative timestamps ("3m ago"), severity coloring, and filter chips (errors only, approvals only, one agent). You already pipe every event through one reducer. This is the view that answers "what just happened in the last 60 seconds" and replaces "click each node one at a time."

### 1.5 Agent Cards view (toggleable alternative to the graph)
**Sources:** UX designer (#3 feature), non-technical stakeholder

A grid of agent cards: name, status pill, current tool call, last log line, pending-approval badge, duration. Sortable/filterable. For 10+ agents this is dramatically more scannable than a physics simulation, and it's where operators live during a real run. Make graph vs. cards a top-level toggle.

### 1.6 AI-assisted run summaries + exportable audit log
**Sources:** startup founder (#3), senior ML engineer (§Missing Observability), non-technical stakeholder

At session end, pass the event stream through an LLM: "3 agents, 14 tool calls, 1 denied (refund > $500), completed in 4m." The dev doesn't need this. The dev's manager does, and the manager holds the budget. AI summaries convert a dev tool into a management tool.

The audit log (who approved/denied what, when, result) is the compliance line item that gets enterprise teams to pay. Append-only, exportable, tied to `run_id`. Structurally free given event-sourcing.

---

## Tier 2 — Moat & Growth (v3)
*Category-defining features that no competitor has.*

### 2.1 Branching Replay ("what if I'd denied that?")
**Sources:** startup founder (the keynote feature), senior ML engineer (#1 new feature), UX designer (#6 feature)

Persist the event log → replay through the existing reducer → fork at any tool-call decision point → re-run with a different approval choice. "Time-travel debugging for agents." You turn "our agent almost dropped a prod table" into a runnable counterfactual. No agent tool has this. It's a conference keynote and a tweet that writes itself.

Only possible once persistence lands (1.1). Save this for the fundraising demo.

### 2.2 Approval Policies (auto-approve rules)
**Sources:** startup founder (v3 vision), senior ML engineer (Scale #6)

Rules engine: "auto-approve refunds < $100, require human for > $500, always deny DROP TABLE." Role-based approval (only Finance can approve Ramp edits). This turns AgentViz from a UI tool into a **policy engine for agent actions** — the IAM layer for autonomous AI. When this ships, you're not a dashboard anymore; you're infrastructure.

### 2.3 Per-agent timeline / flamegraph with critical path
**Sources:** senior ML engineer (#1 missing feature), UX designer (#5 feature)

Swim-lane timeline where each agent is a row, each tool call is a span with real start/end, and the critical path through parallel workers is highlighted. This answers "which agent was the bottleneck and why" — the primary use case for teams running 20+ parallel workers. LangSmith doesn't do this well. A real differentiator.

### 2.4 OpenTelemetry ingest/export
**Source:** senior ML engineer (Integration §)

Import OTLP spans as AgentViz events; export AgentViz events as OTLP. Drops into existing Honeycomb/Grafana stacks instead of being a silo. Table stakes for enterprise adoption.

### 2.5 Framework adapters
**Sources:** senior ML engineer, startup founder

Pre-built instrumentation for LangChain, LangGraph, CrewAI, AutoGen, OpenAI Agents SDK. Every serious competitor ships these. Without them, every new user has to hand-instrument their call sites.

### 2.6 Cost & token tracking
**Sources:** senior ML engineer (§Missing), startup founder

Token usage, model name, cost-per-run as first-class event fields. Live running cost in the TopBar. Per-agent cost rollups. Cost delta between runs. This is the "LLM-native" observability that makes AgentViz the right tool for LLM-powered agents specifically.

---

## UI Quick Wins (1–2 days each, high visibility)

From the UX designer's audit — all mapped to exact files:

| Fix | File | Impact |
|-----|------|--------|
| Pending-approval halo on nodes | `Graph.tsx:114` | Findability of blocked agents |
| Pending count + click-to-jump in TopBar | `App.tsx`, `TopBar.tsx:23` | Triage at a glance |
| Pretty-print tool args (JSON.stringify null,2 + scroll box) | `NodeDetailPanel.tsx:47-49` | Readable approvals |
| Render `agent.logs` in NodeDetailPanel | `NodeDetailPanel.tsx` | Diagnostic visibility |
| Store + render `agent_complete.summary` | `store.ts:114-119` + `NodeDetailPanel` | Know what agents concluded |
| Separate `paused` color from `waiting` | `Graph.tsx:18-19` | Two states look the same today |
| Confirm dialog on Stop All | `TopBar.tsx:27` | Prevent accidental kills |
| Bigger Approve/Deny buttons, more separation | `NodeDetailPanel.tsx:102-103` | Prevent dangerous misclicks |
| Fix close button contrast (`#333` → `#888`) | `NodeDetailPanel.tsx:100`, `MessageThread.tsx:19` | Invisible today |
| Brighten spawn edges (`#2d2d4e` → visible) | `Graph.tsx:72,90` | Hierarchy invisible today |
| Wide invisible hit-target on message edges | `Graph.tsx:87-106` | 1.5px line is unclickable |
| Relative timestamps in MessageThread | `MessageThread.tsx:32` | "3m ago" vs clock math |
| Cmd+Enter to send inject | `NodeDetailPanel.tsx:72` | Keyboard workflow |
| Show elapsed time on pending tool calls | `NodeDetailPanel.tsx` | Countdown urgency |
| Node status as fill, not stroke | `Graph.tsx:119-121` | Status is too subtle today |
| Switch default layout from force to d3.tree | `Graph.tsx` | Stable positions for DAGs |

---

## SDK Gaps (raised by first-time developer + senior ML engineer)

| Gap | Fix |
|-----|-----|
| `agent.log()` method missing | Expose it — `LogEvent` exists in `events.py` but `Agent` has no `.log()` method |
| `tool_call` doesn't accept `async fn` | Accept both sync and async callables, `await` if coroutine |
| Non-serializable tool results crash | Wrap args/result in try/except with fallback `str()` before JSON serialization |
| No reconnect on relay disconnect | Add backoff reconnect in `RelayClient._listen` |
| `fn()` blocks the event loop | Document `fn` should be sync + fast; alternatively accept `async fn` and `await` it |
| Auto-approve-on-timeout is indistinguishable from human approval | Add `approval_source: "human" | "timeout"` to `ToolResultEvent` |
| No `run_id` on session | Add to `Session`, include in every event |

---

## Pricing Framework (when cloud ships)

**Free (local, forever):** Full SDK + relay + UI, unlimited local sessions, single-user, no persistence. This is the adoption engine — do not nerf it.

**Team (~$25–40/seat/month):** Cloud relay, shareable URLs, session persistence + replay, multiplayer presence, AI run summaries, Slack/email approval notifications, 90-day history. Priced per *viewer/approver*, not per developer — value is letting non-devs into the loop.

**Enterprise (custom):** SSO/SAML, RBAC on approvals, policy engine, immutable/exportable audit trail, unlimited retention, on-prem relay, SOC 2.

The free/paid boundary falls along a natural technical line: the local relay terminates when the Python process exits. Persistence and sharing are inherently cloud problems. No artificial feature gating needed.

---

## The 3 Things to Build Next (if 2 engineers, 6 weeks)

1. **Cloud relay + shareable persistent session URLs** (1.1) — unlocks all revenue; architecturally cheap given event-sourcing; the viral moment.
2. **One-line auto-instrumentation for LangGraph + CrewAI** (1.3) — 10x top-of-funnel; turns setup from "refactor my agent" to "add one import."
3. **Global Approvals Inbox + fix approval UX** (0.1 + 1.2) — converts the control surface from dangerous-demo to something you'd trust in production.

Save branching replay (2.1) for the fundraising keynote. Build the foundation (#1) that makes it possible first.
