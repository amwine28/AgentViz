## Phase E — The Re-Run Engine (Rung 2/3 LIVE)

> **SOURCE-ACCESS CAVEAT.** At authoring time the AgentViz source tree (`sdk/agentviz/*.py`, `ui/src/*.ts`, `relay/dist`) is macOS-TCC-walled from the design environment — Read, sandboxed/unsandboxed Bash, `open()`, and filesystem search all return `Operation not permitted`, and no wheel/sdist/mirror exists outside the wall. **However, this revision is no longer grounded in the prompt contract alone.** A live relay was running on `localhost:57761` and a baseline demo run was replayed off its WebSocket fan-out, yielding the **real, observed event schema** for `session_start`, `agent_spawn`, `agent_status`, `usage`, `agent_message`, `agent_complete`, `outcome`, and `credit_report` (a `rung2 demo: research pipeline` run with agents `planner → {retriever, reasoner, backup-reasoner, verifier, stylist}`). Every claim below tagged `[OBSERVED]` is grounded in those captured payloads; claims tagged `[VERIFY]` are still unconfirmed (they concern the Python *method shapes* and `counterfactual_credit`'s call contract, which the WS stream does not reveal). The first build step still diffs `[VERIFY]` points against the real signatures, but the keying and event-schema questions the prior draft deferred are now **answered**.

### E.0 What this phase delivers

Phase E turns the built-and-tested counterfactual math (`sdk/agentviz/counterfactual.py`) and the adversarially-verified safety layer (`Session(dry_run=True)`) into a **live re-run engine**: given an author's re-runnable workflow, it re-executes the workflow in `dry_run` mode per coalition with one agent (and its spawn-cascade) **ablated**, captures the terminal reward each time, feeds the measured rewards to `counterfactual_credit(...)`, and publishes a `credit_report` event. **Credit numbers are pure measured deltas of terminal reward across re-runs — grounded, never opinions.**

The hard part is the **ablation mechanism**: neutralizing an agent's *contribution* (not merely its side-effecting tools) inside a running Python workflow with minimal author cooperation, honoring the spawn-cascade, without falling into the §6.3 `v(N) == v(N\{i})` trap. The previous draft escaped the trap *partially*; this revision states the **exact, narrow precondition under which the escape is real** and enforces it as a hard, checkable contract rather than a footnote.

#### E.0.1 Ground-truth event schema `[OBSERVED]`

These shapes were captured verbatim from the live relay and are the contract the engine keys against:

```jsonc
// agent_spawn — identity is a GENERATED UUID; the human label is `name`; lineage is by parent UUID
{ "kind":"agent_spawn", "agent_id":"728020c5-…", "parent_id":null,           "name":"planner",   "run_id":"…", "seq":0 }
{ "kind":"agent_spawn", "agent_id":"ba099388-…", "parent_id":"728020c5-…",   "name":"retriever", "run_id":"…", "seq":0 }

// outcome — the run-level TERMINAL reward. agent_id is NULL (session-scope, not agent-scope).
// NOTE: the §6.2 branching fields ALREADY exist on this event and are forward-compatible.
{ "kind":"outcome", "agent_id":null, "channel":"answer_quality", "value":1, "scale":"binary",
  "stage":"terminal", "source":"eval_harness", "measured":true, "detail":{},
  "run_id":"…", "ablated_agent_id":null, "baseline_run_id":null, "baseline_value":null }

// credit_report — agents[] keys on `agent` = the NAME, NOT agent_id. credit_state ∈ {estimated, tight_null, …}; basis="measured".
{ "kind":"credit_report", "method":"counterfactual", "channel":"answer_quality",
  "agents":[ {"agent":"retriever","credit":0.7003,"ci":[0.6955,0.7051],"credit_state":"estimated","basis":"measured"}, … ] }

// session_start — does NOT yet carry parent_run_id/ablated_agent_id (only name/run_id/seq/timestamp). Those are additive (E.9).
{ "kind":"session_start", "name":"rung2 demo: research pipeline", "run_id":"…", "seq":0 }
```

**Four facts from this schema drive the whole design and overturn three of the prior draft's assumptions:**

1. **`agent_spawn.parent_id` is the parent's generated `agent_id` (UUID), not its `name`.** The prior draft's `parent_id in self._dead_agent_ids` (a set of names) would have **silently no-op'd** the structural cascade. Resolved in E.3.
2. **The canonical credit key is the `name`** (`credit_report.agents[].agent` is `"retriever"`, etc.), and **names are unique within the observed run.** So `counterfactual_credit`'s `agent_ids`, `live_set`, `AblationPlan.ablated`, and the published report **all key on NAME**. The prior draft's `agent_id`-keyed publish payload was wrong.
3. **UUIDs are minted fresh per spawn.** A re-run mints *new* `agent_id`s, so **ablation can never key by `agent_id`** — the id you ablate in run 2 does not exist in run 3. **NAME (run-stable) is the only viable ablation key**, with an id↔name map rebuilt per run for cascade translation.
4. **The terminal reward is a SESSION-scope `outcome` event (`agent_id:null`, `source:"eval_harness"`), not an agent-level call.** This re-anchors E.2 (capture) and E.4 (escape argument): the load-bearing suppression channels are *tool results and messages peers consume*, not agent-level `report_outcome`, which is demoted to a defensive guard.

### E.1 The correctness envelope — the trap escape is real ONLY inside this conjunction

The §6.3 trap is escaped **only** when all three of the following hold simultaneously. This is the single, conjoined **author contract**, stated up front (not scattered), because outside it the engine produces confidently-wrong numbers — the exact failure the grounded principle exists to prevent. The engine therefore **detects violations at runtime and refuses to report** rather than emitting ungrounded credit.

> **THE GROUNDING ENVELOPE (all three required):**
>
> **(C1) Reward purity.** The terminal `outcome` is a pure function of *SDK-channel* state — agent-emitted tool results, `agent_message`/log content, and the values the eval harness reads back through the SDK — and is emitted from **orchestrator/workflow scope** (`session`-level), never by an ablatable agent. `[OBSERVED: outcome.agent_id == null, source=="eval_harness".]`
>
> **(C2) Value flows through measurable (un-mocked) channels.** An ablated agent's peer-visible value must travel via channels the `dry_run` safety mock does **not** blank: (a) **live reasoning text** the SDK forwards (`agent_message`/log), (b) **`pure`** tool results, or (c) **`live_required`** tool results. **Value delivered through `external`/`replayable`/unknown tools is ALREADY mocked in *every* coalition** (see E.4 / Chain B) and is therefore *unmeasurable* by re-run unless that tool declares a deterministic `replay_value`.
>
> **(C3) No out-of-band dataflow.** No inter-agent value crosses a non-SDK channel: a Python return value the orchestrator `await`s, a shared dict/blackboard, a file written during `dry_run`, a global, or an env var. Idiomatic async Python passes results as **function return values**, which the SDK never sees — so this is the *default* shape of most workflows and the most likely violation.

The engine enforces this envelope with two runtime tripwires (E.3.1, E.4.1) and an acceptance gate (E.2.1). **The demo workflow (build slice 1) is purpose-built to satisfy C1–C3** — value flows only through `agent_message` and `pure` tool results, and the reward is read by an orchestrator-scope eval harness — so the first shippable slice **provably** escapes the trap, and the grounding is real rather than hoped-for.

### E.2 The ablation primitive — a second gate, orthogonal to the dry_run safety gate

Ablation is a **second gate, orthogonal to the `dry_run` safety gate**. The safety gate sits on `Agent.tool_call` and blanks *side effects*; the ablation gate sits one layer up, on **agent spawn**, and blanks an *agent's contribution to the terminal reward*. They live at different layers — that separation is what escapes the §6.3 trap (E.4) — and MUST stay distinct in code so a refactor never "unifies" them.

Ablation is a **first-class, additive parameter on `Session`** (not a monkeypatch of `session.agent`). First-class wins: unambiguous, testable, and not bypassable by how the author imports `agent`.

```python
# sdk/agentviz/rerun.py  (new module; packaged alongside counterfactual.py)

@dataclass(frozen=True)
class AblationPlan:
    ablated: frozenset[str]          # agent NAMES to neutralize this run; empty == baseline   [OBSERVED: name is the key]
    mode: str = "skip"               # "skip" only in slice 1; "default" optional; "expected" deferred (E.5)
    default_value: float | None = None
    body_policy: str = "short_circuit"   # "short_circuit" (default, also a tripwire) | "live" (opt-in; see E.4.1)
```

`Session` gains an **additive** surface (the existing positional signature `Session(name, port, autostart_relay, dry_run)` is unchanged):

```python
session.ablation: AblationPlan | None      # default None == no ablation                          [VERIFY attr name]
session._dead: set[str]                    # NAMES neutralized this run (cascade ground truth)
session._id_to_name: dict[str, str]        # built live this run: agent_id -> name (for parent_id translation)
session.last_outcome: dict[str, "Outcome"] # per-channel terminal outcome, set by report_outcome    [VERIFY / E.2.2]
session.parent_run_id: str | None          # §6.2 branching; stamped on the outcome event           [OBSERVED field exists]
session.ablated_agent_id: str | None       # §6.2; the NAME ablated this run; stamped on outcome     [OBSERVED field exists]
```

`session.agent(name, parent_id=None)` becomes ablation-aware. **`parent_id` is a UUID `[OBSERVED]`, so the cascade test translates it to a name via `_id_to_name`:**

```python
@asynccontextmanager
async def agent(self, name, parent_id=None, **kw):
    plan = self.ablation
    parent_name = self._id_to_name.get(parent_id) if parent_id else None   # UUID -> name  [OBSERVED parent_id is UUID]
    in_dead_subtree = parent_name is not None and parent_name in self._dead
    ablated_here = (plan is not None and name in plan.ablated) or in_dead_subtree
    a = _NeutralAgent(self, name, parent_id, plan) if ablated_here else Agent(self, name, parent_id, **kw)
    self._id_to_name[a.id] = name          # register THIS agent so ITS children can translate parent_id
    if ablated_here:
        self._dead.add(name)               # mark by NAME so descendants cascade (E.3)
    self._emit("agent_spawn", agent_id=a.id, parent_id=parent_id, name=name, ablated=ablated_here)
    try:
        yield a
    finally:
        self._emit("agent_complete", agent_id=a.id, exit_status="ablated" if ablated_here else "ok",
                   summary="", ablated=ablated_here)
```

`Agent` gains one query method; otherwise unchanged: `def is_ablated(self) -> bool: return False`.

**`_NeutralAgent`** — the contribution-suppressing drop-in, API-compatible with `Agent` so the **unchanged author workflow runs without edits**. Its `__init__` is shown explicitly (the prior draft omitted it — a no-op-by-crash risk):

```python
class _NeutralAgent(Agent):
    def __init__(self, session, name, parent_id=None, plan=None, **kw):
        super().__init__(session, name, parent_id, **kw)   # [VERIFY real Agent.__init__ signature]
        self._plan = plan
    def is_ablated(self): return True

    # tool_call — NEVER invoke fn. This is the ABLATION gate, NOT the dry_run safety gate. Keep separate.
    # Mirror the real Agent.tool_call's sync/async shape exactly.            [VERIFY async-ness]
    async def tool_call(self, name, args, fn, *, side_effect="external", replay_value=None, **kw):
        self.session._emit("tool_result", agent_id=self.id, name=name, simulated=True, ablated=True, result=None)
        return None

    async def report_outcome(self, value, channel=None, **kw):   # DEFENSIVE only — see C1; normally never reached
        self.session._emit("agent_outcome_muted", agent_id=self.id, channel=channel)   # auditable; NOT forwarded
    async def report_usage(self, *a, **k): return
    def log(self, *a, **k): return
    def set_status(self, *a, **k): return            # set_status is an emission channel too — mute for consistency
```

**Suppression is per peer-visible channel.** Per E.0.1 fact 4, the *load-bearing* channels are `tool_call` results peers read and `agent_message`/`log` peers consume; `report_outcome` suppression is a **defensive guard** for the rare agent that self-reports to the session channel (which C1 forbids anyway). `agent_spawn`/`agent_complete` still fire (with `ablated=True`) so the neutralized node stays **visible** in the append-only log and UI (§6.1/§6.2), preserving topology.

#### E.2.1 Reward capture — first-class, not monkeypatched (resolves the double standard)

The prior draft rejected monkeypatching `session.agent` but then monkeypatched `session.report_outcome` — the same fragility it disqualified. **Resolved: reward capture is first-class.** The terminal reward is read from `session.last_outcome[channel]` **after** `await workflow(session)` returns, with **zero patching**:

```python
def _read_terminal_reward(session, channel) -> tuple[float | None, bool]:
    oc = session.last_outcome.get(channel)            # [VERIFY Session exposes last_outcome; E.2.2 fallback]
    if oc is None or not getattr(oc, "measured", True):
        return None, False                            # NO measurement — honest unknown, NOT 0.0
    return float(oc.value), True
```

Reading an attribute after the run completes is robust to call-site and to internal-vs-external invocation — the exact failure modes that make a bound-method monkeypatch fragile. `[OBSERVED]` the `outcome` event already carries `value`, `channel`, `measured`, and `stage:"terminal"`, so the data the engine needs is exactly what the SDK already emits.

**E.2.2 fallback (if `Session` truly has no `last_outcome`):** inject capture through the **`session_factory` test seam** (E.6) by subclassing `Session` and overriding `report_outcome` at the **class** level in the engine-local subclass — never by reassigning a bound instance attribute. Same robustness, no global patch. This is `[VERIFY]`'d in build slice 1; if `last_outcome` exists, the subclass is unnecessary.

#### E.2.3 No-outcome vs measured-zero — distinguished at the math boundary

A coalition that *produced no terminal outcome* must be distinguishable from one that *measured a reward of 0.0* — otherwise `v(N)` itself becomes a mixture of real zeros and sentinel zeros and every marginal delta is polluted. The engine never returns a silent `0.0`:

- `_run_once` returns `None` (sentinel) when `_read_terminal_reward` reports `seen == False`.
- `v_fn` treats a `None` as a **dropped sample**: re-draw with a fresh seed up to `retry_cap` (default 2). If still `None`, the coalition is marked **under-sampled**. `[VERIFY counterfactual_credit can tolerate a dropped/NaN sample; if not, the engine raises and aborts the coalition rather than feeding a fake 0.0.]`
- **Acceptance gate (E.2.4):** before the full credit loop, run the **baseline grand coalition** `min_k` times; require `measured == True` on a configured fraction (default 1.0 for slice 1) and baseline variance below `tight_width`. If the baseline reward is flaky or absent, the engine **refuses to publish** a `credit_report` (honest-unknown) instead of grounding numbers on a flaky reward.

### E.3 Spawn-cascade — structural (ground truth) + closure (defensive), now correctly keyed

Dual enforcement, with the keying bug from the prior draft fixed:

1. **Structural (ground truth).** When an ablated parent yields a `_NeutralAgent`, its **name** is added to `session._dead`. Because `session._id_to_name` translates the child's `parent_id` (a UUID `[OBSERVED]`) back to the parent's name, the membership test `parent_name in self._dead` **now actually matches**. Two consequences hold: (a) a dead parent's children — spawned via `async with parent.agent(child)` routing through `session.agent` — become `_NeutralAgent`s; and (b) if the author wrote the natural `if agent.is_ablated(): return` early-exit, the parent's block never reaches its child-spawns. Either way the **entire spawn-feasible closure under the ablated node is neutralized**, matching §3.2.

   > **This was the prior draft's silent no-op.** The fix is the `_id_to_name` translation (E.2): without it, `parent_id in _dead` compared a UUID against names and never matched. The structural cascade does not function without this map; it is a **blocking precondition**, not a follow-up.

2. **Closure (conservative pre-filter).** The engine also supplies `counterfactual_credit`'s `live_set_for(removed, all) -> set`, computed from the **baseline run's observed** `agent_spawn` parent→child edges (translated to **names** via the baseline id↔name map):

```python
def live_set_for(removed, all_names):
    dead = set(removed)
    changed = True
    while changed:
        changed = False
        for child_name, parent_name in baseline_spawn_parent.items():   # names, from baseline observed edges
            if parent_name in dead and child_name not in dead:
                dead.add(child_name); changed = True
    return all_names - dead
```

**Resolving the topology-circularity contradiction (the prior draft said both "baseline" and "rebuilt per run").** `live_set_for` is fed to `counterfactual_credit` *before* any coalition runs, so it **cannot** depend on that coalition's own (unknown-in-advance) topology. The resolution, stated explicitly:

- **The closure is built ONCE from the baseline run and is a conservative pre-filter only.** Under data-dependent spawning it may be *stale* (a surviving agent might spawn different children when a sibling is gone). That is acceptable because:
- **The measured `v` from `_run_once` is ground truth.** `_run_once` reflects the *true* per-run topology: any descendant the ablated parent actually spawns becomes a `_NeutralAgent` via the structural rule (1), regardless of what the closure guessed. So the reward the math attributes to each coalition is correct **even when the closure over- or under-includes** in `dead`.
- The two layers therefore **do not need to agree**; the closure is a hint that tightens `counterfactual_credit`'s sampling, and the structural result is authoritative. Documented limitation: for highly dynamic spawning the closure may be conservative; an optional later refinement feeds each run's observed topology back to refine subsequent closures, but this is **not** required for correctness.

#### E.3.1 Tripwire #1 — cascade integrity

After each ablated run, the engine compares the run's observed `agent_spawn` set against the baseline's. If an agent whose baseline parent is in `ablated` appears **live (not `ablated=true`)** in the re-run, the cascade leaked (e.g. the author spawned a child through a non-SDK path). The engine flags the coalition `under-measured` and the affected agents' `credit_state` accordingly — it never reports a silently-inflated parent credit.

### E.4 The §6.3 trap — escaped ONLY for un-mocked channels (the headline precondition, not a footnote)

The prior draft claimed "the safety mock blanks side effects whereas ablation blanks the information/value contribution." **That is FALSE whenever the information contribution is delivered via a mocked tool result** — the single most important correction in this revision.

**Chain B (the tool-mediated trap), stated plainly.** The `dry_run` choke point already **mocks** `external`/`replayable`/unknown tools in **both** coalitions: in baseline, agent *i*'s LLM-as-a-tool / API call returns a *synthetic mock value*, not its real production output; under ablation, `_NeutralAgent.tool_call` returns `None`. The measured delta is then `mock-value − None` — **a difference between two synthetic placeholders, not a measure of agent *i*'s causal contribution**, which the safety layer erased in every coalition. For the very common pattern "an agent whose value to peers *is* the result of an external/LLM tool call," `v(N) == v(N\{i})` up to placeholder noise and **credit collapses — exactly the trap claimed defeated.**

**The escape is real ONLY for value flowing through channels the mock does NOT blank:**

- **Live reasoning text** the SDK forwards (`agent_message`, `log`) — runs live in baseline, muted under ablation → genuine delta. `[OBSERVED: agent_message carries from/to/content; this is the demo's value channel.]`
- **`pure` tools** — execute in both coalitions in baseline (whitelisted), muted under ablation → genuine delta.
- **`live_required` tools** — same.
- **`external`/`replayable`/unknown tools** — *unmeasurable by re-run* unless the tool declares a deterministic **`replay_value`**, in which case baseline carries that recorded stand-in and ablation's `None`/absence is a genuine delta from a real recorded value.

**Consequences, enforced:**

- **(C2) above is the precondition.** The engine does not assume it; it **detects** external/replayable tool calls during the baseline run (their `tool_result` carries `simulated=True` with no `replay_value`) and, if any agent's *only* peer-visible output is such a call, marks that agent **`unmeasurable_by_rerun`** with `credit_state` reflecting it — and recommends the **surrogate-`v_fn` counterfactual** path (Rung 2 with a recorded/static value function) instead of live re-run.
- **The demo MUST exercise the live-reasoning / `pure`-tool path** so the first slice's escape is provable. `[OBSERVED]` the captured demo already does exactly this (`agent_message: "retriever contributed"` is the value channel; no external tools in the value path).

#### E.4.1 Tripwire #2 — out-of-band dataflow (C3), and the body-policy decision

The prior draft's resolution #3 ("run the ablated body live, suppress only emissions") is **reversed** for the default, on the third reviewer's correct argument: idiomatic Python passes inter-agent value as **function return values** the SDK never touches, so a live body that returns its real Python value to an `await`-ing orchestrator leaks the contribution and `v(N\{i}) == v(N)` silently.

- **Default `body_policy="short_circuit"`:** a `_NeutralAgent`'s reasoning body is **not run**; the `async with session.agent(name)` context yields a `_NeutralAgent` whose body the engine **short-circuits** (the contract is that the author's per-agent body is wrapped so an ablated agent returns a typed **`Ablated` sentinel**). **This doubles as Tripwire #2:** if short-circuiting breaks the orchestrator's downstream plumbing (because it `await`ed a real return value), the run fails loudly with an `OutOfBandDataflow` diagnostic naming the agent — that failure *is the signal* that the workflow violates C3, exactly the honest-failure the grounded principle demands. Short-circuiting is the only way to **ground** the absence; running the body live and muting emissions is hope.
- **Opt-in `body_policy="live"`:** for workflows the author has **proven** route all value through SDK channels (and where ablated-body LLM latency / scheduling perturbation is acceptable), the body may run live with emissions muted. This is an explicit, documented opt-in, never the default.
- Either way the safety invariant holds: a baseline (non-ablated) run is identical to a normal `dry_run`; only ablated agents are short-circuited.

**Net:** the trap is escaped because, inside the C1–C3 envelope, a non-ablated agent's full reasoning runs live (real LLM/planning, tools under the normal whitelist), while an ablated agent contributes **nothing** — body short-circuited, peer-readable channels muted, subtree neutralized — so the terminal reward genuinely shifts iff agent *i* mattered. Outside the envelope, the engine **refuses to report** rather than emitting confidently-wrong numbers.

### E.5 Neutralization modes

- **`skip`** (the only mode in slice 1; canonical for counterfactual credit): ablated agent contributes nothing. `v` measures pure absence.
- **`default`** (optional, post-slice): the ablated agent's would-be downstream-consumed value is replaced by `AblationPlan.default_value`. Use only when downstream code requires *some* value to proceed; `_NeutralAgent.report_outcome`/sentinel must guard against `default_value is None` (raise a clear error, never propagate `None` into a NaN/crash).
- **`expected`** — **deferred out of the first slice.** As written in the prior draft it was **circular**: `expected_value` was "computed from the K measured runs," but those runs are the very evaluations that need `expected_value` set *before* they execute. When implemented later it requires an explicit **two-pass** protocol (pass 1 in `skip` to estimate the marginal-baseline distribution; pass 2 re-runs with `expected_value` frozen from pass 1), roughly doubling re-run cost (relevant to the E.7 budget guard). Until then, `expected` raises `NotImplementedError` — never silently substitutes `None`.

### E.6 Engine entrypoint, threading model, and control flow

**The sync/async impedance is resolved in the design, not deferred to a spike.** The prompt's `v_fn(live_set: set[str], sample: int) -> float` is **synchronous**. `counterfactual_credit` calls it synchronously. Therefore:

> **THREADING MODEL (load-bearing):** `measure_credit_by_rerun` is a **plain `def`**, not `async`. It calls `counterfactual_credit` directly (no outer event loop is held). The synchronous `v_fn` drives the async workflow via **`asyncio.run(_run_once(...))` — one fresh loop per coalition run.** Because no outer loop is running, there is no `RuntimeError: asyncio.run() cannot be called from a running event loop`, and each run's Session/relay objects have clean single-loop affinity. If the caller is itself async, it offloads via `await asyncio.to_thread(measure_credit_by_rerun, ...)` so the engine still owns no running loop on its thread. `[VERIFY counterfactual_credit does not itself require/spawn a loop; if it can accept an async v_fn, that is a strictly simpler alternative confirmed in slice 1.]`

```python
# sdk/agentviz/rerun.py
def measure_credit_by_rerun(            # SYNCHRONOUS top-level — owns no running loop
    workflow,                           # async def workflow(session: Session) -> None  (author writes ONCE)
    agents: list[str],                  # coalition universe N — agent NAMES  [OBSERVED: name is the key]
    *,
    samples: int = 64, seed: int = 0,
    channel: str = "answer_quality",    # which terminal `outcome` channel is the reward  [OBSERVED channel name]
    parent_run_id: str | None = None,   # the original run this family explains (§6.2)
    relay_port: int = 0,                # 0 == let the engine-owned relay pick a free port  [OBSERVED dynamic-port behavior]
    min_k: int = 3, alpha: float = 0.05, tight_width: float = 0.05,
    mode: str = "skip", body_policy: str = "short_circuit",
    deterministic: bool = False,        # if True, collapse samples per coalition (E.7); validated, not trusted
    retry_cap: int = 2, budget_max_runs: int | None = None,
    session_factory=None,               # test seam; defaults to engine-owned dry_run Session subclass
) -> list[CounterfactualResult]: ...
```

**Relay ownership (resolves the fresh-session/single-port underspecification).** The engine **owns ONE long-lived relay for the whole family**: it autostarts a relay once on a free port `[OBSERVED: relay falls back from 3333 to a free port and prints it]`, keeps it alive across all `N×K` runs, and tears it down at the end. Each per-run `Session` *attaches* to that relay; `run_id` `[OBSERVED on every event]` disambiguates the interleaved streams. A missing relay can therefore never silently drop the terminal `outcome`.

**Concurrency.** `max_concurrency=1` is the **only supported mode** and is not exposed as a tunable knob in slice 1. Concurrent `dry_run` sessions on one relay plus one shared recorder have unverified flush/close race semantics; `>1` stays unshipped until proven race-free. Serialization also gives deterministic ordering and is the simplest correct thing.

Control flow:

1. **Baseline + topology + acceptance gate.** Run the grand coalition (`ablated=∅`, `dry_run=True`) `min_k` times. From these: (a) confirm/obtain `baseline_run_id` (becomes the family's `parent_run_id`); (b) build `baseline_spawn_parent` (name→name, via the id↔name map) for `live_set_for`; (c) run the **E.2.4 acceptance gate** (reward present + variance < `tight_width`); (d) detect external/replayable-only agents and mark them `unmeasurable_by_rerun` (E.4). Cache `v(N)` from the measured baseline.
2. **`v_fn` per coalition.** `counterfactual_credit` drives the loop. For each `(live_set, sample)` the engine computes `ablated = set(agents) - set(live_set)` and runs the workflow once in a fresh `dry_run=True` Session carrying `AblationPlan(frozenset(ablated), mode, …, body_policy)`.

   **Memoization keyed correctly (resolves the CI-collapse critical):**

```python
def v_fn(live_set, sample):
    key_det   = frozenset(live_set)
    key_stoch = (frozenset(live_set), sample)
    cache = self._cache
    if deterministic:
        # collapse K samples to one execution — ONLY when determinism is asserted AND validated
        if key_det not in cache:
            cache[key_det] = self._run_with_retries(ablated=set(agents)-set(live_set), sample=sample)
        return cache[key_det]
    # stochastic (the DEFAULT for real LLM workflows): key on (live_set, sample) so each of the K
    # paired draws is a REAL execution; CIs reflect true within-coalition variance — never fabricated.
    if key_stoch not in cache:
        cache[key_stoch] = self._run_with_retries(ablated=set(agents)-set(live_set), sample=sample)
    return cache[key_stoch]
```

   The prior draft keyed on `frozenset(live_set)` alone, which **discarded `sample`, ran each coalition once, and replicated that one float K times → a fabricated ~0-width CI**. Fixed: stochastic is the default and keys on `(live_set, sample)`; determinism is an explicit flag, **validated** by running 2 seeds of the baseline and asserting equality before any collapse — never trusted on the author's say-so.
3. **`_run_once`** hard-codes `dry_run=True` (the safety invariant — **no code path in the engine constructs a non-`dry_run` Session**), attaches to the engine-owned relay, installs the `AblationPlan`, threads `seed = base_seed + sample` so author stochasticity is reproducible and **common-random-numbers paired sampling** across coalitions keeps CIs tight, `await`s the workflow inside its own `asyncio.run`, then reads `session.last_outcome[channel]` (E.2.1). Returns the float or the `None` sentinel (E.2.3).
4. **Budget guard with all-or-nothing semantics.** A real-execution counter is incremented per `_run_once`. **Up-front estimate:** stochastic cost is `O(|coalitions visited| × samples)` real LLM runs (not the prior draft's optimistic `O(coalitions)`); the engine computes the estimate from `N` and `samples` and surfaces it for operator approval **before** running. Hitting `budget_max_runs` yields **no partial report**: it returns results with **every** agent's `credit_state` set to `insufficient`/`under-measured`, never a report that looks complete. `credit_state` is tied to whether each agent's coalitions reached `min_k` real samples.
5. **Feed the math (unchanged).** `counterfactual_credit(agent_ids=agents, v_fn=v_fn, samples=samples, seed=seed, min_k=min_k, alpha=alpha, tight_width=tight_width, live_set_for=live_set_for)`.
6. **Publish.** Open one final `dry_run=True` reporting Session carrying `parent_run_id`, and emit a `credit_report` with the **observed payload shape** — agents keyed on `agent` = NAME, `method="counterfactual_rerun"`, `basis="measured"`:

```python
session.report_credit(
    method="counterfactual_rerun",
    channel=channel,                    # "answer_quality" in the demo  [OBSERVED]
    agents=[
        {"agent": r.agent_id,           # r.agent_id IS the NAME for this engine (E.0.1 fact 2); join key for the UI
         "credit": r.credit, "ci": list(r.ci),
         "credit_state": r.credit_state, "basis": "measured"}
        for r in results
    ],
)   # [VERIFY report_credit's element schema; matched to the OBSERVED credit_report.agents[] shape above]
```

`method="counterfactual_rerun"` distinguishes live re-run-backed credit from a surrogate-`v_fn` counterfactual in the UI (the observed demo used `"counterfactual"` for the surrogate path).

### E.7 Determinism, cost, and CIs

Re-run deltas must reflect *ablation*, not LLM nondeterminism. **Default = stochastic**: K real executions per visited coalition with `seed = base_seed + sample` (common random numbers / paired sampling across coalitions for variance reduction), and the measured variance flows honestly into the CI via `alpha`/`tight_width`. **`deterministic=True` is an opt-in, validated** (E.6 step 2): only then do K samples collapse to one execution, and the CI is reported as a (degenerate) point estimate, with `samples` then affecting only the permutation sampling over coalitions. The two models are no longer mutually contradictory (the prior draft wanted both). Cost telemetry (real-execution count) and the `budget_max_runs` guard are first-class (E.6 step 4). K live re-runs are **safe** (`dry_run` ⇒ zero real side effects) but not free.

### E.8 Agent-id keying — RESOLVED (was [VERIFY], now grounded)

`[OBSERVED]` resolves what the prior draft deferred:

- **The canonical ablation/credit key is the `name`.** `credit_report.agents[].agent` is the name; names are unique within the observed run; `counterfactual_credit`'s `agent_ids` and the published report both key on name.
- **`agent_spawn.agent_id` is a fresh UUID per spawn** ⇒ id-keying is impossible across re-runs (the id you ablate never reappears). Name is the only run-stable key.
- **`agent_spawn.parent_id` is the parent's UUID** ⇒ the cascade must translate `parent_id → name` via `session._id_to_name` (E.2/E.3). This is a **blocking precondition**, not a footnote.
- **Residual `[VERIFY]`s** (genuinely unobservable from the WS stream): (i) whether `Agent.tool_call`/`report_outcome` are coroutines (`_NeutralAgent` must mirror exactly, or the "no author edits" claim breaks); (ii) whether `Session` exposes `last_outcome` (else use the E.2.2 class-subclass capture); (iii) whether `counterfactual_credit` tolerates a dropped/`None` sample (E.2.3); (iv) `CounterfactualResult` field names (`agent_id` vs `agent`). **Duplicate-name safety:** if a future workflow spawns two agents with the same `name`, name-keying would ablate both together and `baseline_spawn_parent` would collide. The engine therefore **asserts name-uniqueness during baseline topology discovery** and refuses to run (honest-unknown) if names collide; a later enhancement keys on `(name, spawn_ordinal)` — out of scope for slice 1.

### E.9 Persistence + schema/UI branching (later steps)

Deliberately **after** the live slice — the engine works in-memory without persistence; persistence makes the family durable and the UI branch-aware.

- **Append-only recorder (relay, TS).** Tee the relay's existing WS fan-out to disk: one JSONL per run at `~/.agentviz/runs/<run_id>.jsonl` (`run_id` `[OBSERVED]` on every event ⇒ the filename is the key). Tee **independently of WS delivery** (must not drop under backpressure/disconnect). **Close-and-fsync each run's file on that run's `session_complete`/terminal `outcome`, NOT on idle TTL** — the prior draft's idle-TTL close could truncate the terminal reward under the rapid sequential re-runs this engine produces. Route each event to its `run_id`'s handle; flush+close all open handles on harness shutdown. Idle TTL is a crash-only fallback. `[VERIFY exact fan-out hook in relay.ts; ~/.agentviz/runs/ does not yet exist — OBSERVED absent.]`
- **`events.py` / schema additions (additive, nullable).** The `outcome` event **already carries** `parent_run_id`-equivalent fields — `[OBSERVED]` `outcome.{ablated_agent_id, baseline_run_id, baseline_value}` exist and are null in baseline — so §6.2 branching needs little new schema. Add `session_start.{parent_run_id, ablated_agent_id}` (additive; `[OBSERVED]` they are absent today) so a branch is identifiable from its first event, not only its outcome. `[VERIFY the UI/relay validator accepts extra/unknown fields.]`
- **New `CommandKind: rerun_ablation`** `{ baseline_run_id, ablated_agent_id (NAME), samples, seed, channel }` — emitted by UI/operator, consumed by the harness, which mints a **fresh uuid per re-run** (never reuses `baseline_run_id`) with `parent_run_id` pointing back. `[VERIFY CommandKind enum + command channel shape.]`
- **UI branch-grouping (observer-safe).** Group `~/.agentviz/runs/*.jsonl` by `parent_run_id` (null ⇒ baseline; non-null ⇒ ablation branch labeled by `ablated_agent_id`). The §6.2 "Branching Replay generalized" tree — pure read/append, no workflow mutation.
- **Replay-off-recorded-run optimization (§6.1).** §6.1 persists `spawn_prompt + model` per agent; a later step rebuilds workflow inputs from the baseline JSONL and reads `v(N)` from the recorded terminal `outcome` instead of re-running the grand coalition. `[VERIFY spawn_prompt+model appear in agent_spawn/usage; OBSERVED usage carries model + cost_usd but NOT spawn_prompt — prompt persistence is unconfirmed.]`

### E.10 Conflicts resolved (delta from prior draft)

1. **Ablation integration point** → first-class `AblationPlan` on `Session`, honored in `session.agent()`. (Unchanged; reaffirmed.)
2. **Where v(C) comes from** → the SESSION-scope terminal `outcome` event, read first-class from `session.last_outcome[channel]` after the run — **not** a monkeypatch, and **not** the agent-level `report_outcome` (which is demoted to a defensive guard). `[OBSERVED outcome.agent_id==null.]`
3. **Ablated body** → **default short-circuit** (also a C3 tripwire); live-body is an opt-in. *Reversed* from the prior draft on the third reviewer's grounding argument.
4. **`method=` string** → `"counterfactual_rerun"` (distinct from the observed surrogate `"counterfactual"`).
5. **Spawn-cascade** → dual, with the **keying bug fixed** via `_id_to_name` translation (structural ground truth) + a baseline-built conservative closure (the measured `v`, not the closure, is authoritative; circularity dissolved).
6. **Persistence** → kept later; recorder closes on `session_complete` not idle TTL; §6.2 fields confirmed to already exist on `outcome`.
7. **Sync/async** → engine is **synchronous top-level**, `asyncio.run` per coalition; resolved in-design.
8. **Keying** → **name** is canonical (`[OBSERVED]`); was a deferred `[VERIFY]`, now grounded and made a blocking precondition.
9. **No-outcome vs measured-zero** → sentinel + retry + acceptance gate; never a silent `0.0`.
10. **`expected` mode** → deferred (was circular); `skip` only in slice 1.
11. **Relay ownership / concurrency** → one engine-owned long-lived relay; `max_concurrency=1` only supported mode.
12. **`report_credit` payload** → matched to `[OBSERVED]` shape: `{"agent": NAME, "credit", "ci", "credit_state", "basis":"measured"}`.