import type { AgentVizEvent } from "./types";

/** Swimlane layout for the FLOW view: one lane per agent (in order of first
 * appearance), one row per narrative event. Pure function so it's testable. */

export interface FlowLane {
  id: string;
  name: string;
  parentLane: number | null;
}

export interface FlowRow {
  event: AgentVizEvent;
  lane: number;
  targetLane?: number; // messages only
}

export interface FlowLayout {
  lanes: FlowLane[];
  rows: FlowRow[];
}

export function buildFlowLayout(timeline: AgentVizEvent[]): FlowLayout {
  const lanes: FlowLane[] = [];
  const laneIndex = new Map<string, number>();

  const laneFor = (agentId: string, name?: string, parentId?: string | null): number => {
    const existing = laneIndex.get(agentId);
    if (existing !== undefined) return existing;
    const parentLane = parentId != null ? laneIndex.get(parentId) ?? null : null;
    lanes.push({ id: agentId, name: name ?? agentId.slice(0, 8), parentLane });
    const idx = lanes.length - 1;
    laneIndex.set(agentId, idx);
    return idx;
  };

  const rows: FlowRow[] = [];
  for (const event of timeline) {
    switch (event.kind) {
      case "agent_spawn":
        rows.push({ event, lane: laneFor(event.agent_id, event.name, event.parent_id) });
        break;
      case "agent_message": {
        const lane = laneFor(event.from_agent_id);
        const targetLane = laneFor(event.to_agent_id);
        rows.push({ event, lane, targetLane });
        break;
      }
      case "tool_call_pending":
      case "tool_result":
      case "tool_denied":
      case "log":
      case "agent_complete":
        rows.push({ event, lane: laneFor(event.agent_id) });
        break;
      default:
        break; // non-narrative kinds never reach the timeline
    }
  }

  return { lanes, rows };
}
