# Multi-Agent Credit Assignment Under Sparse Reward

**Status:** Design (single source of truth) · **Owner:** lead designer · **Audience:** AgentViz maintainers across sessions
**Revision:** 2 (post adversarial review — addresses all critical/major issues from three review lenses)
**Scope:** A grounded credit-assignment capability layered onto AgentViz's existing event-sourced pipeline (SDK `events.py` → `relay_client.py` (seq-stamp) → relay (fan-out) → `store.ts` reducer → pure read-only views `audit.ts` / `graph.ts` / `flow.ts`).

---

## 0. What Changed in Revision 2 (review response)

This revision corrects mathematical and code-fit errors found in adversarial review. The grounding spine, the necessary-vs-causal honesty call, the distribution-not-scalar treatment, and the TDD slicing were praised and are preserved. The substantive corrections:

- **Shapley axioms (critical).** The previous draft claimed "DAG-feasible coalitions" yields the unique value satisfying the four *classic* axioms. That is false — restricting to precedence-feasible coalitions computes the **precedence-constrained Shapley value (Faigle–Kern 1992)**, a *different* solution concept with a *modified* axiom set. §3.3 now states the estimand precisely and offers two honest options.
- **Estimator bias (critical).** "Unbiased Monte-Carlo over DAG-feasible permutations" was wrong twice: (a) it targets a different estimand than classic Shapley; (b) uniformly sampling linear extensions of a poset is #P-hard, so a naive generator is biased even for the constrained value. §3.3 now specifies the sampler and the estimand they must match.
- **TMC is not free (critical).** Truncation introduces bias controlled by tolerance τ. The word "unbiased" is removed from any composed estimator that includes TMC.
- **Efficiency residual is not a real check (critical).** With shared per-permutation `v`-draws and no truncation it is **0 by construction** — it cannot detect sampler/estimand bugs. §3.3 relabels it and defines the fresh-sample version that *is* a real check.
- **FLOW integration is real work (critical).** Adding `"outcome"` to `NARRATIVE_KINDS` alone is a no-op: `buildFlowLayout` has `default: break` and run-level outcomes have no lane. §2.1.4 / §4.3 now specify the `flow.ts` + `FlowView.tsx` edits and the run-level lane convention.
- **DAG must filter ghost edges (critical).** `store.ts` stores `messageEdges` unconditionally; `graph.ts` filters with `idSet.has()` + self-loop skip. `credit.ts` must replicate this or reverse-BFS traverses phantom nodes. §2.3 / §3.1 now mandate it.
- **seq-stamper location (critical/major).** seq is stamped in the SDK `relay_client.py:_stamp_seq`, **not** the relay. Every reference is corrected. Ingested events (§5) bypass it and must replicate the per-key counter or carry no seq.
- **Topology inversion (critical).** In the real demo, messages converge **upward** to the root orchestrator (`mission-control`). Leaf-seeded reverse-BFS finds nothing; root-seeded makes everyone trivially a contributor. §3.1 redefines sink resolution and states the converging-topology limitation honestly.
- **Sink inference needs data the store discards (critical).** `agent_complete` drops its timestamp and `AgentNode` has no `completed_at`. §2.1 adds `completed_at` + `exit_status` to `AgentNode` in Phase A, before Rung 1.
- **`path_share` is a topology artifact (major).** Path-count rewards fan-out, not contribution, and can be exponential (breaking the O(V+E) claim). It is removed from the `credit` field; Rung 1 is **binary `on_critical_path` + a genuine dominator-based bottleneck flag** + the dead-branch list.
- **PBRS theorem misapplied (major).** Policy-invariance is about RL optimal policies, not attribution rankings. The "cannot distort the ranking" claim is removed.
- **`unknown` silently breaks Efficiency (major).** Moving CI-straddlers to `unknown` makes survivors not sum to `v(N)−v(∅)`. §3.3/§4.2 now display the unattributed residual explicitly, add a multiple-comparisons policy, and distinguish "low power" from "tight null."
- **Replay-vs-ablation contradiction (major).** Replay-from-baseline for *all* tool results makes `v(N\{i}) == v(N)` by construction. §6.3 resolves it: downstream LLM/agent steps **must live-execute**; only deterministic external side-effecting tools are mocked/replayed.
- **`v(C)` and spawn cascades (major).** Ablating a parent prevents its children from ever spawning. §3.2 defines `v(C)` over the spawn-feasible closure and credits the ablated agent for the cascade.
- **Cycles undefined for DAG algorithms (major).** §2.3 adds Tarjan SCC condensation; agents in a feedback loop are credited as a unit (grounded "cannot separate").
- Plus minor fixes: BCa small-K caveat + min-K guard; unnormalized-`score` ratio rendering; deterministic timestamp-based last-write-wins; orphaned-sink handling; replay-seed storage boundary; shared `play()` helper note; `__init__.py` keeps `OutcomeEvent` internal; exact App/TopBar edit sites.

---

## 1. Problem Statement & the Grounded-Over-Vibes Principle

### 1.1 The problem

A multi-agent workflow runs many agents that transform work through a chain of handoffs. A single, **sparse** outcome lands at the very end: the task passed or failed, an eval returned a score, a user gave a thumbs up/down, a test suite went green. Between an agent's action and that terminal result there may be a long sequence of *other* agents' transformations.

The question — the **temporal credit assignment problem** under sparse reward — is:

> Which agent(s) actually earned the win, or caused the failure?

This is hard for three compounding reasons:

1. **Delay.** The reward arrives many steps after the action that mattered. Proximity to the outcome is not contribution.
2. **Confounding.** Many agents touch the work; an agent on the "happy path" may have contributed nothing, while a quiet upstream agent may have been decisive.
3. **Non-determinism.** LLM agents are stochastic even at temperature 0 (logit ties, batching/numerical non-determinism). A single re-run tells you nothing; contribution is a *distribution*, not a scalar.

### 1.2 The non-negotiable principle: GROUNDED, not vibes

Credit numbers in AgentViz **must be computed from verifiable facts** — graph structure, counterfactual measurement, or axiomatic decomposition (Shapley). They are **never** an LLM "rate this agent's contribution 0–100" opinion.

This is the same standard the existing efficiency audit already enforces. From `audit.ts`:

> *"Every point deducted traces to a verifiable fact in the event stream — no model judgement anywhere. Each finding names its rule, the agents involved, and the exact reason, so the score is an argument, not a vibe."*

Credit assignment adopts that contract verbatim. Concretely:

- **Every credit number carries its method and provenance.** It is tagged `structural` (Rung 1), `counterfactual` (Rung 2), `shapley` (Rung 3), or `densified` (Rung 4), and tagged `measured` vs `assumed`.
- **Honest "unknown" over false precision.** When a counterfactual confidence interval straddles zero, the agent's credit is reported as *low-power unknown* (distinct from a tight null — see §3.3), never as a fabricated point estimate.
- **Confidence intervals are mandatory** for any sampled method (Rungs 2–3). A single scalar is never shown for a non-deterministic measurement.
- **The reward itself is a recorded fact, not a judgement.** The terminal outcome is supplied externally (eval harness, test exit code, recorded user thumb), is tagged with its `source`, and `source` values that imply an LLM opinion (e.g. `llm_judge`) are flagged as **non-grounded** in the UI.
- **Every credit row states exactly what it means.** Rung 1 is a *necessary-condition* claim ("this agent's output could have reached the result"), **not** a causal claim. Only Rungs 2–3 are causal. The UI must not let a structural reachability fact masquerade as causal contribution.
- **When the math's own assumptions hold only approximately, say so on the number.** Truncation bias (Rung 3), neutralization-mode choice (Rungs 2–3), and Φ-choice (Rung 4) are all `assumed` tags carried on the affected rows — never buried in prose.

### 1.3 The ladder (increasing power and cost)

| Rung | Method | What it answers | Cost | AgentViz role |
|---|---|---|---|---|
| **1** | Provenance / reverse-reachability + dominator analysis on the handoff DAG | "Did this agent's output *flow into* the result, and is it a structural bottleneck on the way?" | Free, deterministic | **Observer** (today) |
| **2** | Counterfactual leave-one-out via ablation replay | "If we neutralize this agent, how much does reward change?" | N re-runs / agent | **Orchestrator** |
| **3** | Shapley credit (precedence-aware coalitions + Monte-Carlo) | "What is each agent's axiomatically fair share of the reward?" | Many re-runs | **Orchestrator** |
| **4** | Reward densification / potential-based shaping | "Can intermediate signals redistribute the sparse terminal reward across handoffs (heuristically)?" | Depends on signals | Observer (closed-form) / modeled |

Rung 1 ships first and standalone. Rungs 2–3 require AgentViz to cross from observer to orchestrator (§6). Rung 4 is the most caveated and lowest priority.

---

## 2. Data Model

### 2.1 The missing primitive: the `outcome` event (+ the completion-order fix)

There is **no** reward/outcome concept anywhere in AgentViz today (verified: `grep -i 'reward\|outcome\|shapley\|reachab'` over `ui/src` and `sdk` returns nothing). The handoff DAG already exists implicitly — spawn edges via `AgentNode.parent_id`, message/handoff edges via `state.messageEdges` — but the terminal reward to reverse-reach *from* does not. **Adding one `outcome` event is the single dependency the whole ladder rests on.** It is added by copying the `usage` event end-to-end through the places the event plumbing lives, exactly as `usage` was added.

**Companion fix (required by Rung 1's sink inference, §3.1).** The current `agent_complete` reducer case (`store.ts`) maps `exit_status` to a status enum and **discards `event.timestamp`**; `AgentNode` (`types.ts`) has **no `completed_at`**. Rung 1's "last-completing leaf" fallback therefore has no data to order by. Phase A adds `completed_at: number | null` and `exit_status: string | null` to `AgentNode` and persists them in the `agent_complete` case. This lands **before** Rung 1.

#### 2.1.1 SDK — `sdk/agentviz/events.py`

Append `"outcome"` to the `EventKind` literal and add one dataclass mirroring `UsageEvent`:

```python
EventKind = Literal[
    "session_start", "agent_spawn", "agent_status", "tool_call_pending",
    "tool_result", "tool_denied", "agent_message", "log", "agent_complete",
    "command_ack", "usage", "outcome",          # <-- append
]

@dataclass
class OutcomeEvent:
    kind: Literal["outcome"] = field(default="outcome", init=False)
    # Attribution scope. agent_id=None => run-level (terminal) outcome.
    agent_id: str | None = None
    # Named reward channel: lets one run carry several orthogonal signals
    # ("tests", "rubric", "user_thumb", "task_complete").
    channel: str = "reward"
    # The measured value. Always a float so binary and graded share one path:
    # binary pass/fail -> 1.0/0.0; graded -> raw score; thumbs -> +1/-1/0.
    value: float = 0.0
    # Declared scale so the credit math interprets `value` without guessing.
    # binary (0/1) | unit (0..1) | score (raw graded; see min/max) |
    # delta (potential-based intermediate signal for Rung 4).
    scale: Literal["binary", "unit", "score", "delta"] = "binary"
    # Optional bounds for "score" so credit math can normalize to [0,1]
    # WITHOUT assuming a range. Absent => credit math treats magnitudes as
    # UNNORMALIZED and Rungs 2/3 render ratios, not raw deltas (§3.2, §3.3).
    value_min: float | None = None
    value_max: float | None = None
    # terminal = the sparse end-of-run reward; intermediate = per-handoff /
    # mid-run signal (Rung 4 densification).
    stage: Literal["terminal", "intermediate"] = "terminal"
    # Provenance / honesty tags. `source` = WHERE the number came from
    # (a verifiable fact, never an LLM opinion): test_suite | eval_harness |
    # user_feedback | ci | assertion | metric | manual | llm_judge.
    # NOTE: source="llm_judge" is accepted but the UI flags it NON-GROUNDED.
    source: str = "manual"
    measured: bool = True
    # Free-form evidence pointer (test ids, eval url, PR #). Display only;
    # the credit math never parses it. For run-level outcomes, the optional
    # key detail["result_agent_ids"]: list[str] declares the sink set
    # explicitly (basis=measured), bypassing inference (§3.1).
    detail: dict[str, Any] = field(default_factory=dict)
    # Rung 2/3 replay bookkeeping (inert until persistence lands, §6).
    # baseline_run_id/baseline_value: which v(N) a counterfactual delta was
    # computed against, so a re-grade (last-write-wins) can invalidate stale
    # cached deltas (§3.3 risk, §7).
    run_id: str | None = None
    ablated_agent_id: str | None = None
    baseline_run_id: str | None = None
    baseline_value: float | None = None
    timestamp: float = field(default_factory=_now)
```

`serialize()` (`asdict`) needs no change. **seq routing:** the SDK `relay_client.py:_stamp_seq` keys on `payload.get("agent_id") or payload.get("from_agent_id") or "_session"`, so a run-level outcome (`agent_id=None`) auto-routes into the `_session` seq stream and an agent-scoped outcome joins that agent's stream — gap detection works for free for SDK-emitted events. (See §2.1.5 for the relay's role and §5 for ingested events, which bypass `_stamp_seq`.)

`OutcomeEvent` is **not** re-exported from `sdk/agentviz/__init__.py` — consistent with `UsageEvent`, which is also internal. Tests assert on the emitted dict via the existing `fake_relay`/`make_capture_relay` capture pattern, not by importing the dataclass.

#### 2.1.2 SDK methods — `agent.py` and `session.py`

Agent-scoped (mirror `report_usage`, `agent.py`). Default `stage="intermediate"` because an agent reporting *its own* signal is typically a mid-run/per-handoff densification signal:

```python
# agent.py
async def report_outcome(
    self, value: float, channel: str = "reward", *,
    scale: Literal["binary","unit","score","delta"] = "binary",
    stage: Literal["terminal","intermediate"] = "intermediate",
    source: str = "manual", measured: bool = True,
    value_min: float | None = None, value_max: float | None = None,
    detail: dict | None = None,
) -> None:
    await self._relay.send(serialize(OutcomeEvent(
        agent_id=self.agent_id, value=value, channel=channel, scale=scale,
        stage=stage, source=source, measured=measured,
        value_min=value_min, value_max=value_max, detail=detail or {},
    )))
```

Run-level terminal outcome (mirror `send_message`, `session.py`). `agent_id=None` → `_session` stream; default `stage="terminal"`:

```python
# session.py
async def report_outcome(
    self, value: float, channel: str = "reward", *,
    scale: Literal["binary","unit","score","delta"] = "binary",
    source: str = "eval_harness", measured: bool = True,
    value_min: float | None = None, value_max: float | None = None,
    detail: dict | None = None,
) -> None:
    await self.client.send(serialize(OutcomeEvent(
        agent_id=None, value=value, channel=channel, scale=scale,
        stage="terminal", source=source, measured=measured,
        value_min=value_min, value_max=value_max, detail=detail or {},
    )))
```

Import `OutcomeEvent` in each module's `from .events import (...)` block.

#### 2.1.3 UI types — `ui/src/types.ts`

Add `"outcome"` to the `EventKind` union, add the interface (mirror `UsageEvent`), add `| OutcomeEvent` to `AgentVizEvent`, **and add `completed_at` / `exit_status` to `AgentNode`** (companion fix):

```ts
export interface OutcomeEvent {
  kind: "outcome";
  agent_id: string | null;
  channel: string;
  value: number;
  scale: "binary" | "unit" | "score" | "delta";
  value_min: number | null;
  value_max: number | null;
  stage: "terminal" | "intermediate";
  source: string;
  measured: boolean;
  detail: Record<string, unknown>;   // may carry result_agent_ids: string[]
  run_id: string | null;
  ablated_agent_id: string | null;
  baseline_run_id: string | null;
  baseline_value: number | null;
  timestamp: number;
}

// AgentNode (add):
//   completed_at: number | null;   // event.timestamp from agent_complete
//   exit_status: string | null;    // raw "ok" | "error" | "stopped"
```

#### 2.1.4 Store — `ui/src/store.ts`

**(a) `AgentNode` completion fields.** In the `agent_complete` case, additionally persist `completed_at: event.timestamp` and `exit_status: event.exit_status`. Add both to the `agent_spawn` initializer as `null`. This is the data Rung 1's sink inference reads.

**(b) `outcomes` aggregation.** Add an `outcomes` field to `AppState` **and to the `initialState` literal** (so `session_start`'s `{ ...initialState, ... }` reset clears it; if it is only in the type, the spread yields `undefined` and the reducer throws on `state.outcomes[event.channel]`). Aggregate per channel, mirroring how `usage` accumulates:

```ts
// AppState (add field) AND initialState (add `outcomes: {}`)
outcomes: Record<string, {                 // key = channel name
  channel: string;
  scale: OutcomeEvent["scale"];
  value_min: number | null;
  value_max: number | null;
  terminal: { value: number; measured: boolean; source: string;
              timestamp: number;
              result_agent_ids: string[] | null } | null;
  perAgent: Record<string, { value: number; count: number; measured: boolean }>;
}>;

// reducer case
case "outcome": {
  const ch = state.outcomes[event.channel] ?? {
    channel: event.channel, scale: event.scale,
    value_min: event.value_min, value_max: event.value_max,
    terminal: null, perAgent: {},
  };
  if (event.agent_id == null) {
    // run-level terminal reward: keep the outcome with the LATEST timestamp,
    // so buffer-replay (relay.ts buffer.all() on reconnect) and live arrival
    // order converge to the same result (deterministic last-write-wins).
    const incoming = {
      value: event.value, measured: event.measured, source: event.source,
      timestamp: event.timestamp,
      result_agent_ids:
        Array.isArray((event.detail as any)?.result_agent_ids)
          ? ((event.detail as any).result_agent_ids as string[]) : null,
    };
    const keep = ch.terminal && ch.terminal.timestamp > incoming.timestamp
      ? ch.terminal : incoming;
    return { ...state, outcomes: { ...state.outcomes, [event.channel]: {
      ...ch, scale: event.scale,
      value_min: event.value_min, value_max: event.value_max,
      terminal: keep,
    }}};
  }
  // agent-scoped (intermediate): accumulate per agent, like usage
  const prev = ch.perAgent[event.agent_id] ?? { value: 0, count: 0, measured: true };
  return { ...state, outcomes: { ...state.outcomes, [event.channel]: { ...ch,
    scale: event.scale,
    perAgent: { ...ch.perAgent, [event.agent_id]: {
      value: prev.value + event.value, count: prev.count + 1,
      measured: prev.measured && event.measured,
    }}}}};
}
```

> **Critical difference from other agent-keyed events:** other reducer cases bail with `if (!agent) return state` when `agent_id` is unknown. An `outcome` may legitimately arrive **after** `agent_complete`, and an ingested run may report an outcome for an agent whose `agent_spawn` was lost/compacted. The outcome case touches only `state.outcomes` (never `state.agents`), so it never needs the agent to be live — **do not copy the `if (!agent) return state` guard into this case.**

**(c) FLOW timeline + layout (this is real work — not a one-line set add).** Adding `"outcome"` to `NARRATIVE_KINDS` only puts the event onto `state.timeline`; `buildFlowLayout`'s `switch` has `default: break` and `FlowView.tsx`'s render `switch` has `default: return null`, so an outcome on the timeline is **silently dropped**, and a run-level outcome (`agent_id=null`) has **no lane** via `laneFor`. Phase A/C must:

1. Add `"outcome"` to `NARRATIVE_KINDS`.
2. Add an `case "outcome":` to `buildFlowLayout`:
   - **agent-scoped intermediate** outcome → `laneFor(event.agent_id)` (attach to that agent's lane).
   - **run-level terminal** outcome → emit a dedicated `FlowRow` variant `{ event, lane: -1, fullWidth: true }` rendered as a full-width marker row spanning all lanes (a "terminal outcome" band). `FlowRow` gains an optional `fullWidth?: boolean`.
3. Add `case "outcome":` to `FlowView.tsx`'s render switch (a distinct marker glyph + channel/value/source/measured).
4. **Exclude `"outcome"` from `GROUPABLE`** in `groupFlowRows` so an outcome never folds into a collapsed noise section — it is the story, like spawns and completions.

#### 2.1.5 Relay

**No changes.** Verified: `relay/src/relay.ts` JSON-parses and fans out every event verbatim, special-casing only `session_start` (→ `buffer.clear()`); `buffer.ts` is untyped (`unknown[]`). A new event kind requires zero relay work. **The relay does not stamp seq** — that is the SDK `relay_client.py:_stamp_seq`. The relay only buffers and replays on reconnect, which is why §2.1.4(b) uses timestamp-based last-write-wins (so buffer-replay order and live order converge).

### 2.2 How provenance and causal links are captured

The credit ladder consumes **one** abstraction — a directed handoff DAG over agents — regardless of which source produced it. Three sources feed the *same* `store.ts` reducer and therefore the same DAG:

1. **Native SDK events.** `agent_spawn.parent_id` → spawn edges; `agent_message` (`from_agent_id` → `to_agent_id`) → message/handoff edges. This is already what `graph.ts` builds.
2. **Ingested Claude Code transcripts** (§5.1) — translated into the same `agent_spawn` / `agent_message` / `tool_*` / `usage` / `agent_complete` events.
3. **Ingested OTel GenAI / OpenInference spans** (§5.2) — translated into the same events.

Because all three normalize into the identical event vocabulary, `credit.ts` is written **once** against `AppState`. The `outcome` event is the only credit-specific input and is source-agnostic.

### 2.3 The handoff DAG (formal, with ghost-edge filtering and cycle handling)

- **Nodes** `V` = `Object.values(state.agents)` (one per agent). Let `idSet = new Set(V.map(a => a.id))`.
- **Edges** `E`:
  - **spawn:** for each agent `a` with `a.parent_id ∈ idSet`, edge `(a.parent_id → a.id)`.
  - **message:** for each `e ∈ state.messageEdges`, edge `(e.from_agent_id → e.to_agent_id)` **only if** `idSet.has(e.from_agent_id) && idSet.has(e.to_agent_id)` and `e.from_agent_id !== e.to_agent_id`.
- **MANDATORY ghost-edge filter.** The store creates `messageEdges` **unconditionally** (it never checks endpoints exist), so ingested transcripts/OTel routinely produce edges referencing agents that have no `agent_spawn`. `graph.ts` already guards every edge with `idSet.has()` and skips self-loops. **`credit.ts` MUST replicate this exact filter** (reuse `graph.ts`'s neighbor-map construction). Without it, reverse-BFS seeds/traverses phantom node ids that have no `AgentNode`, corrupting `CONTRIBUTORS`/`dead_branches` and throwing on `.name` access.
- **Cycles.** The SDK happily emits worker↔lead loops, so the message graph is **not** guaranteed acyclic. Reverse-BFS tolerates cycles via a visited set, but path/dominator/Shapley algorithms do not. **Before any path or coalition algorithm, condense strongly-connected components (Tarjan) into super-nodes.** Agents inside an SCC are credited **as a unit** with the honest label *"cannot separate agents in a feedback loop"* (a grounded unknown). DAG-feasibility and dominator analysis run on the **condensation**, never the raw graph; the collapse factor §3.3 cites is measured on the condensation.
- **Sink(s)** `T` = the agent(s) the terminal `outcome` attaches to (§3.1 resolves the run-level case, including the converging-topology problem).

---

## 3. The Credit Ladder

`ui/src/credit.ts` is a new **pure** function — a peer of `audit.ts` and `graph.ts`, signature `(state: AppState, channel?) => CreditReport`. It reads only `state.agents`, `state.messageEdges`, and `state.outcomes`. No side effects, no model calls. It is testable with the same `play(events[])` helper (note: that helper is currently copy-pasted per test file — see §8 Phase B) and renderable in the same patterns.

```ts
// ui/src/credit.ts
import type { AppState } from "./store";

export type CreditMethod = "structural" | "counterfactual" | "shapley" | "densified";

export interface AgentCredit {
  agent_id: string;
  name: string;
  // CAUSAL contribution share/delta. POPULATED ONLY for Rungs 2/3/4.
  // For Rung 1 this is null — structural reach is not contribution.
  credit: number | null;
  ci: [number, number] | null;    // null for deterministic (Rung 1); set for sampled (Rung 2/3)
  method: CreditMethod;
  basis: "measured" | "assumed";  // honesty tag, like audit findings
  reason: string;                 // a verifiable fact, audit.ts-style — never an opinion
  // ---- Rung 1 structural facts (measured) ----
  on_critical_path: boolean;      // reverse-reachable to the sink (necessary condition)
  is_bottleneck: boolean;         // DOMINATES the sink on the condensation DAG
                                  // (every path to T passes through this agent) — a
                                  // genuine necessary-bottleneck fact, not a heuristic.
  in_feedback_loop: boolean;      // member of a non-trivial SCC (credit not separable)
  // ---- Rung 2/3 epistemic state ----
  credit_state?: "estimated" | "low_power_unknown" | "tight_null";
}

export interface CreditReport {
  outcome: { channel: string; value: number; scale: string;
             measured: boolean; source: string; grounded: boolean } | null;
  method: CreditMethod;           // the highest rung actually computed
  contributors: AgentCredit[];    // agents whose output reached the result
  dead_branches: string[];        // acted but output never reached the outcome (names)
  feedback_loops: string[][];     // SCCs whose members' credit cannot be separated
  // For Rungs 2/3 with `unknown` agents, Efficiency is visibly accounted for:
  attribution?: {
    total_reward: number;         // v(N) - v(empty)
    assigned: number;             // sum of estimated credits
    unattributed: number;         // total - assigned (the residual mass)
  };
  truncation_bias?: number | null;     // Rung 3 only (see §3.3)
  efficiency_residual_fresh?: number;  // Rung 3 only, fresh-sample check (see §3.3)
}

export function assignCredit(state: AppState, channel?: string): CreditReport { /* ... */ }
```

### 3.1 Rung 1 — Provenance / Reachability + Dominators (observer, deterministic, free)

**What it computes.** Two genuinely measured structural facts per agent: (1) **necessary-condition membership** — could this agent's output have flowed into the terminal result (reverse-reachability)? and (2) **structural bottleneck** — does *every* path to the result pass through this agent (dominator)? Neither is a contribution estimate; both are facts about the recorded edges.

**Sink resolution — and the converging-topology problem.** The real demo (`examples/demo_swarm.py`) flows worker→lead→`mission-control` (the root): **results converge upward to the root orchestrator.** Naive leaf-seeded reverse-BFS would find almost nothing; root-seeded would make every agent a trivial "contributor." Rung 1 resolves the sink honestly:

```
Resolve sink set T (in priority order):
  1. outcome.agent_id present (agent-scoped terminal):  T = { that agent }    basis=measured
       (if that id is NOT in idSet -> report outcome as orphaned/unknown, do not crash)
  2. detail.result_agent_ids provided:                  T = those (in idSet)  basis=measured
  3. run-level, no hint -> the outcome attaches to the agent that REPORTED it,
     which for converging topologies is the root orchestrator. Use:
        T = { root }  where root = the agent with no parent (or, if several,
             the latest-`completed_at` parentless agent).                     basis=assumed
     Rationale: in a converging topology the "result" pools at the coordinator,
     so reverse-reachability from the root over the UNION of spawn-descendant
     and message edges correctly answers "whose work fed the coordinator."
```

**Algorithm over `AppState`:**

```
INPUT:  state.agents, state.messageEdges, state.outcomes[channel]
1. Build the filtered handoff DAG per §2.3 (ghost-edge filter + self-loop skip).
2. Tarjan SCC condense (per §2.3). Work on the condensation C.
3. Resolve T (above). Map T into its condensation node(s).
4. Reverse-reachability: reverse-BFS over in_neighbors in C from T.
       CONTRIBUTORS = union of original agents in all reached SCC nodes.
5. Dominators: on C (a DAG after condensation), compute the dominator set of T
       over the FORWARD edges toward T (i.e., which condensation nodes lie on
       EVERY path from a source to T). An agent is is_bottleneck iff its SCC
       dominates T and the SCC is a singleton (a feedback loop cannot be a
       single decisive agent). Lengauer-Tarjan or iterative dominators; O(V+E)-ish.
6. DEAD_BRANCHES = allAgents \ CONTRIBUTORS.
7. FEEDBACK_LOOPS = members of every non-trivial SCC.
OUTPUT per agent:
   on_critical_path = (agent in CONTRIBUTORS)        basis=measured
   is_bottleneck    = (per step 5)                   basis=measured
   in_feedback_loop = (agent in a non-trivial SCC)   basis=measured
   credit = null  (Rung 1 NEVER writes the causal credit field)
   ci = null      (deterministic)
   method = "structural"
   basis  = measured for membership/bottleneck; assumed ONLY when the sink itself
            had to be inferred (case 3 above)
   reason = e.g. "output reaches the terminal outcome (necessary condition)" /
                 "every path to the result passes through this agent (structural bottleneck)" /
                 "no output path reaches the terminal outcome (dead branch)" /
                 "in a feedback loop with {peers}; credit not separable structurally"
```

Complexity `O(V + E)` for reachability and condensation; dominators is near-linear. Workflows are tens of nodes; this is free. (Note: this is **not** the previous draft's path-*counting*, which was exponential and topology-biased — see below.)

**Why `path_share` is removed.** The previous draft computed a "graded structural weight" by counting distinct directed paths to `T` and normalizing. Path **count is not contribution**: an agent on many redundant parallel paths gets a high share while a single-path critical bottleneck (whose removal severs *all* flow) gets a low share — the metric rewards topology fan-out, can be inversely related to true contribution, is exponential in path count (breaking the O(V+E) claim), and is acutely sensitive to message-edge density (an *observation* artifact). It also risked writing a non-causal number into the shared `credit` field — exactly the masquerade §1.2 forbids. The "uniform 1/|CONTRIBUTORS| fallback" was a number with zero grounding content. **Replaced** by: binary `on_critical_path`, the **dominator-based `is_bottleneck`** (a genuine, verifiable "every path goes through here" fact), and the dead-branch list. If no grounded weight exists, Rung 1 reports none — honest unknown over a fabricated share.

**Measured vs assumed:**
- **Measured:** membership in `CONTRIBUTORS`/`DEAD_BRANCHES`; `is_bottleneck`; `in_feedback_loop`; the sink when agent-scoped or `result_agent_ids` is supplied.
- **Assumed:** the sink when it must be *inferred* (run-level with no hint → root).

**How it's shown honestly.** Rung 1 is labeled **"necessary condition — output could have reached the result,"** explicitly **not** causal; a mandatory UI disclaimer says so. `is_bottleneck` is labeled "structural bottleneck (dominator), not proof of impact." For **converging topologies** (root-as-sink), the UI states plainly: *"This workflow's results converge at the orchestrator, so nearly every agent is reverse-reachable. Reachability is near-useless here; run counterfactual replay (Rung 2) for causal credit. Bottleneck/dominator and dead-branch facts remain meaningful."* Dead branches are a first-class list and (per the decision in §4.2) are surfaced via a credit-owned finding, **not** conflated with the audit's activity-based `dead_weight` rule. `ci = null`.

### 3.2 Rung 2 — Counterfactual Leave-One-Out Ablation (orchestrator; distribution, not scalar)

**What it computes.** The causal marginal contribution of agent `i`: the reward delta when `i` is neutralized and the workflow re-run, estimated over `K` paired samples with a confidence interval.

**Value function `v(C)` over the spawn-feasible closure.** `v(C)` = the terminal-channel reward of a re-run in which exactly the agents in coalition `C` are "live" and the rest are neutralized. **Critically, agents are spawned dynamically**: ablating agent `i` prevents every agent reachable *only through* `i` from ever being spawned. So `C` is not a free choice — feasible coalitions are exactly the **spawn-closed** sets (downward-closed under the spawn tree), and ablating `i` credits `i` for the **entire downstream cascade** it would have caused. Formally, `v(C)` is defined only for `C` = a spawn-feasible closure; for an arbitrary requested `C`, the engine ablates the requested agents and lets the spawn cascade determine the actual live set, and the marginal is attributed accordingly. The Efficiency residual check (§3.3, fresh-sample version) is the guardrail that catches violations of this definition.

**Neutralization mode must be declared** (it changes the meaning, and is `assumed`):
- **(a) skip** — the agent is removed; its consumers receive a null/empty input; its children never spawn (cascade).
- **(b) default action** — replace the agent with a fixed default output (difference-rewards / Wonderful Life Utility style); children may still spawn.
- **(c) expected/marginal action** — replace with a marginalized/expected output (aristocrat-utility style; fewer downstream artifacts).

**Leave-one-out marginal:** `Δ_i = v(N) − v(N \ {i})` (with `N\{i}` interpreted as its spawn-feasible closure).

**Why a single re-run is meaningless and what we do instead.** LLM outputs are stochastic even at temperature 0, so `v(·)` is a random variable. We estimate it by **paired sampling with Common Random Numbers (CRN)** — same seed and upstream context across both arms — which cancels shared variance, the single biggest and free variance reduction available:

```
for k in 1..K:
   seed_k = fresh shared seed                  # Common Random Numbers (same in both arms)
   r_full[k]   = run(N,      seed_k)           # baseline arm
   r_ablate[k] = run(N\{i},  seed_k)           # ablated arm
   d[k] = r_full[k] - r_ablate[k]              # PAIRED difference
Δ̂_i = mean(d)
CI   = paired bootstrap over the K diffs (resample B=10000x; BCa percentile interval)
```

**Unnormalized `score` channels.** If the terminal channel is `scale="score"` with no `value_min`/`value_max`, raw deltas are in arbitrary unbounded units — a delta of "+12" is not interpretable as contribution. In that case Rung 2 renders credit as a **ratio of the measured range** (`Δ̂_i / (v(N) − v(∅))`) and tags the absolute magnitude `unnormalized`; or, if bounds are required by config, returns `unknown` until bounds are supplied.

**Stale-baseline guard.** Each counterfactual delta is stamped with `baseline_run_id`/`baseline_value` (the `v(N)` it was computed against). If a re-grade changes the terminal channel value (last-write-wins, §2.1.4), any cached delta whose baseline value no longer matches is invalidated → `low_power_unknown` until recomputed.

**Measured vs assumed:**
- **Measured:** `Δ̂_i`, its CI, the sample count `K`, the neutralization mode (as a recorded fact about how the run was configured).
- **Assumed:** the *choice* of neutralization mode (it encodes a counterfactual world); the fidelity of mock side-effects in dry-run mode (§6.3).

**How it's shown honestly.** Always `Δ̂_i ± CI` with `K` and the neutralization mode displayed. Epistemic states are distinguished:
- **`estimated`** — CI excludes zero (after the multiple-comparisons correction, §3.3).
- **`low_power_unknown`** — CI straddles zero *and* is wide (need more samples). "We don't know."
- **`tight_null`** — point estimate ≈ 0 with a *tight* CI (genuine null player). "We know it's ~0." These are opposite epistemic states and must not collapse to one label.

**Small-K caveat.** BCa is preferable to percentile/CLT but still **under-covers at very small K** (single digits); its bias-correction/acceleration estimates are themselves unstable there. Report `K` prominently; treat intervals from `K < 15` as themselves uncertain; a configurable **minimum-K guard** below which Rung 2 returns `unknown` rather than any interval (consistent with honest-unknown). Until the orchestrator and dry-run mode exist (§6), Rung 2 returns `unknown`, never a fabricated number.

### 3.3 Rung 3 — Shapley Credit (orchestrator; many re-runs; axiomatic — stated precisely)

**Pick the estimand and state it honestly.** Classic Shapley is the unique value satisfying **Efficiency, Symmetry, Null-player, Additivity** *only when `v` is defined on all `2^n` subsets*. The moment we enumerate only precedence-feasible coalitions, we are computing a **different** solution concept. AgentViz offers two configurable, honestly-labeled modes — never a constrained value dressed in the unconstrained axioms:

**Mode A — Classic Shapley (default; recommended).** Sample **full permutations uniformly** from all `n!` orderings. `v` must be defined on *every* prefix, including spawn-infeasible ones; we define infeasible prefixes by the spawn-closure rule of §3.2: `v(S) := v(spawn-closure(S))` (an agent absent because its parent was ablated is simply absent). This keeps the **classic four axioms** and is what the UI labels `shapley (classic)`.

```
φ̂_i = 0
for m in 1..M:
   π = uniformly random permutation of all n agents        # NOT restricted to DAG
   for i in π:
      P = predecessors of i in π
      φ̂_i += v(spawn-closure(P ∪ {i})) - v(spawn-closure(P))   # each v is a Rung-2 PAIRED-SAMPLED mean
φ̂_i /= M
```

**Mode B — Precedence-constrained Shapley (opt-in; Faigle–Kern 1992 / Myerson graph-restricted games).** Restrict to **linear extensions** of the condensation DAG. This satisfies a **modified** axiom set, **not** the classic one: *Efficiency holds; Symmetry and Null-player hold only among order-comparable players.* The UI labels it `shapley (precedence-constrained, Faigle–Kern)` and shows the modified-axiom disclaimer. **Sampler correctness is where the bias lives:** uniformly sampling linear extensions of a poset is **#P-hard**, and a naive "repeatedly pick a random available source" generator is **non-uniform** → biased even for the constrained value. Mode B therefore must use a **provably-uniform linear-extension sampler** (e.g. Karzanov–Khachiyan / Bubley–Dyer rapidly-mixing Markov chain) **or** importance-weight the naive sampler by its known selection probability and debias. The chosen sampler is named in the report.

**Tractability reductions (and their honest costs):**
1. **Coalition restriction** (Mode B only): linear extensions of the condensation DAG. Collapse factor is measured on the condensation (§2.3), not the raw graph.
2. **Monte-Carlo permutation sampling** (Castro–Gómez–Tejada): `O(1/√M)` outer error. **Unbiased only for the estimand its sampler targets** — Mode A with uniform full permutations targets classic Shapley; Mode B with a uniform linear-extension sampler targets the constrained value. A mismatch (e.g. Castro's estimator over restricted permutations) is biased for classic Shapley and is forbidden.
3. **Truncated Monte-Carlo (TMC, Ghorbani–Zou):** once adding agents stops moving reward beyond tolerance τ, set remaining marginals to zero. **TMC introduces bias** controlled by τ (bias → 0 as τ → 0, at higher cost). The composed estimator with TMC is **NOT unbiased** — that word is never used for it. τ is carried as an `assumed` tag on every Shapley row, and the truncation-bias magnitude is reported (below).
4. **Antithetic + stratified sampling:** evaluate the reverse of each permutation; stratify by coalition size with Neyman allocation. Variance reduction only — no bias.

**Nested noisy `v` — full error budget (no hand-waving).** Each coalition value `v(·)` is the noisy Rung-2 estimator over `K` inner paired samples. Therefore:
- **Total error ≈ outer permutation error `O(1/√M)` PLUS an inner-estimation floor `O(1/√K)` that does NOT vanish as `M → ∞`.** Both `M` and `K` are shown on every Shapley CI in the UI.
- **CRN seed-sharing rule for arbitrary coalition pairs.** Inside Shapley the pairs are `(P∪{i}, P)` for varying `P`, not just `(N, N\{i})`. CRN seeds **are shared within each `(P∪{i}, P)` marginal evaluation** (same upstream seed for both members of the pair) so the marginal's variance is reduced the same way Rung 2's is. They are **not** shared across different `P` (those are independent draws).
- **`v̂` caching and the bootstrap.** `v̂` values **may** be cached and reused across permutations (a major cost saving). If cached, the two-level bootstrap must resample **at the permutation level treating each cached `v̂` as fixed-plus-its-own-noise** (do not redraw inner samples per outer resample, which would double-count the inner noise). The report states whether caching is on.

**The Efficiency residual is NOT a free correctness check — and the doc now says so.** In permutation Monte-Carlo, each permutation's marginals **telescope exactly** to `v(N) − v(∅)`; averaging preserves this, so `Σφ̂ − (v(N) − v(∅)) = 0` **by construction** whenever the same per-permutation `v`-draws are reused and there is no truncation — *regardless* of whether the sampler is uniform, `v` is noisy, or the estimand is right. It therefore **cannot** detect the sampler/estimand bugs above. Two honest uses replace the false "self-check":
- **`truncation_bias`** — with TMC on, the by-construction residual becomes nonzero and equals exactly the truncation bias. Reported as `truncation_bias` (its *only* meaning), an `assumed`-side magnitude.
- **`efficiency_residual_fresh`** — a *real* independent check: recompute `v(N)` and `v(∅)` from **fresh, independent samples** and compare to `Σφ̂`. A nonzero fresh residual signals estimator/variance problems (or estimand mismatch). This is the quantity the UI presents as a sanity indicator; the by-construction one is never shown as such.

**`unknown` vs Efficiency — display the residual mass.** Moving CI-straddling agents to `unknown` makes the surviving point estimates **no longer sum to `v(N) − v(∅)`** — silently breaking the headline axiom. The UI therefore **always** shows `attribution`: *"credit assigned: X; unattributed/unknown: Y; total reward Z (X+Y=Z)"*, so Efficiency is **visibly accounted for** rather than silently violated. Multiple-comparisons: declaring "unknown" via many per-agent 95% CIs lets a fraction cross zero by chance and flips run-to-run. Rung 3 (and Rung 2) apply a **Benjamini–Hochberg FDR** correction across agents (configurable α, reported) for the "is this agent's credit distinguishable from zero" test, and report the chosen α and method. `low_power_unknown` vs `tight_null` are distinguished exactly as in §3.2.

**Measured vs assumed:**
- **Measured:** `φ̂_i`, its CI, `M`, inner `K`, the named sampler, the FDR α, `efficiency_residual_fresh`.
- **Assumed:** neutralization mode and mock fidelity (as Rung 2); truncation tolerance τ and the resulting `truncation_bias`; in Mode B, the modified-axiom interpretation.

**How it's shown honestly.** `φ̂_i ± CI (M=…, K=…)` per agent; the mode label (classic vs precedence-constrained) with its axiom set; `attribution` residual mass; `efficiency_residual_fresh` as the sanity indicator; `truncation_bias` when τ>0. CIs straddling zero (post-FDR) → `low_power_unknown` (wide) or `tight_null` (tight). Returns `unknown` until the orchestrator exists.

**Literature grounding (for the doc, not runtime):** Shapley (1953); **Faigle & Kern (1992), Shapley value for games with precedence constraints**; Myerson (1977) graph-restricted games; Castro, Gómez & Tejada (2009) polynomial Monte-Carlo Shapley; Ghorbani & Zou (2019) Data Shapley / TMC; Karzanov–Khachiyan and Bubley–Dyer (uniform linear-extension sampling); COMA counterfactual baseline (Foerster et al., AAAI 2018); difference rewards / Wonderful Life / aristocrat utility (Wolpert & Tumer); SHAQ (NeurIPS 2022); Shapley Counterfactual Credits (KDD 2021).

### 3.4 Rung 4 — Reward Densification / Potential-Based Shaping (most caveated)

**What it computes.** When intermediate, *verifiable* progress signals exist (tests passing, schema valid, subgoal met — emitted as `outcome` events with `stage="intermediate"`), redistribute the sparse terminal reward across handoffs so credit is denser than a single end-of-run scalar. **This is a heuristic redistribution, presented as such — never as ground truth.**

**Preferred (closed-form).** Potential-based reward shaping (Ng, Harada & Russell 1999): per-handoff credit = `γ·Φ(after) − Φ(before)`, where `Φ` is a **verifiable progress measure** (e.g. fraction of tests passing). Use `scale="delta"` intermediate outcomes on a **named channel distinct from the terminal channel** so densified credit never silently overwrites the sparse ground truth (the store keys outcomes by channel; a separate channel keeps them separate). The store sums these per-agent (like `usage`), giving a shaped baseline.

**Correction (review): the policy-invariance theorem does NOT justify a credit-ranking claim.** Ng–Harada–Russell guarantees PBRS preserves the set of **optimal policies for an RL learner** — it says **nothing** about preserving a relative **credit ordering** among agents in an attribution report. "Does not change argmax policy" ≠ "does not distort the credit ranking." The previous draft's "the unique form … cannot distort the ground-truth ranking" is **removed**. Accurately: PBRS is policy-invariant for RL *training* but carries **no** guarantee about attribution fairness or credit ordering; the per-handoff credit `γΦ(s′)−Φ(s)` is only as grounded as the **choice and bounds of Φ**, which are `assumed`.

**Discouraged (modeled).** Learned return-decomposition (RUDDER; TAR² for agent-temporal redistribution) *learns* a model to redistribute reward. Powerful but **model-based, not axiomatic** — tag `basis="assumed"`, `method="densified"`, show it with the model's own uncertainty. Never present it as ground truth.

**Measured vs assumed:**
- **Measured:** the intermediate `Φ` values themselves (verifiable facts) and the arithmetic of the `γ·Φ(s′) − Φ(s)` deltas.
- **Assumed:** the **choice and bounds of `Φ`**; any learned redistribution; the implied claim that shaped deltas reflect contribution.

---

## 4. UI — The Credit Lens

### 4.1 How it mounts (exact edit sites)

Credit becomes a **fourth top-level view**, extending the existing 3-way pattern. The view union is **duplicated across files** — list every site:

- `App.tsx:28` — `useState<"3d" | "2d" | "flow" | "credit">("3d")`.
- `App.tsx:40` — extend the `V`-cycle ternary: `v === "3d" ? "2d" : v === "2d" ? "flow" : v === "flow" ? "credit" : "3d"`.
- `App.tsx:75–123` — add a render branch mounting `<CreditView state={state} onSelectNode={selectNode} />`. (Note: `GraphStats` renders only when `view === "2d"`; the credit lens owns its own export button — see §4.4.)
- `TopBar.tsx:8–9` — widen **both** `view` and `onSetView` prop unions.
- `TopBar.tsx:42–46` — add a 4th toggle button + divider; the `[V]` hint already exists.
- **Recommended:** extract the view union to a shared `type ViewMode = "3d" | "2d" | "flow" | "credit"` to stop perpetuating the triple-duplication.

`CreditView` calls `assignCredit(state)` via `useMemo(() => assignCredit(state), [state])` (the `GraphStats.tsx` pattern). For Rung 1 it is a pure read of state — no new events, no commands.

### 4.2 What it shows

1. **Per-agent credit table.** One row per agent: name; for Rung 1 the **structural facts** (`on_critical_path`, `is_bottleneck`, `in_feedback_loop`) as badges — **no number in the `credit` column** (the field is `null` for structural); for Rungs 2–3 the causal `credit` ± **CI**, sample counts (`K`, and `M` for Shapley), `method` badge, `basis` badge, and `credit_state` (`estimated` / `low_power_unknown` / `tight_null`). Rows in `low_power_unknown` render greyed as "unknown — needs more samples"; `tight_null` renders as "≈0 (confident)". Each row's `reason` cites the verifiable fact (audit's "score is an argument" contract).
2. **Attribution residual banner** (Rungs 2–3). "credit assigned: X; unattributed/unknown: Y; total reward Z" so Efficiency is visibly accounted for.
3. **Provenance subgraph to the outcome.** A reduced view of the handoff DAG highlighting `CONTRIBUTORS`, with dominators (`is_bottleneck`) emphasized and the resolved sink marked. Reuses existing graph rendering primitives. For converging topologies the banner warns reachability is near-universal (§3.1).
4. **Dead branches & feedback loops.** `dead_branches` rendered as a distinct dimmed group; `feedback_loops` shown as grouped SCCs labeled "credit not separable."
5. **Honesty header.** Channel, value, `scale`, `source` (with a **non-grounded** flag if `source === "llm_judge"`), `measured`. For Rung 1, the fixed disclaimer: *"Necessary-condition attribution: shows whose output could have reached the result and which agents are structural bottlenecks — not who caused the outcome. Run counterfactual replay for causal credit."* For Shapley, the mode label (classic vs precedence-constrained) and its axiom set; the `efficiency_residual_fresh` sanity number and `truncation_bias` when τ>0.

**Dead branches and the audit are different signals — keep them separate.** The audit's `dead_weight` rule is **activity-based** (an agent that made zero tool calls *and* sent zero messages, root-exempt). A Rung-1 dead branch is a **reachability** fact (an agent that *acted* but whose output never reached the sink). A busy agent can pass `dead_weight` yet be a dead branch. **Decision: credit dead-branches stay OUT of `audit.ts`.** `credit.ts` owns them; `CreditView` renders them; we do **not** claim they appear in `GraphStats`. (If a future maintainer wants them in `GraphStats`, that requires a *new* `reachability_dead_branch` rule added to `audit.ts`'s closed `AuditFinding` union + `CAPS` + `audit.test.ts` cases — a deliberate breaking change, explicitly scoped, not implied.)

### 4.3 FLOW integration (real edits, per §2.1.4(c))

Outcomes appear inline in the swimlane transcript **only after** the `flow.ts`/`FlowView.tsx` edits of §2.1.4(c): a `case "outcome":` in `buildFlowLayout` (agent-scoped → its lane; run-level → a full-width terminal-outcome band), a matching `case "outcome":` in `FlowView`'s render switch, and exclusion from `GROUPABLE`. This makes "tests passed here, after agent X's handoff" readable at the moment it lands. (Adding to `NARRATIVE_KINDS` alone is a no-op — verified against `buildFlowLayout`'s `default: break`.)

### 4.4 Graph export (matches how export actually works)

Export is **not** assembled inside `buildWorkflowGraph` — verified, the download payload is built **inline in `GraphStats.tsx`** (it spreads `graph.graph` and bolts on `metrics` and `audit` there). `GraphNode` is a closed shape with no credit fields, and `graph.test.ts` asserts that shape. Also, `GraphStats` only renders in the 2D view, which the credit lens does not show. **Decision (option b — least coupling):** `CreditView` owns its **own** export button that merges `assignCredit(state)` output into a node-link JSON: per-node `on_critical_path`, `is_bottleneck`, `in_feedback_loop`, and (when available) `credit`/`ci`/`credit_state`, with the full `CreditReport` attached under `graph.graph.credit` — mirroring exactly how `GraphStats` bolts `audit` on at the inline-payload layer. `graph.ts` and `graph.test.ts` are left untouched. This round-trips to Python/NetworkX for downstream analysis with zero coupling to the existing export.

---

## 5. Ingestion Adapters (same store, new sources)

Both adapters are **translators** that emit the existing AgentViz event vocabulary into the same reducer. Neither touches `credit.ts`, which only ever sees `AppState`.

**seq for ingested events (correction).** Ingested events do **not** pass through the SDK `relay_client.py:_stamp_seq`, so they carry **no seq** unless the adapter adds it. Consequences if left unstamped: gap detection is N/A for the ingestion path, and run-level `outcome` ordering has no seq to rely on. **Requirement:** each adapter **replicates `_stamp_seq`'s per-key counter** (`agent_id or from_agent_id or "_session"`, monotonically increasing) when emitting. For outcome ordering specifically, the store already uses **timestamp**-based last-write-wins (§2.1.4(b)), which is correct for ingested streams even when seq is absent. A golden-fixture test asserts ingested events carry monotonic per-key seq.

### 5.1 Claude Code transcript replay

**Source layout.** Each top-level session is one JSONL at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Sub-agents (spawned by the **`Agent`** tool — formerly/aka `Task`) are separate sidechain transcripts under `<sessionId>/subagents/agent-<agentId>.jsonl` with a sibling `agent-<agentId>.meta.json`. Nested workflow sub-agents live under `<sessionId>/subagents/workflows/wf_<id>/` with a `journal.jsonl`. **This directory structure *is* the Rung-1 substrate** — deterministic, observer-only.

**Mapping (stream line-by-line; index by `uuid` / `tool_use_id` / `message.id`):**

| AgentViz event | Source |
|---|---|
| `session_start` | once per `<sessionId>.jsonl`; `name` from first line / `ai-title` |
| `agent_spawn` | one per `subagents/agent-<agentId>.*` triple. `agent_id = agentId`; **`parent_id` = the agentId/session whose `tool_use` block has id == `meta.json.toolUseId`** (confirm against parent's `toolUseResult.agentId`). Top-level session = root. `name` from `meta.description`; `agent_type` from `meta.agentType` / `attributionAgent`; `model` from `tool_use.input.model`. |
| `tool_call_pending` | each `{type:"tool_use"}` block, `call_id = block.id`, `args = input`. **Treat `name == "Agent"` / `"Workflow"` as spawn edges, never leaf tools.** |
| `tool_result` | each `{type:"tool_result"}` block matched by `tool_use_id`; `is_error` → status. |
| `tool_denied` | `is_error && content contains "[Request interrupted by user"` (no dedicated denial record). **Tag "inferred from is_error text."** |
| `usage` | per assistant line `message.usage`, **deduped by `message.id`** (streamed lines repeat the id) — else the authoritative `toolUseResult.{totalTokens,...}` rollup. |
| `agent_complete` | from the parent's `toolUseResult` for that `agentId` (`status`, `totalTokens`, `totalDurationMs`, `toolStats`); **carry the line timestamp into `completed_at`**. Root: synthesize from last `end_turn`. |
| `agent_message` | a child's `toolUseResult.content` text consumed in the parent's subsequent turns → data-flow edge (this is the upward, converging handoff — see §3.1). |

**Gotchas (must handle):** `parentUuid` is intra-transcript only (cross-agent edges come from `meta.toolUseId`, first sidechain line is `parentUuid: null`); `compact_boundary` system lines sever `parentUuid` chains (stitch via `logicalParentUuid` / `message.id` continuity); `api_error` with `retryAttempt` marks a non-deterministic re-issue (relevant to Rung 2/3; don't double-count); accept both `Agent` and legacy `Task`; **NO native reward field exists** — the terminal `outcome` is supplied externally, and the only proxies (`toolUseResult.status`, `is_error` counts, final `end_turn` text) are **weak** and tagged `assumed` (`status` only ever showed `completed` in the studied corpus; the failure enum is unconfirmed).

**Replay seed for Rungs 2/3:** the transcript preserves each sub-agent's exact spawn prompt (`tool_use.input.prompt` / `toolUseResult.prompt`) and model. **Where this is stored (boundary clarification):** `AppState`/`AgentNode` do **not** carry spawn prompts (the observer phase never captures them, and `credit.ts` never sees them). They are persisted in the **append-only event log keyed by `run_id`+`agent_id`** (§6.1); only the re-run engine reads them. Optionally `AgentNode` may gain `spawn_prompt?`/`model?` if a future view needs them, but the credit path does not.

### 5.2 OpenTelemetry GenAI / OpenInference ingest

**Wire formats.** Add an OTLP receiver to the relay: `POST /v1/traces` accepting **OTLP/JSON** (trivial protobuf-JSON mapping for a Node relay; gRPC `:4317` later). Exported OTel JSON is the offline equivalent for golden tests. Emitters: OpenAI Agents SDK, AgentOps, OpenLLMetry/Traceloop, OpenInference/Arize (LangGraph, CrewAI, AutoGen).

**Span model = the handoff DAG.** Every span has `trace_id` / `span_id` / `parent_span_id`. `gen_ai.operation.name` discriminates span type: `{create_agent, invoke_agent, invoke_workflow}` (agent), `{chat, generate_content, text_completion, embeddings}` (LLM), `execute_tool` (tool).

**Mapping (sort spans by `start_time`; build a `span_id` map):**

| AgentViz event | OTel source |
|---|---|
| `session_start` | root span (`parent_span_id` empty); `name` = `service.name` or root span name |
| `agent_spawn` | spans with `operation.name ∈ {invoke_agent, create_agent}`. `agent_id = gen_ai.agent.id ?? span_id`; **`parent_id`** = nearest enclosing agent span (walk `parent_span_id` to the first agent span; null if root); `name = gen_ai.agent.name` |
| `tool_call_pending` / `tool_result` | `execute_tool` span start/end; `call_id = gen_ai.tool.call.id ?? span_id`; `agent_id` = nearest enclosing agent span |
| `tool_denied` | `execute_tool` span with `status=ERROR` / `error.type` |
| `usage` | any chat/inference span; `input_tokens = gen_ai.usage.input_tokens` (**accept deprecated `prompt_tokens`** and OpenInference `llm.token_count.prompt`); same for output; `model = gen_ai.response.model ?? gen_ai.request.model ?? llm.model_name` |
| `agent_message` | OpenAI Agents SDK **handoff** spans → `from = parent agent`, `to = child agent` (the literal credit-bearing transfer) |
| `agent_complete` | agent span end; `exit_status` from `status.code`; **carry span end time into `completed_at`** |

**The nearest-enclosing-agent walk over `parent_span_id` IS the handoff DAG** — reverse-reachability over it is Rung 1, computed purely from trace structure. Tag each edge **MEASURED** (real `parent_span_id`) vs **ASSUMED** (fell back to `span_id` because an agent span was missing).

**Cost / honesty rules:** OTel defines **no** cost attribute — derive `cost_usd` deterministically from tokens × a **versioned model price table** keyed by `gen_ai.response.model`; emit `cost_usd = null` (honest unknown) on a price-table miss, tag `source = derived`. OpenInference **does** carry cost (`llm.cost.total`); accept it, tag `source = instrumentation`. Accept both new and deprecated attribute names (`gen_ai.provider.name` ↔ `gen_ai.system`; `input_tokens` ↔ `prompt_tokens`); recommend `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`. **OpenInference `graph.node.id` / `graph.node.parent_id`** give explicit framework-graph edges (LangGraph nodes, CrewAI tasks) often *more precise* than `parent_span_id`; branch on `openinference.span.kind` and prefer these when present. **Outcome is never inferred from spans** — it remains the first-class, externally-attached `outcome` event.

Commit a small golden fixtures corpus (real exported OTel JSON from OpenAI Agents SDK + one OpenInference framework) under `examples/`, mirroring `ui/tests/*.test.ts`, to pin the mapping against attribute drift, and assert ingested events carry monotonic per-key seq (§5 requirement).

---

## 6. The Observer → Orchestrator Fork (required for Rungs 2–3)

Rung 1 and Rung 4-closed-form are **observer-only** and ship today. **Rungs 2 and 3 require AgentViz to trigger re-runs** — crossing from observer to orchestrator. The SDK is currently observer-only (no re-run engine, no replayable workflow definition, no mock-side-effects mode). Three pieces must land, in order.

### 6.1 Persistence (gates everything; roadmap 1.1)

An append-only event log keyed by `run_id`. The pure reducer is the enabler: **replay = re-feed a (possibly edited) event log.** Today the relay buffers in memory and clears on `session_start`; no durable store exists. Add `run_id` to `session_start` and stamp it on every event. The `OutcomeEvent.run_id` / `ablated_agent_id` / `baseline_run_id` / `baseline_value` fields are forward-compatible and inert until this lands. **The log also stores each agent's spawn prompt + model** (the Rung 2/3 replay seed, §5.1), keyed `run_id`+`agent_id`.

### 6.2 Re-run engine (Branching Replay, roadmap 2.1, generalized — with an honest caveat)

Counterfactual ablation **is Branching Replay generalized** from "flip one approval" to "neutralize one agent." Reuse the planned persist → replay-through-reducer → fork machinery. Add run-lineage to `session_start`:
- `parent_run_id: str | None` — the observed run this counterfactual derives from.
- `ablated_agent_id: str | None` — who was neutralized this re-run.

A leave-one-out sample is a full session whose `session_start` declares `parent_run_id` + the ablated agent; its terminal `outcome` on the same channel is directly comparable to the baseline's. Drive re-runs from the UI via a new `CommandKind` (`rerun_ablation`) added to `events.py` + `types.ts`, dispatched like existing `tool_approve` / `agent_stop` commands.

**Honest caveat (review): flipping an approval reuses a cached result; neutralizing an agent does NOT.** Flipping one approval can replay everything else from cache because nothing downstream changes deterministically. **Ablation changes downstream inputs**, so downstream LLM/agent steps must be **re-executed live** (you cannot replay them — see §6.3). "Branching Replay generalized" is accurate for the *fork-from-a-persisted-log* machinery, but the re-execution semantics differ: ablation re-incurs LLM cost for everything downstream of the ablated agent.

### 6.3 Dry-run / mock side-effects mode (hard safety prerequisite — and the replay-vs-ablation resolution)

**Until this exists, Rungs 2–3 are unsafe to enable on any real workflow.** Re-running a finance workflow that calls `ramp_edit_transaction` for real would duplicate writes / send real emails / charge real cards.

**The contradiction, resolved.** "Replay the original `tool_result` from baseline" cannot apply to *everything*: if downstream tool results are replayed from the un-ablated baseline, the ablation has **no downstream effect** and `v(N\{i}) == v(N)` **by construction**, making every `Δ_i` exactly zero — the causal signal is destroyed. Resolution:

- **LLM/agent steps downstream of the ablated agent MUST live-execute.** Their different inputs are the entire point; they cannot be replayed.
- **Deterministic, side-effecting *external tool* calls are mocked or replayed** for safety. Each tool call **must declare a side-effect/idempotency class** so the engine knows which behavior applies:
  - `pure`/`read-only` → re-execute freely (safe).
  - `replayable-deterministic` → replay the baseline `tool_result` (safe, faithful).
  - `side-effecting` (writes, emails, charges) → run a registered mock / user stub, tagged `simulated: true`; **must never hit production.**
- **`live-required` (LLM/agent steps)** → re-execute; cannot be made side-effect-free.

**The documented contract:** in `dry_run`, **zero externally-visible side-effects** occur (every `side-effecting` tool is mocked/stubbed), and the run **does** re-execute LLM/agent steps and re-incur their cost. Dry-run guarantees zero *external* side-effects — **not** zero recomputation. Add a session-level `dry_run: bool` and a `session_start` field so the UI badges replayed/counterfactual runs. **Do not start Rung 2 until the zero-external-side-effect guarantee has a passing test.**

---

## 7. Honest Risks & Limitations

1. **No native reward anywhere.** Neither Claude Code transcripts nor OTel spans contain a terminal reward. Credit is only as grounded as the externally-supplied `outcome`. Inferred proxies are weak and always `assumed`. **The whole capability is inert without a real outcome.**
2. **Rung 1 is necessary, not sufficient — and near-useless on converging topologies.** Reverse-reachability proves an output *could have* reached the result, not that it mattered. When results converge at the root orchestrator (the common case here), nearly every agent is reachable, so reachability barely discriminates; only the dominator/bottleneck and dead-branch facts stay sharp. Presenting reachability as causal would violate the grounded principle. The UI disclaimer is mandatory.
3. **`path_share` was removed.** Path-count rewarded topology fan-out, not contribution, and was exponential. Rung 1 is now binary reachability + dominator bottleneck + dead branches — only genuinely measured structural facts.
4. **LLM non-determinism dominates Rungs 2–3.** A single re-run is meaningless. Paired/CRN design + bootstrap CIs are mandatory; CIs will often straddle zero. We distinguish `low_power_unknown` (need more samples) from `tight_null` (genuinely ~0). BCa under-covers at very small K; a min-K guard returns `unknown` rather than a misleadingly tight interval.
5. **Neutralization mode is a modeling choice.** skip vs default-action vs expected-action define *different* counterfactual worlds and yield different numbers. Always displayed; always `assumed`.
6. **Ablation cannot be made side-effect-free for LLM steps.** Dry-run guarantees zero *external* side-effects only; downstream LLM/agent re-execution is required and re-incurs cost. Replay-from-baseline applies only to deterministic external tools; replaying everything would zero out the causal signal.
7. **`v(C)` is defined over spawn-feasible closures.** Ablating a parent prevents its children from spawning; the parent is credited for that cascade. The fresh-sample Efficiency residual is the guardrail that catches violations of this definition.
8. **Shapley estimand and sampler must match — and TMC adds bias.** Classic vs precedence-constrained are different solution concepts with different axioms; the sampler must target the chosen one (uniform full permutations for classic; a provably-uniform/importance-weighted linear-extension sampler for constrained — naive generators are #P-hard-biased). TMC trades bias for cost; τ is reported. The by-construction Efficiency residual is **not** a correctness check; the fresh-sample residual is.
9. **`unknown` interacts with Efficiency.** Dropping CI-straddlers to `unknown` breaks the sum; the UI shows the unattributed residual mass explicitly. A BH-FDR correction (reported α) controls multiple comparisons across agents.
10. **PBRS policy-invariance does not protect credit rankings.** It is an RL-training guarantee, not an attribution guarantee. Densified credit is heuristic, gated on the `assumed` choice of Φ.
11. **Shapley cost.** Even with reductions, Rung 3 is many re-runs × K inner samples each, and re-incurs LLM cost. A deliberate, expensive analysis, not a live metric. Total error has an `O(1/√K)` floor independent of M.
12. **Cost is always derived for OTel.** A model missing from the price table yields `cost_usd = null`, not a guess. Per-dollar credit is unavailable for unknown models.
13. **Cross-session / team topologies.** Claude Code exposes `teamName` / `logicalParentUuid` / multi-session runs; the spawn DAG may span files. The ingester must join across sessions; single-directory assumptions undercount.
14. **Ingested events carry no seq unless the adapter stamps it.** Adapters replicate `_stamp_seq`'s per-key counter; outcome ordering falls back to timestamp (deterministic last-write-wins), which is correct even without seq.
15. **`run_id`/lineage/baseline fields are inert until persistence ships.** Forward-compatible scaffolding, not working features, in the Rung-1 slice.
16. **Multiple terminal outcomes per channel** (re-grade) use timestamp-based last-write-wins (deterministic under buffer replay), losing re-grade history; a cached Rung-2 delta whose baseline value changed is invalidated. A per-channel history list is a future option.

---

## 8. TDD Build Order

Strict TDD: write the failing test first, then the implementation. **The shippable slice is Rung 1 + the `outcome` primitive (+ the `completed_at` companion fix)** — observer-only, deterministic, free, no relay or orchestrator changes. Everything below is sequenced behind hard prerequisites.

**Shared test helper note.** `play(events[])` is currently copy-pasted in `audit.test.ts` and `graph.test.ts`. Phase A/B should extract it to `ui/tests/helpers.ts` and import it (or each new test file defines its own — but do not claim it is already shared).

**Phase A — `outcome` primitive + completion-order fix (the dependency for everything).**
- `events.py`: `OutcomeEvent` dataclass + `EventKind`; keep it internal (not re-exported from `__init__.py`).
- `agent.py`/`session.py`: `report_outcome` emitters (mirror `report_usage` / `send_message`).
- `types.ts`: `OutcomeEvent` interface + union + `EventKind`; add `completed_at`/`exit_status` to `AgentNode`.
- `store.ts`: outcome reducer case (timestamp-based last-write-wins run-level; per-agent accumulate; survives `agent_complete`; **no `if (!agent)` guard**); `outcomes` in `AppState` **and** `initialState`; persist `completed_at`/`exit_status` in `agent_complete`; add `"outcome"` to `NARRATIVE_KINDS`.
- `flow.ts`/`FlowView.tsx`: `case "outcome":` in `buildFlowLayout` (agent-lane vs full-width terminal band) + render switch; exclude from `GROUPABLE`.
- **Tests:** `sdk/tests/test_outcome.py` (capture-relay; run-level routes to `_session` seq, agent-level to the agent stream, `OutcomeEvent` not imported — asserted via dict); `ui/tests/store.test.ts` (run-level latest-timestamp wins; agent-level accumulates; survives `agent_complete`; `outcomes` resets to `{}` on `session_start`; `completed_at` recoverable); `ui/tests/flow.test.ts` (agent-scoped outcome on its lane; run-level full-width band; not folded into a section).

**Phase B — Rung 1 in `credit.ts` (SHIPPABLE).** New pure `assignCredit(state)`. DAG build reuses `graph.ts`'s `idSet.has()` ghost-edge filter + self-loop skip; Tarjan SCC condensation; sink resolution (agent-scoped / `result_agent_ids` / root-converging fallback); reverse-reachability; dominator-based `is_bottleneck`; dead branches; feedback loops. **Tests:** `ui/tests/credit.test.ts` using `play(events[])` — contributors marked; dead branches excluded; **dangling message edge ignored** (ghost-edge filter); **dangling outcome `agent_id` → orphaned/unknown, no crash**; root-converging sink (demo_swarm's actual worker→lead→root pattern → "everyone reachable" limitation surfaced); `is_bottleneck` true for a single-path dominator, false for a fan-out node; SCC members grouped as `in_feedback_loop`; `credit === null` and `ci === null` for all structural rows; every row's `reason` cites a fact; `source==="llm_judge"` flagged non-grounded in the report.

**Phase C — Credit lens UI.** Mount the 4th view + `V`-cycle + TopBar toggle (exact sites §4.1; extract shared `ViewMode`); `CreditView` with the structural-facts table (no number in `credit` for Rung 1), provenance subgraph + dominator highlight, dead-branch + feedback-loop groups, honesty header + mandatory Rung-1 disclaimer + converging-topology warning; **CreditView-owned** export button merging credit into node-link JSON (graph.ts untouched). **Tests:** component test that `assignCredit` is memoized; the disclaimer and non-grounded flag render; the export payload carries `on_critical_path`/`is_bottleneck` and `graph.graph.credit`.

**Phase D — Ingestion adapters.** Claude Code transcript → events translator (golden JSONL: spawn via `meta.toolUseId`; `Agent`/`Workflow` as edges; denial-from-`is_error`; usage dedupe by `message.id`; compact_boundary stitching; `completed_at` carried; **per-key seq stamped**). OTel/OpenInference → events translator + relay `POST /v1/traces` receiver (golden OTLP/JSON: nearest-enclosing-agent walk; deprecated-name acceptance; derived cost + null on price miss; handoff→`agent_message`; `completed_at` from span end; **per-key seq stamped**). Both feed the same reducer; reuse `play`-style assertions; assert monotonic per-key seq.

**Phase E — Observer→orchestrator infra (gates Rungs 2–3).** Persistence (`run_id`, append-only log storing spawn-prompt+model replay seed) → re-run engine (Branching Replay generalized; `parent_run_id`/`ablated_agent_id` on `session_start`; `rerun_ablation` CommandKind) → dry-run/mock-side-effects mode (`dry_run` flag; per-call side-effect class; LLM/agent steps live-execute; deterministic external tools replayed/mocked `simulated:true`; **zero-external-side-effect guarantee test**). **Do not start Rung 2 until the dry-run guarantee has a passing test.**

**Phase F — Rung 2 (counterfactual ablation).** Paired-CRN estimator over the spawn-feasible closure; BCa paired-bootstrap CI; min-K guard; `low_power_unknown` vs `tight_null`; ratio rendering for unnormalized `score`; stale-baseline invalidation. **Tests** on a deterministic **injected** `v(·)` (no real LLM calls): estimator/CI correctness; CI-straddle → `low_power_unknown`; tight-zero → `tight_null`; spawn-cascade case (ablating a parent removes children, credit attributed to parent); stale baseline → invalidation.

**Phase G — Rung 3 (Shapley).** Mode A (classic, uniform full permutations, `v(S)=v(spawn-closure(S))`) **and** Mode B (precedence-constrained, named provably-uniform/importance-weighted linear-extension sampler); TMC with τ → `truncation_bias`; antithetic/stratified; nested Rung-2 sampler with documented CRN seed-sharing and `v̂` caching; **fresh-sample** `efficiency_residual_fresh`; BH-FDR `unknown`; `attribution` residual mass. **Tests:** closed-form game with known classic Shapley solution (Mode A recovers it within CI); a **tiny DAG where classic and constrained values provably differ** (assert the two modes produce the two different known values — guards against estimand/sampler bugs); by-construction residual ≈ 0 with shared draws + no truncation (and that it is NOT used as the check); `truncation_bias` grows with τ; `attribution.assigned + unattributed == total_reward`.

**Phase H — Rung 4 (densification).** Closed-form PBRS from `stage="intermediate"`, `scale="delta"` outcomes on a **separate** channel; learned redistribution (if built) tagged `assumed`/`densified`. **Tests:** per-handoff `γ·Φ(s′)−Φ(s)` math; densified credit on its own channel never overwrites the terminal channel; **no** policy-invariance-based ranking claim is asserted anywhere (Φ-choice carried as `assumed`).