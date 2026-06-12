import { useEffect, useMemo, useRef } from "react";
import { buildFlowLayout } from "../flow";
import type { AgentVizEvent, AgentNode } from "../types";

interface Props {
  timeline: AgentVizEvent[];
  agents: Record<string, AgentNode>;
  onSelectNode: (id: string | null) => void;
}

const LANE_W = 170;
const ROW_H = 26;
const GUTTER = 86;
const TOP_PAD = 10;
const MAX_ROWS = 1500;

const STATUS_COLOR: Record<string, string> = {
  running: "#3fe0ff",
  waiting: "#ffb454",
  complete: "#6ef7a0",
  error: "#ff5277",
  paused: "#8b9bb4",
};

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function FlowView({ timeline, agents, onSelectNode }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const layout = useMemo(() => {
    const visible = timeline.length > MAX_ROWS ? timeline.slice(-MAX_ROWS) : timeline;
    return buildFlowLayout(visible);
  }, [timeline]);

  /* track whether the user is reading history or riding the live edge */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [layout.rows.length]);

  /* unresolved tool calls render as live (gold) marks */
  const resolved = useMemo(() => {
    const ids = new Set<string>();
    for (const r of layout.rows) {
      const e = r.event;
      if (e.kind === "tool_result" || e.kind === "tool_denied") ids.add(e.call_id);
    }
    return ids;
  }, [layout.rows]);

  const laneX = (i: number) => GUTTER + i * LANE_W + LANE_W / 2;
  const rowY = (i: number) => TOP_PAD + i * ROW_H + ROW_H / 2;

  const width = GUTTER + layout.lanes.length * LANE_W + 40;
  const height = TOP_PAD + Math.max(layout.rows.length, 1) * ROW_H + 30;

  /* lane life span: first and last row index that touches the lane */
  const span = useMemo(() => {
    const s = new Map<number, { from: number; to: number; ended: boolean }>();
    layout.rows.forEach((r, i) => {
      for (const lane of [r.lane, r.targetLane]) {
        if (lane === undefined) continue;
        const cur = s.get(lane);
        if (!cur) s.set(lane, { from: i, to: i, ended: false });
        else cur.to = i;
      }
      if (r.event.kind === "agent_complete") {
        const cur = s.get(r.lane);
        if (cur) cur.ended = true;
      }
    });
    return s;
  }, [layout.rows]);

  if (layout.lanes.length === 0) {
    return (
      <div className="flow-view">
        <div className="flow-empty">no transcript yet — events will trace here as agents act</div>
      </div>
    );
  }

  return (
    <div className="flow-view" ref={scrollRef} onScroll={onScroll}>
      <div className="flow-headers" style={{ width, paddingLeft: GUTTER }}>
        {layout.lanes.map((lane) => {
          const agent = agents[lane.id];
          const color = STATUS_COLOR[agent?.status ?? "paused"];
          return (
            <button
              key={lane.id}
              className="flow-lane-header"
              style={{ width: LANE_W }}
              onClick={() => onSelectNode(lane.id)}
              title={lane.id}
            >
              <span className="legend-dot" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
              {truncate(lane.name, 16)}
            </button>
          );
        })}
      </div>

      <svg width={width} height={height} className="flow-svg">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#3fe0ff" />
          </marker>
        </defs>

        {/* lane spines */}
        {layout.lanes.map((lane, i) => {
          const sp = span.get(i);
          if (!sp) return null;
          const agent = agents[lane.id];
          const ended = sp.ended || agent?.status === "complete" || agent?.status === "error";
          return (
            <line
              key={lane.id}
              x1={laneX(i)} y1={rowY(sp.from)}
              x2={laneX(i)} y2={ended ? rowY(sp.to) : height - 16}
              stroke="rgba(125,170,255,0.18)"
              strokeWidth={1}
            />
          );
        })}

        {layout.rows.map((row, i) => {
          const e = row.event;
          const y = rowY(i);
          const x = laneX(row.lane);
          const ts = "timestamp" in e ? (
            <text key="ts" x={8} y={y + 3} className="flow-ts">{fmtTime(e.timestamp)}</text>
          ) : null;

          switch (e.kind) {
            case "agent_spawn": {
              const parentLane = layout.lanes[row.lane].parentLane;
              return (
                <g key={i}>{ts}
                  {parentLane !== null && parentLane !== undefined && (
                    <line x1={laneX(parentLane)} y1={y} x2={x} y2={y}
                      stroke="rgba(125,170,255,0.4)" strokeWidth={1} strokeDasharray="3 3" />
                  )}
                  <circle cx={x} cy={y} r={4.5} fill="#0a1020" stroke="#7daaff" strokeWidth={1.4} />
                  <text x={x + 10} y={y + 3} className="flow-label flow-spawn">spawn ▸ {truncate(e.name, 18)}</text>
                </g>
              );
            }
            case "agent_message": {
              const tx = laneX(row.targetLane ?? row.lane);
              const self = tx === x;
              return (
                <g key={i}>{ts}
                  {!self && (
                    <line x1={x} y1={y} x2={tx + (tx > x ? -6 : 6)} y2={y}
                      stroke="#3fe0ff" strokeWidth={1.2} markerEnd="url(#arrow)" opacity={0.85} />
                  )}
                  <circle cx={x} cy={y} r={2.5} fill="#3fe0ff" />
                  <text
                    x={Math.min(x, tx) + Math.abs(tx - x) / 2} y={y - 5}
                    textAnchor="middle" className="flow-label flow-msg"
                  >
                    <title>{e.content}</title>
                    {truncate(e.content, Math.max(12, Math.floor(Math.abs(tx - x) / 6)))}
                  </text>
                </g>
              );
            }
            case "tool_call_pending": {
              const live = !resolved.has(e.call_id);
              const color = live ? "#ffd166" : "#5d6f8d";
              return (
                <g key={i}>{ts}
                  <rect x={x - 4} y={y - 4} width={8} height={8} transform={`rotate(45 ${x} ${y})`}
                    fill="none" stroke={color} strokeWidth={1.4} />
                  <text x={x + 12} y={y + 3} className="flow-label" fill={color}>
                    {truncate(e.name, 20)}() {live ? "⏳" : ""}
                  </text>
                </g>
              );
            }
            case "tool_result": {
              const resultText = typeof e.result === "object" && e.result !== null
                ? JSON.stringify(e.result)
                : String(e.result ?? "");
              return (
                <g key={i}>{ts}
                  <text x={x - 4} y={y + 4} fill="#6ef7a0" fontSize={11}>✓</text>
                  <text x={x + 12} y={y + 3} className="flow-label" fill="#6ef7a0">
                    <title>{resultText}</title>
                    {truncate(resultText, 24)} · {e.duration_ms}ms
                  </text>
                </g>
              );
            }
            case "tool_denied":
              return (
                <g key={i}>{ts}
                  <text x={x - 4} y={y + 4} fill="#ff5277" fontSize={11}>✗</text>
                  <text x={x + 12} y={y + 3} className="flow-label" fill="#ff5277">
                    denied ({e.reason})
                  </text>
                </g>
              );
            case "log":
              return (
                <g key={i}>{ts}
                  <circle cx={x} cy={y} r={1.6} fill="#5d6f8d" />
                  <text x={x + 10} y={y + 3} className={`flow-label flow-log-${e.level}`}>
                    <title>{e.content}</title>
                    {truncate(e.content, 30)}
                  </text>
                </g>
              );
            case "agent_complete": {
              const color = e.exit_status === "ok" ? "#6ef7a0" : e.exit_status === "error" ? "#ff5277" : "#8b9bb4";
              return (
                <g key={i}>{ts}
                  <rect x={x - 5} y={y - 5} width={10} height={10} fill="none" stroke={color} strokeWidth={1.4} />
                  <rect x={x - 2.5} y={y - 2.5} width={5} height={5} fill={color} />
                  <text x={x + 12} y={y + 3} className="flow-label" fill={color}>
                    {e.exit_status}{e.summary ? ` — ${truncate(e.summary, 20)}` : ""}
                  </text>
                </g>
              );
            }
            default:
              return null;
          }
        })}
      </svg>
    </div>
  );
}
