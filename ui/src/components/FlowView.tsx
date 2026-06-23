import { useEffect, useMemo, useRef, useState } from "react";
import { buildFlowLayout, groupFlowRows, FlowDisplayRow } from "../flow";
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
  waiting: "#ff9e3d",
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

// one glyph per operation kind (mirrors the OPS lens + node badges)
const OP_GLYPH: Record<string, string> = {
  loop: "◌", goal: "◎", schedule: "⏱", workflow: "▤", phase: "▸", spawn: "⎇",
  message: "✉", skill: "/", mcp: "⧉", plan_mode: "✎", worktree: "⌥", background: "▷",
  monitor: "👁", remote: "☁", todo: "☑", compact: "⊟", hook: "⚓",
};

// a short, grounded one-liner from a known detail key (honest-unknown: "" if absent)
function opDetail(e: { op_type?: string; detail?: Record<string, unknown> }): string {
  const d = e.detail ?? {};
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (e.op_type) {
    case "loop": return n("interval_s") != null ? `every ${n("interval_s")}s` : "";
    case "schedule": return s("cron") ?? s("next_fire") ?? "";
    case "skill": return s("skill") ?? "";
    case "spawn": return s("agent_type") ?? "";
    case "workflow": return s("name") ?? "";
    default: return "";
  }
}

export function FlowView({ timeline, agents, onSelectNode }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showLogs, setShowLogs] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const layout = useMemo(() => {
    const visible = timeline.length > MAX_ROWS ? timeline.slice(-MAX_ROWS) : timeline;
    return buildFlowLayout(visible);
  }, [timeline]);

  /* unresolved tool calls render as live (gold) marks — computed pre-filter */
  const resolved = useMemo(() => {
    const ids = new Set<string>();
    for (const r of layout.rows) {
      const e = r.event;
      if (e.kind === "tool_result" || e.kind === "tool_denied") ids.add(e.call_id);
    }
    return ids;
  }, [layout.rows]);

  const display: FlowDisplayRow[] = useMemo(() => {
    const filtered = layout.rows.filter((r) => {
      if (!showLogs && r.event.kind === "log") return false;
      if (!showTools && (r.event.kind === "tool_call_pending" || r.event.kind === "tool_result" || r.event.kind === "tool_denied")) return false;
      return true;
    });
    return groupFlowRows(filtered, expanded);
  }, [layout.rows, showLogs, showTools, expanded]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // Click-drag to pan the swimlane canvas (grab/grabbing). We only start a pan on
  // non-interactive background — clicks on lane-header buttons / section toggles
  // are left alone, so no threshold gymnastics needed.
  const pan = useRef({ x: 0, y: 0, left: 0, top: 0, active: false });
  const onPointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    const t = e.target as Element;
    if (t.closest("button") || t.closest(".flow-section")) return;
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, active: true };
    el.setPointerCapture?.(e.pointerId);
    el.classList.add("grabbing");
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pan.current.active) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = pan.current.left - (e.clientX - pan.current.x);
    el.scrollTop = pan.current.top - (e.clientY - pan.current.y);
  };
  const endPan = (e: React.PointerEvent) => {
    if (!pan.current.active) return;
    pan.current.active = false;
    const el = scrollRef.current;
    el?.releasePointerCapture?.(e.pointerId);
    el?.classList.remove("grabbing");
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [display.length]);

  const toggleSection = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const laneX = (i: number) => GUTTER + i * LANE_W + LANE_W / 2;
  const rowY = (i: number) => TOP_PAD + i * ROW_H + ROW_H / 2;

  const width = GUTTER + layout.lanes.length * LANE_W + 40;
  const height = TOP_PAD + Math.max(display.length, 1) * ROW_H + 30;

  /* lane life span over display rows */
  const span = useMemo(() => {
    const s = new Map<number, { from: number; to: number; ended: boolean }>();
    display.forEach((d, i) => {
      const lanes = d.type === "section" ? [d.lane] : [d.row.lane, d.row.targetLane];
      for (const lane of lanes) {
        if (lane === undefined) continue;
        const cur = s.get(lane);
        if (!cur) s.set(lane, { from: i, to: i, ended: false });
        else cur.to = i;
      }
      if (d.type === "row" && d.row.event.kind === "agent_complete") {
        const cur = s.get(d.row.lane);
        if (cur) cur.ended = true;
      }
    });
    return s;
  }, [display]);

  if (layout.lanes.length === 0) {
    return (
      <div className="flow-view">
        <div className="flow-empty">no transcript yet — events will trace here as agents act</div>
      </div>
    );
  }

  return (
    <div
      className="flow-view"
      ref={scrollRef}
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerLeave={endPan}
    >
      <div className="flow-headers" style={{ width }}>
        <div className="flow-filters" style={{ width: GUTTER }}>
          <button className={`flow-chip ${showTools ? "on" : ""}`} onClick={() => setShowTools((v) => !v)}>⚒</button>
          <button className={`flow-chip ${showLogs ? "on" : ""}`} onClick={() => setShowLogs((v) => !v)}>≡</button>
        </div>
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

        {display.map((d, i) => {
          const y = rowY(i);

          if (d.type === "section") {
            const x = laneX(d.lane);
            const isOpen = expanded.has(d.key);
            const tools = d.rows.filter((r) => r.event.kind !== "log").length;
            const logs = d.rows.length - tools;
            const livePending = d.rows.filter(
              (r) => r.event.kind === "tool_call_pending" && !resolved.has(r.event.call_id)
            ).length;
            const color = livePending > 0 ? "#ffd166" : "#5d6f8d";
            const parts = [
              `${d.rows.length} events`,
              tools > 0 ? `⚒${tools}` : "",
              logs > 0 ? `≡${logs}` : "",
              livePending > 0 ? `⏳${livePending}` : "",
            ].filter(Boolean).join(" · ");
            return (
              <g key={`s-${d.key}`} className="flow-section" onClick={() => toggleSection(d.key)}>
                <rect x={x - 56} y={y - 9} width={112 + parts.length * 3} height={18}
                  fill="rgba(125,170,255,0.05)" stroke="rgba(125,170,255,0.22)" strokeWidth={1} rx={2} />
                <text x={x - 48} y={y + 3} className="flow-label" fill={color}>
                  {isOpen ? "▾" : "▸"} {parts}
                </text>
              </g>
            );
          }

          const row = d.row;
          const e = row.event;

          // session-level operation (e.g. a /schedule cron): full-width band
          if ((e.kind === "operation_start" || e.kind === "operation_tick" || e.kind === "operation_end") && row.fullWidth) {
            const col = "#b78bff";
            const text = e.kind === "operation_start"
              ? `${OP_GLYPH[(e as { op_type?: string }).op_type ?? ""] ?? "◆"} ${e.label || (e as { op_type?: string }).op_type} · ${opDetail(e)}`
              : e.kind === "operation_tick"
                ? `↻ ${e.label || `beat #${e.n}`}`
                : `◆ end (${e.status})`;
            return (
              <g key={i}>
                <rect x={GUTTER} y={y - 9} width={Math.max(0, width - GUTTER - 8)} height={18}
                  fill="rgba(183,139,255,0.06)" stroke={col} strokeOpacity={0.4} strokeWidth={1} rx={2} />
                <text x={GUTTER + 10} y={y + 3} className="flow-label" fill={col}>
                  {truncate(text, Math.max(20, Math.floor((width - GUTTER) / 6)))}
                </text>
              </g>
            );
          }

          // run-level terminal outcome: full-width band spanning every lane (the story beat)
          if (e.kind === "outcome" && row.fullWidth) {
            const grounded = e.source !== "llm_judge";
            const col = e.value > 0 ? "#6ef7a0" : "#ff5277";
            return (
              <g key={i}>
                <rect x={GUTTER} y={y - 9} width={Math.max(0, width - GUTTER - 8)} height={18}
                  fill="rgba(110,247,160,0.05)" stroke={col} strokeOpacity={0.4} strokeWidth={1} rx={2} />
                <text x={GUTTER + 10} y={y + 3} className="flow-label" fill={col}>
                  ◆ outcome [{e.channel}] = {e.value} · {e.source}
                  {grounded ? "" : "  ⚠ non-grounded"}{e.measured ? "" : "  (assumed)"}
                </text>
              </g>
            );
          }

          const x = laneX(row.lane);
          const ts = "timestamp" in e ? (
            <text key="ts" x={8} y={y + 3} className="flow-ts">{fmtTime(e.timestamp)}</text>
          ) : null;

          switch (e.kind) {
            case "outcome": {
              // agent-scoped intermediate reward signal on its own lane
              const col = "#a0f0c0";
              return (
                <g key={i}>{ts}
                  <circle cx={x} cy={y} r={3} fill="none" stroke={col} strokeWidth={1.4} />
                  <text x={x + 10} y={y + 3} className="flow-label" fill={col}>
                    ◆ {e.channel}={e.value}{e.measured ? "" : " (assumed)"}
                  </text>
                </g>
              );
            }
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
              const sim = e.simulated;  // dry-run mock — not actually executed
              const col = sim ? "#b78bff" : "#6ef7a0";
              return (
                <g key={i}>{ts}
                  <text x={x - 4} y={y + 4} fill={col} fontSize={11}>{sim ? "◌" : "✓"}</text>
                  <text x={x + 12} y={y + 3} className="flow-label" fill={col}>
                    <title>{resultText}</title>
                    {sim ? "~mock " : ""}{truncate(resultText, 22)} · {e.duration_ms}ms
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
            case "operation_start": {
              const col = "#b78bff";
              const glyph = OP_GLYPH[e.op_type] ?? "◆";
              return (
                <g key={i}>{ts}
                  <circle cx={x} cy={y} r={3.5} fill="none" stroke={col} strokeWidth={1.4} />
                  <text x={x + 11} y={y + 3} className="flow-label flow-op" fill={col}>
                    <title>{e.family} · {e.op_type}</title>
                    {glyph} {truncate(e.label || e.op_type, 22)}{opDetail(e) ? ` · ${opDetail(e)}` : ""}
                  </text>
                </g>
              );
            }
            case "operation_tick": {
              const col = "#8b9bb4";
              return (
                <g key={i}>{ts}
                  <line x1={x - 3} y1={y} x2={x + 3} y2={y} stroke={col} strokeWidth={1.4} />
                  <text x={x + 11} y={y + 3} className="flow-label" fill={col}>
                    ↻ {truncate(e.label || `beat #${e.n}`, 22)}
                  </text>
                </g>
              );
            }
            case "operation_end": {
              const col = e.status === "complete" ? "#6ef7a0" : e.status === "error" ? "#ff5277" : "#8b9bb4";
              return (
                <g key={i}>{ts}
                  <circle cx={x} cy={y} r={3.5} fill={col} fillOpacity={0.25} stroke={col} strokeWidth={1.4} />
                  <text x={x + 11} y={y + 3} className="flow-label" fill={col}>
                    ◆ {e.status}{e.summary ? ` — ${truncate(e.summary, 18)}` : ""}
                  </text>
                </g>
              );
            }
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
