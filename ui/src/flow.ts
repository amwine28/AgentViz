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

/* ---- collapsible sections: long same-lane runs fold into one row ---- */

const GROUPABLE = new Set(["log", "tool_call_pending", "tool_result", "tool_denied"]);

export type FlowDisplayRow =
  | { type: "row"; row: FlowRow }
  | { type: "section"; key: string; lane: number; rows: FlowRow[] };

/** Collapse consecutive runs of ≥ minGroup groupable events on the same lane.
 * Spawns, completions, and messages always stay visible — they are the story;
 * the folded noise is reachable by expanding the section. */
export function groupFlowRows(
  rows: FlowRow[],
  expanded: Set<string>,
  minGroup = 4
): FlowDisplayRow[] {
  const out: FlowDisplayRow[] = [];
  let run: FlowRow[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= minGroup) {
      const first = run[0].event as { timestamp?: number };
      const key = `${run[0].lane}:${first.timestamp ?? 0}:${run.length >= 0 ? run[0].event.kind : ""}`;
      out.push({ type: "section", key, lane: run[0].lane, rows: run });
      if (expanded.has(key)) {
        for (const r of run) out.push({ type: "row", row: r });
      }
    } else {
      for (const r of run) out.push({ type: "row", row: r });
    }
    run = [];
  };

  for (const row of rows) {
    const groupable = GROUPABLE.has(row.event.kind) && row.targetLane === undefined;
    if (groupable && (run.length === 0 || run[0].lane === row.lane)) {
      run.push(row);
    } else {
      flush();
      if (groupable) {
        run.push(row);
      } else {
        out.push({ type: "row", row });
      }
    }
  }
  flush();
  return out;
}
