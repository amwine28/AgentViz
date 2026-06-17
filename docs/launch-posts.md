# Launch posts (drafts)

Repo: https://github.com/amwine28/AgentViz · assets: `docs/assets/agentviz-demo.gif` (3D world),
`docs/assets/agentviz-credit.png` (CREDIT lens). Tone: honest, no overclaiming; lead with the hook,
let the visuals carry it.

---

## X / Twitter (lead tweet + thread)

**Lead (attach the 3D GIF):**
> Your AI agents are invisible — a wall of interleaved logs. AgentViz turns that stream into a
> live 3D world you can fly around: agents glow, messages pulse, a tool call waiting on your
> approval is an unmissable ring. One keypress flips to a clean 2D graph to actually debug.
>
> Open source, `pip install` → live in 2 min. 🧵

**2 (attach the CREDIT image):**
> The part I'm proudest of: your swarm finishes with one verdict — *which agent earned it?*
> AgentViz measures each agent's causal credit by **re-running the workflow with it removed** and
> measuring the drop. Grounded — measured deltas + confidence intervals, never an LLM "rate this
> agent 0–100" opinion.

**3:**
> It even *measures redundancy*: if two agents cover each other, each shows small individual
> credit — discovered, not guessed. And every re-run is forced through a dry-run mode (adversarially
> audited) that mocks side effects, so measuring credit never sends a duplicate email.

**4:**
> Works on your real runs too: replay a past Claude Code session, or point any OpenTelemetry-emitting
> framework (LangGraph, CrewAI, AutoGen, OpenAI Agents SDK) at it. MIT. ⭐ if it's useful:
> https://github.com/amwine28/AgentViz

---

## r/ClaudeAI (and r/LocalLLaMA)

**Title:** I built a live 3D visualizer for multi-agent systems — and it measures which agent actually earned the result

**Body:**
> Multi-agent runs are invisible: an orchestrator spawns workers, they hand off and call tools, and
> all you get is interleaved logs. **AgentViz** (open source, MIT) renders that event stream as a live
> 3D world — agents are glowing nodes, messages pulse along edges, a tool call awaiting approval is a
> ring you click to approve/deny. Press `V` for a clean 2D graph, a FLOW swimlane transcript, or…
>
> the **CREDIT** lens, which is the bit I think is genuinely new. After a run you get one verdict
> (tests passed, eval 0.9). *Which agent earned it?* AgentViz answers it **grounded**: it re-runs the
> workflow with an agent removed and measures how much the outcome drops — that delta is its causal
> credit, with a confidence interval. No "ask an LLM to rate each agent," which is unfalsifiable and
> usually wrong. When the data can't tell, it says *unknown* instead of inventing a number.
>
> Claude Code specific: you can **replay a real Claude Code session** straight from its transcript —
> it reconstructs the subagent hierarchy and handoffs, with real token usage. (Also ingests
> OpenTelemetry, so LangGraph/CrewAI/AutoGen work too.)
>
> Every re-run is forced through a dry-run mode that mocks real side effects (I adversarially
> stress-tested it before letting it touch anything), so measuring credit never double-charges or
> re-sends. `pip install` → `/agentviz` → live in ~2 min.
>
> Repo + GIF: https://github.com/amwine28/AgentViz — feedback very welcome.

---

## Hacker News (Show HN)

**Title:** Show HN: AgentViz – a live 3D view of your agents that measures which one earned the result

**Body:**
> AgentViz renders a multi-agent run as a live 3D world (three.js), with a 2D graph and a swimlane
> transcript for debugging. It's MIT and runs locally — `pip install`, one command, no config.
>
> The non-obvious part is credit assignment. When a swarm finishes you get a single sparse reward;
> figuring out which agent caused it is the temporal-credit-assignment problem. AgentViz does it
> *grounded*, as a ladder:
>
> - Rung 1 (structural): reverse-reachability + dominators over the handoff graph — necessary, not causal.
> - Rung 2 (counterfactual replay): re-run the workflow with an agent removed, measure the reward
>   drop = its causal credit, with a bootstrap CI from repeated runs. It correctly surfaces redundancy
>   (two agents that cover each other each show small marginal credit).
> - Rung 3/4 (Shapley, potential-based densification): fair credit under redundancy, and per-step credit.
>
> The hard prerequisite was a dry-run/mock-side-effects mode (re-running real agents must not re-send
> emails or double-charge); I audited it adversarially with a panel of agents trying to find a leak.
>
> The design principle throughout: every credit number is a measured re-run delta or a fairness axiom,
> never an LLM opinion, and "unknown" when the data can't support a number.
>
> Repo: https://github.com/amwine28/AgentViz
> Design doc (the rigor, incl. the trap where ablation accidentally measures nothing):
> docs/credit-assignment.md

---

## Honesty checklist before posting
- [ ] The 3D GIF is rehearsed and doesn't stutter (Phase 1 reliability exists for this).
- [ ] Don't claim Rung 3/4 are "live on real agents" — they're built/surfaced; Rung 2 is the live one.
- [ ] Don't claim production durability / scale — explicit non-goals.
- [ ] Credit numbers shown are from the demo's simulated workflow; say so if asked.
