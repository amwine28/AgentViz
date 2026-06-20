# AgentViz v2 "Shell" — Design Spec

**Date:** 2026-06-20
**Status:** Approved in brainstorming (2026-06-20). Implementation pending file-level build plan (ultracode architecture phase).

---

## Goal

Turn AgentViz from a single-session visualizer into a **one-window, multi-tab workspace** that shows every terminal the user opts in, with a professional **light-default** look (light/dark toggle), the live views as upper-right switches, and a consolidated per-tab analytics panel.

## Approved requirements

### 1. One window, the shell
- Chrome-style **tab strip** at the top — one tab per registered terminal session. Editable names (auto-filled from the session name), `+` / `×`, overflow handling.
- The active tab's world fills the canvas. No separate routes — everything in one window.
- **View switches in the upper-right corner.**
- A **dockable Analytics panel** (right edge) that expands / minimizes.

### 2. Tabs & multi-session (the architectural core)
- **Opt-in per terminal:** the user runs one command in a terminal → that session registers with the relay (and the command **bootstraps AgentViz** — relay + UI — if not already running) → a new tab appears.
- The **relay multiplexes many concurrent sessions**, tagging every event with a **session id**.
- The **store becomes multi-session**: a map of `sessionId → that session's world state` (agents, edges, operations, timeline, credit, etc.), replacing today's single top-level `sessionName`/state. Switching tabs switches the active session.
- **Tab names** auto-fill from the session name; user-editable; persisted client-side.
- **Grounded ingestion, two real sources:**
  - **Claude Code session** in the terminal → full agent activity streams (existing claudeCode transcript ingest, now live-tailed per session).
  - **Plain terminal** → the opt-in command arms a shell hook (`preexec`) for that shell; we animate the **real command stream** it reports. Nothing is shown for a terminal that never opted in. **No invented activity, ever.**

### 3. Views vs. Analytics split
- **Views = how you look at the live world:** **3D · 2D · FLOW**, rendered as the upper-right toggle switches.
- **Analytics = computed insight:** graph stats (NetworkX metrics), the efficiency **audit** (grade + findings), **credit assignment**, and the **ops** summary — consolidated into the one expandable Analytics panel, **per tab**. CREDIT and OPS move from top-level views into Analytics sections.
- Analytics panel docks on the **right edge** (pending final confirm vs. bottom), expand/minimize.

### 4. Theme system
- All color/type via CSS custom properties switched by a `data-theme` attribute; toggle in Settings.
- **Light (default) — "Warm Technical":** a blend of the Software Tracker's warm paper/drafting-blue refinement and a dense, instrument-like devtool layout. Cream/paper canvas, near-black ink, one drafting-blue accent, a refined display face + clean sans/mono, hairline-bordered dense panels, the graph on a light canvas (subtle shadows, no glow).
- **Dark (toggle):** the calmer graphite version of the surfaces already built — minus scanlines / neon.
- **Hyperdrive:** off by default; available as an optional fun toggle.

### 5. Grounded throughout
Analytics and animations only ever reflect real, reported events ([[feedback_grounded_over_llm_vibes]]). No faked terminal activity.

## Suggested build order
1. Multi-session: session-tagged event contract → relay multiplex → store map → tab strip.
2. One-window shell layout + upper-right view switches.
3. Analytics panel (consolidate stats/audit/credit/ops).
4. Light/dark theme system (token-driven).
5. Opt-in launcher command + shell hook + live Claude Code transcript tailer.

## Constraints / context
- Repo `~/dev/AgentViz`, public `amwine28/AgentViz` (MIT). Vite + React + TypeScript UI, Node relay, Python SDK.
- A concurrent terminal session also works in this repo — re-check git/working-tree cleanliness before any write phase.
- Keep existing tested-module discipline (`audit.ts`, `graph.ts` patterns); vitest (ui) / pytest (sdk) / jest (relay) must stay green.
