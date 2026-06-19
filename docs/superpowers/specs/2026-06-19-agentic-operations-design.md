# Agentic Operations in AgentViz — Design Spec

> Status: APPROVED 2026-06-19. Owner approved a comprehensive ("ultracode") build:
> full operation framework + all op-types, both data sources (real Claude Code
> transcript ingestion + live SDK emission), and a new OPS lens + operation glyphs
> in the existing 3D/2D/FLOW views.
>
> Governing principle: GROUNDED ONLY. Every operation traces to a real tool-call or
> transcript fact. Unmeasured progress shows as honest-unknown, never faked.
> See [[feedback_grounded_over_llm_vibes]]. Purely additive: the existing four views
> and the credit engine stay intact; all current tests must remain green.

## 1. Problem

AgentViz has three structural primitives — **agents** (nodes), **tool calls** (leaf
ops on a node), **messages** (edges) — plus outcomes/credit. Every higher-order
agentic/workflow operation collapses into one of those and loses its essence:

- a `/loop`'s recurrence is invisible,
- a `Workflow`'s phase/pipeline/parallel structure flattens into anonymous spawn-edges,
- a `/schedule` (cron) cadence has no representation,
- a `Skill` (slash command) looks identical to any other tool call,
- plan-mode / worktree / background / monitor / todos are entirely absent.

Goal: make these **first-class, visualizable operations**.

## 2. The operation primitive

One generic, extensible envelope. Three new event kinds added to BOTH
`sdk/agentviz/events.py` (`EventKind`) and `ui/src/types.ts` (`EventKind` + the
`AgentVizEvent` union):

- `operation_start` — an operation begins
- `operation_tick` — a recurrence / progress beat (loop iteration, schedule fire,
  phase transition, goal-progress step)
- `operation_end` — an operation finishes

**New operation kinds are DATA, not code**: adding an op_type = one enum value + a
`detail` shape + one ingestion-registry row. No engine change.

### 2.1 Event shapes

```
OperationStartEvent:
  kind        = "operation_start"
  op_id:        str                # unique; default uuid
  op_type:      OperationKind      # the taxonomy discriminator (see 2.2)
  family:       OperationFamily    # derived from op_type via FAMILY_OF
  parent_op_id: str | None         # operations NEST (phase in workflow, tool in loop iter)
  agent_id:     str | None         # owning agent/context; null = session-level
  label:        str
  status:       "running" | "waiting" | "recurring"
  detail:       dict               # op-type-specific facts (see 2.3)
  timestamp:    float

OperationTickEvent:
  kind     = "operation_tick"
  op_id:     str
  n:         int                   # iteration / beat index (0-based)
  label:     str
  status:    "running" | "waiting" | "recurring"
  detail:    dict
  timestamp: float

OperationEndEvent:
  kind     = "operation_end"
  op_id:     str
  status:    "complete" | "error" | "stopped" | "expired"
  summary:   str
  detail:    dict
  timestamp: float
```

All three carry the existing `seq` + `run_id` stamping (reuse the relay transport;
no new transport). Ingestion replicates per-key seq stamping keyed on
`agent_id ?? "_session"`, exactly like `claudeCode.ts` does today.

### 2.2 Taxonomy (the "all operations" set)

`OperationKind` (Literal) and `OperationFamily` (Literal), with a single-source-of-truth
`FAMILY_OF` map duplicated in `events.py` and `types.ts`:

| family | op_type | grounded source (tool / transcript fact) |
|---|---|---|
| **recurrence** | `loop` | `ScheduleWakeup` with a fixed `delaySeconds`; `/loop <interval>` |
| recurrence | `goal` | self-paced loop (`ScheduleWakeup` w/ `<<autonomous-loop-dynamic>>` sentinel) |
| recurrence | `schedule` | `CronCreate` / `CronList` / `CronDelete` (cron routines) |
| **orchestration** | `workflow` | `Workflow` tool call (parse `meta.name` + `meta.phases`) |
| orchestration | `phase` | a phase parsed from a workflow's `meta.phases` (child of `workflow`) |
| orchestration | `spawn` | `Agent` / `Task` tool call (overlays the existing spawn-edge) |
| orchestration | `message` | `SendMessage` tool call |
| **command** | `skill` | `Skill` tool call (slash command); detail = skill name + args |
| command | `mcp` | `mcp__*` tool calls |
| **mode** | `plan_mode` | `EnterPlanMode` / `ExitPlanMode` |
| mode | `worktree` | `EnterWorktree` / `ExitWorktree` |
| mode | `background` | `run_in_background: true` on Bash/Agent |
| mode | `monitor` | `Monitor` tool call |
| mode | `remote` | `RemoteTrigger` / `isolation: remote` |
| **state** | `todo` | `TaskCreate` / `TaskUpdate` (todo list ticks) |
| state | `compact` | compact boundary line |
| state | `hook` | hook execution lines (PreToolUse/PostToolUse/Stop/...) |

Recurrence note: `/loop` (fixed interval), `/goal` (self-paced until a condition),
and `/schedule` (cron) are one family discriminated by op_type — exactly matching the
harness reality (`ScheduleWakeup` dynamic vs. CronCreate).

### 2.3 `detail` conventions (per family; all keys optional, present only when known)

- loop:      `{ interval_s, prompt, reason }`
- goal:      `{ prompt, reason, goal }`
- schedule:  `{ cron, next_fire, name }`
- workflow:  `{ name, description, phase_titles: string[] }`
- phase:     `{ index, title, detail }`
- spawn:     `{ agent_type, description }`
- skill:     `{ skill, args }`
- todo:      `{ total, completed, in_progress }`
- (others):  free-form; renderers must tolerate missing keys (honest-unknown).

## 3. SDK — live emission

New module `sdk/agentviz/operations.py`: the three dataclasses + `FAMILY_OF` +
`serialize`-compatible (reuse `events.serialize`). Add the three kinds to
`events.EventKind`.

`Session.operation(...)` and `Agent.operation(...)` — async context managers
returning an `Operation` handle:

```python
async with session.operation("loop", label="poll deploy",
                             detail={"interval_s": 300}) as op:
    for i in range(n):
        await op.tick(i, detail={"status_seen": "...", })   # one beat per iteration
    # auto-emits operation_end on __aexit__ (status from exception/return)
```

- `op.tick(n=None, *, label="", status="running", detail=None)` emits `operation_tick`.
- Nesting: `agent.operation(..., parent=op)` or an operation opened from an `Agent`
  wires `agent_id` + `parent_op_id`. Workflow→phase nesting via `parent`.
- `Operation` carries `op_id`, exposes `.tick()`, `.child(...)`.
- Export `Operation` from `sdk/agentviz/__init__.py`.
- Reuses existing seq-stamping (RelayClient `_stamp_seq`) + relay transport.

## 4. Ingestion — real Claude Code transcripts

New pure module `ui/src/ingest/operations.ts`, called from `claudeCode.ts`:

- A **registry** mapping tool name → `{ op_type, extractDetail(input), family }`.
- For each recognized tool_use block, emit `operation_start` (keyed to the owning
  agent), and on its matching `tool_result` (by `tool_use_id`) emit `operation_end`
  with `duration` in detail.
- **Recurrence collapse**: repeated `ScheduleWakeup` / cron fires that target the
  same prompt collapse into ONE operation with `operation_tick`s (one per fire).
- **Workflow phases**: parse the `meta = { ... phases: [...] }` literal out of the
  `Workflow` `input.script` string (regex/balanced-brace scan of the `meta` object;
  tolerate parse failure → workflow op with no phases). Emit a child `phase`
  operation per `meta.phases[i]` under the workflow op.
- `Skill` → `skill` op (detail = `input.skill` + `input.args`).
- `Agent`/`Task` keep their existing spawn-EDGE behavior in `claudeCode.ts`; the
  operations layer ADDS a `spawn` operation overlay (do not remove the spawn edge).
- Must not break the 75+ existing ingestion tests. The operations emission is
  additive: `claudeCode.ts` calls `operationsFromTools(...)` and merges, preserving
  existing event order/seq for non-operation events.
- `relay/src/replay-claude-code.ts` already reuses the `ui/` translator, so it
  inherits operations for free (verify the relay tsconfig still excludes cross-pkg).

OTel ingestion (`ui/src/ingest/otel.ts`) operation mapping is OUT OF SCOPE (documented).

### 4.1 Grounding corrections — verified against the real 50-transcript corpus (2026-06-19)

A post-build adversarial grounded-only audit checked every extractor against the actual
tool-input shapes in `~/.claude/projects/-Users-aaronwinegrad/*.jsonl`. Corrections applied:

- **todo**: real `TaskCreate` = `{subject, description, activeForm}` (one task, no id);
  real `TaskUpdate` = `{taskId, status}` (one status change). There is no `tasks[]` array.
  Ingestion now models a **single evolving todo op per agent**: `total` = creations seen,
  `completed`/`in_progress` derived from the latest status per `taskId`, accumulated across
  the stream; each subsequent TaskCreate/TaskUpdate is a tick. The `{tasks:[...]}` array is
  kept only as a fallback for the SDK live snapshot shape. (The store now merges each tick's
  measured detail into the op so the `X/Y done` subtitle reflects current state.)
- **schedule**: real `CronCreate` = `{cron, prompt, durable, recurring}` — no `name`. The
  grounded label is the `prompt`. The collapse key is `schedule:${cron}:${prompt}` so two
  distinct routines that share a cron expression (e.g. two `3 7 * * *` finance runs with
  different prompts) stay **distinct**, not merged. CronList (no cron) never collapses.
- **mcp**: an `mcp__<server>__<tool>` call now produces a `mcp` (command-family) op with
  `detail = {server, tool}` parsed from the name. Previously `mcp` was a declared op_type
  with no producer despite real `mcp__*` calls in the corpus.
- **loop vs goal**: the `<<autonomous-loop-dynamic>>` sentinel arrives in the **`prompt`**
  field (`delaySeconds` is always a clamped number), so the discriminator reads the prompt,
  not the delay. (Was previously checking `delaySeconds` against the sentinel → `goal` was
  never detected.)
- **recurrence is fixture-validated only**: `ScheduleWakeup` appears **0 times** in the
  current 50-transcript corpus, so the loop/goal path is exercised by
  `examples/fixtures/claude_code_operations.json` against the ScheduleWakeup tool schema, not
  by a captured real loop. When a real `/loop` or `/goal` run is captured, confirm the field
  names and add a corpus-derived fixture.

## 5. UI — store + OPS lens + glyphs

### 5.1 Store (`ui/src/store.ts`)
- Add `operations: Map<string, OperationState>` to `AppState`, reset on `session_start`.
- `OperationState`: `{ op_id, op_type, family, parent_op_id, agent_id, label, status,
  detail, ticks: OperationTick[], started_at, ended_at, end_status, children: string[] }`.
- Reducer cases: `operation_start` (create + link to parent's `children`),
  `operation_tick` (append), `operation_end` (set status/ended_at/summary).
- Push operation events to `timeline` (for FLOW) the same way narrative events are.

### 5.2 Layout (`ui/src/operations.ts`, pure + tested)
- Build the operation forest: top-level ops grouped by family, with nested children
  (workflow→phase→spawn). Recurrence ops expose their `ticks` as a sparkline series.
- Pure function `buildOpsLayout(operations)` → `{ groups: OpsGroup[] }` so it is unit
  testable independent of React.

### 5.3 OPS lens
- `ViewMode` gains `"ops"` (`types.ts`). `App.tsx` extends the V-cycle to 5-way and
  renders `OpsView` for `"ops"`. `TopBar.tsx` gets an OPS toggle (match existing
  toggle nth-child pattern). **Preserve the in-flight UX-makeover edits already in
  these files — add, don't overwrite.**
- `ui/src/components/OpsView.tsx`: grouped operation timeline.
  - recurrence ops: iteration sparkline + interval/`next_fire` label.
  - workflow ops: a phase ribbon with the parsed phase titles + nested fan-out.
  - skill/spawn/mode/state ops: labeled spans with status.
  - Honest empties: an op with zero measured ticks renders an explicit "no ticks
    recorded" rather than a fake progress bar.
- `styles.css`: `.ops-*` block consistent with the existing design system
  (Chakra Petch + IBM Plex Mono; existing CSS variables).

### 5.4 Glyphs in existing views
- `Scene3D.tsx` + `Graph.tsx`: a small operation badge on a node that owns a live
  operation — loop-ring `◌`, schedule-clock `⏱`, workflow phase-bars, skill glyph.
  (Reuse the existing per-node sprite/marker pattern; do NOT alter bloom constants —
  HANDOFF warns against it.)
- `flow.ts`: add `operation_start` / `operation_tick` / `operation_end` cases —
  a loop section, a phase band, a full-width schedule band. Keep them out of the
  GROUPABLE noise set where they are "the story" (like outcomes).

## 6. Demo + verification

- `examples/operations_demo.py`: a swarm exercising EVERY family — a `/loop`
  (interval), a `/goal` (self-paced), a `/schedule` (cron), a `Workflow` with 3
  phases + parallel fan-out, a couple of skills, plan-mode, worktree, a background
  task, and todos. Drives all glyphs + the OPS lens.
- Tests:
  - SDK `sdk/tests/test_operations.py` (TDD: start/tick/end, nesting, context-manager
    auto-end, agent vs session scope).
  - UI `ui/tests/operations.test.ts` (layout: families, nesting, sparkline).
  - UI `ui/tests/ingest_operations.test.ts` (against a real fixture with
    Workflow+Skill+Agent; phases parsed; recurrence collapse).
  - UI store test (operations aggregation + reset on session_start).
- Verify against a REAL transcript from `~/.claude/projects/-Users-aaronwinegrad/*.jsonl`
  that contains Workflow + Skill + Agent calls.

## 7. Acceptance / verification commands
- SDK:   `cd sdk && python3 -m pytest tests/ -q`   (all green, incl. new)
- UI:    `cd ui && npx vitest run && npx tsc --noEmit`   (all green, incl. new)
- Relay: `cd relay && npm test && npm run build`   (green)
- The existing four views and credit engine behave exactly as before.

## 8. Out of scope (documented)
- OTel operation mapping (`otel.ts`).
- `hook` and `compact` op_types: declared in the taxonomy (and emittable by the live SDK),
  but NOT produced by transcript ingestion in this pass — hooks/compact boundaries are not
  tool_use blocks, so there is no grounded tool-call to lift them from yet. Deferred.
- LangGraph/CrewAI operation emission (the adapters keep their credit focus).
- Persisting operations to the run recorder beyond what the existing event tee does
  (operations ride the same event stream, so they are recorded for free).
