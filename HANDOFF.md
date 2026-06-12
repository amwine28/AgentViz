# AgentViz Overhaul — Live Handoff

> Resume protocol: if a session picks this up after a usage-limit cutoff, read this file
> top to bottom, run the verification commands in "How to verify", and continue from the
> first unchecked task. The repo is ~/Desktop/AgentViz. CLAUDE.md (AgentViz directive v2)
> governs; owner approved a full autonomous overhaul on 2026-06-11 ("agent viz to the
> maximum"): 3D world + slash command + reliability spine, no per-task approval needed.

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

## Status: OVERHAUL COMPLETE (2026-06-11). Nothing committed to git yet — Aaron decides.

## Post-overhaul additions (2026-06-12)
- Brightness fix: labels depthTest=false + renderOrder 999 + y=11.5; halo 11u @0.28;
  bloom 0.45/0.3/0.2 — labels now always readable over glow.
- FLOW view (3rd renderer): store.timeline (narrative events, cap 5000, reset on
  session_start) → flow.ts buildFlowLayout (pure, tested) → FlowView.tsx SVG swimlanes:
  lanes per agent w/ status dots, spawn branches, cyan message arrows w/ content,
  tool diamonds (gold=live), ✓/✗ results, completion marks, sticky headers,
  stick-to-bottom autoscroll. Toggle is now 3D/2D/FLOW, V cycles. 21 ui tests green.
- Pending idea from Aaron (NOT built): "Architect mode" — design hierarchy by placing
  spheres in the viz, then Claude Code spawns real agents matching it. Needs design pass.

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
