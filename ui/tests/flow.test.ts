import { describe, test, expect } from "vitest";
import { buildFlowLayout } from "../src/flow";
import type { AgentVizEvent } from "../src/types";

const t = (events: object[]) => events as AgentVizEvent[];

describe("buildFlowLayout", () => {
  test("lanes appear in spawn order with names", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "agent_spawn", agent_id: "a2", parent_id: "a1", name: "worker", timestamp: 2 },
    ]));
    expect(layout.lanes.map((l) => l.name)).toEqual(["orch", "worker"]);
    expect(layout.lanes[1].parentLane).toBe(0);
  });

  test("message rows carry from and to lane indices", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "agent_spawn", agent_id: "a2", parent_id: "a1", name: "worker", timestamp: 2 },
      { kind: "agent_message", from_agent_id: "a2", to_agent_id: "a1", content: "done", timestamp: 3 },
    ]));
    const msg = layout.rows.find((r) => r.event.kind === "agent_message")!;
    expect(msg.lane).toBe(1);
    expect(msg.targetLane).toBe(0);
  });

  test("tool events sit on their agent's lane and unknown agents get a lane", () => {
    const layout = buildFlowLayout(t([
      { kind: "agent_spawn", agent_id: "a1", parent_id: null, name: "orch", timestamp: 1 },
      { kind: "tool_call_pending", agent_id: "a1", call_id: "c1", name: "fetch", args: {}, timestamp: 2 },
      { kind: "tool_result", agent_id: "a1", call_id: "c1", result: "ok", duration_ms: 5, timestamp: 3 },
      { kind: "log", agent_id: "ghost", content: "??", level: "info", timestamp: 4 },
    ]));
    expect(layout.rows[1].lane).toBe(0);
    expect(layout.rows[2].lane).toBe(0);
    expect(layout.lanes).toHaveLength(2); // ghost got a lane
    expect(layout.rows[3].lane).toBe(1);
  });
});
