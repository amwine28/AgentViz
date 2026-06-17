# AgentViz Overhaul — Live Handoff

> Resume protocol: if a session picks this up after a usage-limit cutoff, read this file
> top to bottom, run the verification commands in "How to verify", and continue from the
> first unchecked task. CLAUDE.md (AgentViz directive v2)
> governs; owner approved a full autonomous overhaul on 2026-06-11 ("agent viz to the
> maximum"): 3D world + slash command + reliability spine, no per-task approval needed.
>
> REPO MOVED 2026-06-16: now at ~/dev/AgentViz (was ~/Desktop/AgentViz). macOS TCC blocks
> per-version Claude Code binaries from the Desktop folder — it broke ALL repo access mid-
> session (getcwd/read EPERM). ~/dev is not TCC-protected, so it can't recur. After any
> fresh clone/move, run `pip install -e ~/dev/AgentViz/sdk` to re-point the editable SDK.
>
> ACTIVE: building the re-run engine (Phase E) — see docs/credit-assignment-phaseE.md.
> DONE: Slice 1 (1d9ce54) — _NeutralAgent ablation + _dead_ids cascade + measure_credit_by_rerun;
>   live demo (7a6e46a) measures causal credit by REAL re-execution (every run dry_run-safe).
>   Slice 3 — acceptance gate / honest-unknown: RerunRefused when baseline reward absent/flaky;
>   _run_once returns None (not silent 0.0) for no-measurement. 50 sdk tests green.
> REMAINING slices (all fully local, no wifi/browser needed): Slice 2 (closure live_set_for +
>   Tripwire #1 cascade-integrity); Slice 4 (stochastic CRN + real CIs + budget guard — demo
>   currently deterministic so CIs are points); Slice 5 (relay JSONL recorder keyed by run_id +
>   UI run-branch view). NOTE: commits 1d9ce54/7a6e46a + slice 3 are LOCAL — push pending wifi.

## Mission
- Spectacular 3D live agent world (3d-force-graph + bloom), 2D/3D toggle, approval queue
- /agentviz slash command (~/.claude/commands/agentviz.md) + launcher script + demo swarm
- Reliability: seq numbers + drop detection, 50k session-scoped buffer, fail-open SDK
  with reconnect, command acks, auto port selection (~/.agentviz/relay.json)

## Task status
- [x] Task 1 (prev session, committed? NO — working tree has uncommitted Task-1 changes):
      deny-on-timeout default, tool_denied event, UI store case, integration test. All green.
- [x] Task: Reliability spine — DONE. SDK stamps per-agent seq (relay_client._stamp_seq);
      store trackSeq computes droppedCount/eventCount; session_start resets buffer (relay)
      and store state. 18 sdk pytest + 5 relay jest + 16 ui vitest green, tsc clean.
- [x] Task: Fail-open SDK — DONE. RelayClient rewritten: queue+background task, reconnect
      w/ backoff, bounded 10k buffer drop-oldest, command_ack on cmd_id (handlers return
      bool = applied). agent.log(), async fn in tool_call, timeout_s on pending event.
- [x] Task: Relay — DONE. 50k buffer, session_start clears buffer, index.ts auto-port
      (EADDRINUSE→ephemeral), writes ~/.agentviz/relay.json {port,pid}, SIGINT/TERM cleanup.
      Session._resolve_port reads port file. relay/dist rebuilt.
- [x] Task: 3D world — DONE. Scene3D.tsx (3d-force-graph 1.80 + UnrealBloomPass 0.6/0.35/0.15,
      halo sprites 13u @0.38 — DO NOT crank these up, v1 at 1.25/22u/0.85 blew out the frame),
      pulsing billboard approval rings, emitParticle per message, starfield, fly-to camera,
      auto-orbit until interaction. New TopBar/ApprovalQueue (countdowns + ack states)/
      NodeDetailPanel/MessageThread on styles.css design system (Chakra Petch + IBM Plex Mono).
      2D/3D toggle hotkey V. ws.ts reconnects w/ backoff, stamps cmd_id.
- [x] Task: /agentviz — DONE. ~/.claude/commands/agentviz.md, scripts/agentviz.sh
      (build-if-needed, relay-alive check via port file, --demo/--rebuild/--no-browser),
      examples/demo_swarm.py (3 squads, rogue-probe error, 2 held approvals 45s).
- [x] Task: E2E verify — DONE. All suites green (18 sdk / 5 relay / 16 ui / tsc),
      integration_test passes, demo swarm screenshot verified visually.
      Bug found+fixed: ws re-emits EADDRINUSE on wss → crash; no-op wss error listener
      added so http server's ephemeral-port fallback works (verified: picked 56027).

## Status: OVERHAUL COMPLETE (2026-06-11). Pushed to GitHub 2026-06-14.

## Post-overhaul additions (2026-06-12)
- Brightness fix: labels depthTest=false + renderOrder 999 + y=11.5; halo 9u @0.18;
  bloom 0.3/0.25/0.35 (dimmed twice — DO NOT raise) — labels readable over glow.
- FLOW view (3rd renderer): store.timeline (narrative events, cap 5000, reset on
  session_start) → flow.ts buildFlowLayout + groupFlowRows (collapsible sections) →
  FlowView.tsx SVG swimlanes. Toggle is 3D/2D/FLOW, V cycles.
- Graph analytics: ui/src/graph.ts (pure, tested) — node feature vectors, weighted
  edges, Brandes betweenness, hub/bottleneck/isolates, NetworkX node-link export.
  GraphStats.tsx panel (2D view) + ⇩ export button.
- Efficiency audit: ui/src/audit.ts (pure, tested) — grounded 0-100/A-F score; rules:
  dead_weight, error_exits, denied_tools, duplicate_roles, token_skew. Every penalty
  traces to a fact. SDK agent.report_usage() emits `usage` events; store aggregates.
- Pending idea (NOT built): "Architect mode" — design hierarchy in the viz, Claude Code
  spawns real agents matching it.

## Shipped to GitHub (2026-06-14)
- Repo: https://github.com/amwine28/AgentViz (public, MIT). Remote `origin` set, on main.
- README.md (hero GIF docs/assets/agentviz-demo.gif), LICENSE (MIT), commands/agentviz.md
  (repo-portable slash command). GIF recorded via headless Playwright → Pillow in an
  isolated venv (/tmp/gifenv — system Pillow is x86_64-broken on this arm64 box).

## ACTIVE WORKSTREAM: Credit Assignment (started 2026-06-14, "ultracode" build)
Owner asked to build, from the ground up, very thorough, with cross-session continuity:
multi-agent CREDIT ASSIGNMENT under sparse reward — attribute a final outcome to the
agents that earned/caused it across a chain of handoffs. NON-NEGOTIABLE: grounded only
(graph structure / counterfactual measurement / Shapley axioms), NEVER LLM "rate this
agent" vibes; confidence intervals over false precision. [[feedback_grounded_over_llm_vibes]]

Design ladder: Rung 1 provenance/reachability (deterministic, observer-only, SHIP FIRST);
Rung 2 counterfactual leave-one-out via ablation replay (needs re-run engine + N samples/CIs);
Rung 3 Shapley (DAG-feasible coalitions + Monte-Carlo); Rung 4 reward densification.
Rungs 2-3 require observer→orchestrator + dry-run/mock-side-effects mode.

- [x] Design phase DONE (wf_c53a4c8b-d7f, 10 agents/836k tok). docs/credit-assignment.md
      (689 lines) is the SOURCE OF TRUTH. Adversarial critique found 9 critical/12 major/9
      minor; revision 2 fixed all 9 critical (Shapley axiom misuse, biased estimator/#P-hard
      linear-extension sampling, TMC bias, efficiency-residual=0-by-construction, FLOW no-op,
      ghost-edge filter, sink inference needs completed_at, converging-topology inversion,
      ingested events bypass seq-stamper). Read §0 changelog + §2/§3 before coding.

  Build plan (8 phases; TDD; A→B→C→D is the Rung-1 shippable slice):
  - [x] Phase A DONE — outcome primitive end-to-end (events.py OutcomeEvent, agent/session
        report_outcome, types.ts, store outcomes aggregation + completed_at/exit_status,
        FLOW outcome case). 22 sdk / store+flow tests green. Committed.
  - [x] Phase B DONE [SHIP] — Rung 1 ui/src/credit.ts assignCredit(state): ghost-edge filter,
        Tarjan SCC, sink resolution (agent-scoped/result_agent_ids/root-converging), reverse-
        reachability on_critical_path, removal-based dominator is_bottleneck, dead_branches,
        feedback_loops; credit=null/ci=null; buildCreditExport + RUNG1_DISCLAIMER. ui/tests/
        helpers.ts (shared play), credit.test.ts (13). Committed.
  - [x] Phase C DONE [SHIP] — Credit lens (4th view). ViewMode in types.ts; App.tsx 4-way
        V-cycle + render; TopBar CREDIT toggle (nth-child(7)); CreditView.tsx (honesty header,
        outcome chip w/ grounded flag, Rung-1 disclaimer, converging warning, contributors
        facts table w/ badges + NO causal number, dead-branch + feedback-loop groups, credit-
        owned export). examples/credit_demo.py (clean DAG: bottleneck chain + slacker dead
        branch). Verified in browser (agentviz-credit2.png). 57 ui green.
        NOTE: demo_swarm.py now emits per-agent 'quality' + run-level 'mission' terminal
        outcome; its converging topology makes Credit honestly show the feedback-loop case.
  - [~] Phase D [SHIP] — ingestion. DONE: ui/src/ingest/claudeCode.ts (pure translator) +
        examples/fixtures/claude_code_session.json + ui/tests/ingest_claudecode.test.ts (8).
        Maps spawn hierarchy via meta.toolUseId, tool calls/results, denial-from-interrupt,
        usage dedupe by message.id, tool_use dedupe by block id, upward handoff + completion,
        per-key seq stamping. VERIFIED on a REAL 10-subagent session (307 events, 11 agents,
        credit runs → 1 feedback loop = honest converging topology). 65 ui tests green.
        (1) Runnable replay-to-relay wiring — DONE. relay/src/replay-claude-code.ts
            (ts-node --transpile-only; `cd relay && npm run replay -- <session.jsonl>
            [--speed=N] [--outcome=1]`), reuses the shared ui/ translator (relay tsconfig
            EXCLUDES the file so cross-package import doesn't break tsc build). Launcher flag
            `agentviz.sh --replay <jsonl> [--outcome=1]`. VERIFIED end-to-end: replayed the
            real professor-outreach session (308 events) → browser CREDIT lens rendered all
            11 real subagents, honestly flagged the converging feedback loop + assumed root
            sink + "run Rung 2" warning. README "Replay a real Claude Code session" section added.
        (2) OTel/OpenInference adapter — DONE. ui/src/ingest/otel.ts (pure translator):
            OTLP/JSON → events; gen_ai.* + OpenInference (openinference.span.kind,
            llm.token_count.*, llm.cost.total, graph.node.*); nearest-enclosing-agent walk =
            handoff DAG; deprecated attr names; cost = instrumentation > versioned price table >
            null (never guessed); handoff spans → agent_message; per-key seq. Fixtures:
            otel_openai_agents.json + otel_openinference.json. ui/tests/ingest_otel.test.ts (10).
            relay/src/otel-receiver.ts: ts-node HTTP bridge, POST /v1/traces (:4318) → translate →
            forward to relay /sdk (tsconfig EXCLUDES it; npm run otel-receiver). VERIFIED:
            curl POST fixture → HTTP 200 → 11 events → browser showed "trip-planner" 2 agents.
            README "Ingest from OpenTelemetry" section added. 75 ui tests green.

  ## Phase D COMPLETE (Claude Code replay + OTel ingest both shipped & verified on real/live data).
        Real CC transcripts: ~/.claude/projects/-Users-aaronwinegrad/*.jsonl (+ <sid>/subagents/
        agent-*.jsonl + .meta.json). Confirmed schema: assistant msg.content[] tool_use{id,name,
        input}, msg.usage{input_tokens,output_tokens}, msg.id, msg.model; user tool_result
        {tool_use_id,is_error,content}; meta.json {agentType,description,toolUseId}.
  - [~] Phase E — observer→orchestrator infra. DONE: run_id stamped on every event
        (session.run_id → relay_client; sdk/tests/test_persistence.py). REMAINING (the
        ORCHESTRATOR FORK — needs owner decision + their workflow): append-only event log to
        disk keyed by run_id, re-run engine that re-executes the workflow with an agent
        ablated, dry-run/mock-side-effects mode. This crosses observer→orchestrator (re-runs
        real agents = cost/side-effects) — do NOT build silently; confirm with Aaron.
  - [~] Phase F [Rung 2] — counterfactual ESTIMATOR DONE (the grounded math, no re-execution):
        ui/src/counterfactual.ts counterfactualCredit(allIds, vFn, opts): paired leave-one-out
        v(N)-v(N\{i}), seeded bootstrap CI, estimated / tight_null / low_power_unknown,
        spawn-cascade via liveSetFor, min-K guard. ui/tests/counterfactual.test.ts (8) against
        injected deterministic+noisy v(·). REMAINING for LIVE Rung 2: wire vFn to a real re-run
        harness (= the Phase E orchestrator fork) + surface CIs in CreditView. BCa CI (currently
        percentile bootstrap) is a documented refinement.
  - [x] Phase G [Rung 3] Shapley MATH DONE — ui/src/shapley.ts: classic Shapley (Mode A),
        exact enumeration (n<=12) + unbiased MC permutation estimator (Fisher-Yates uniform,
        seeded). ui/tests/shapley.test.ts (6) prove the axioms on closed-form games (additive,
        unanimity 1/3 each, null-player=0, symmetry, efficiency; MC≈exact). NOT done: Mode B
        precedence-constrained (Faigle-Kern, different axiom set — documented as out of scope),
        nested-stochastic v composition with Rung 2, UI surfacing.
  - [x] Phase H [Rung 4] densification MATH DONE — ui/src/densify.ts: PBRS per-handoff
        F=γ·Φ(s')−Φ(s); Φ measured, Φ-choice assumed (basis=assumed); NO policy-invariance
        ranking claim. ui/tests/densify.test.ts (5).

  ## Credit ladder MATH complete (Rungs 1-4 all implemented + tested). LIVE status:
  ##  - Rung 1: live on real data (CreditView + ingestion).
  ##  - Rung 2: live on safe simulated re-runs (examples/rung2_demo.py).
  ##  - Rung 3/4: estimators done + tested; not yet wired to live v(·)/Φ or surfaced in UI.
  ## (a) SURFACING IN UI — DONE. credit_report event (events.py CreditReportEvent +
  ##     session.report_credit; types.ts + store.creditReports keyed by method, reset on
  ##     session_start) carries harness-computed causal credit; CreditView renders a
  ##     "◎ Causal credit — Rung 2/3/4" table (credit bar + 95% CI + state badge) above the
  ##     Rung-1 structural table. rung2_demo publishes its measured credit. VERIFIED in
  ##     browser: lens shows Rung-2 causal table + Rung-1 structural together. 95 ui / 33 sdk.
  ## (b) observer→orchestrator fork — SAFETY LAYER DONE (the spec gate is cleared):
  ##   Session(dry_run=True): single choke point in agent.py tool_call — fn executes in dry-run
  ##   ONLY if side_effect in {pure, live_required} (whitelist; default "external" fails safe;
  ##   typos/None/replayable mocked). replayable returns replay_value w/o calling fn; agent
  ##   reasoning runs live. dry_run propagates to nested agents + session_start; ToolResultEvent
  ##   .simulated; UI ◑ DRY RUN badge + simulated tool flag. sdk/tests/test_dry_run.py (10).
  ##   ADVERSARIALLY AUDITED (workflow wf_5bf5d4e7-23d, 10 agents): 6 candidate leaks, 0 confirmed
  ##   — guarantee holds. Threat-model/scope documented in agent.py near _DRY_RUN_EXECUTABLE.
  ##  REMAINING for live Rung 2/3 on REAL agents (still needs owner sign-off): the re-run ENGINE
  ##  (Phase E: append-only event log keyed by run_id; re-execute workflow with an agent ablated;
  ##  rerun_ablation command) + the user's re-runnable workflow. The math (counterfactual.py,
  ##  shapley.ts) + the safety gate are ready; only the engine that calls them on real agents is left.
- [ ] Ingestion adapters (= Phase D above).
- [ ] Rungs 2-4 (= Phases E-H; need orchestrator fork).

NEXT SESSION: read docs/credit-assignment.md (once written) + this section; continue from
first unchecked box. 502 real CC transcripts live at ~/.claude/projects/-Users-aaronwinegrad/*.jsonl.

## How to verify
- SDK:   cd sdk && python3 -m pytest tests/ -q
- UI:    cd ui && npx vitest run && npx tsc --noEmit
- Relay: cd relay && npm test && npm run build
- E2E:   kill any stale `node dist/index.js` on the relay port, then python3 examples/integration_test.py

## Gotchas discovered
- Relay uses jest (npm test), UI uses vitest. Don't mix.
- Stale relay on 3333 with dirty buffer replays ghost events — kill before E2E
  (session_start buffer reset fixes this once built).
- pytest-asyncio provides unused_tcp_port fixture.
- ramp of approval: tool_call denies on timeout by default now; demos must approve via
  browser or pass on_timeout="approve".
