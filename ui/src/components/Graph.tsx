import { useEffect, useRef } from "react";
import * as d3 from "d3-force";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomTransform, type D3ZoomEvent } from "d3-zoom";
import { drag as d3drag, type D3DragEvent } from "d3-drag";
import type { AgentNode, MessageEdge, OperationState } from "../types";
import { operationBadge } from "../operations";

interface Props {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>;
  operations: Map<string, OperationState>;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (key: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "#3fe0ff",
  waiting: "#ff9e3d",
  complete: "#34d17e",
  error: "#ff5277",
  paused: "#8b9bb4",
};
const ROOT_COLOR = "#7daaff";
// How many labels to show by default before decluttering — the rest reveal on
// hover / selection (73 always-on labels = the unreadable smear we're killing).
const MAX_LABELS = 14;

interface SimNode extends d3.SimulationNodeDatum { id: string }
interface SimLink extends d3.SimulationLinkDatum<SimNode> { type: "spawn" | "message"; weight: number }

export function Graph({ agents, messageEdges, operations, selectedNodeId, onSelectNode, onSelectEdge }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  // Tracks current node positions so we can seed them on re-render
  const posMapRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Maps agent_id → circle/label element for fast selection + label updates
  const circleMapRef = useRef<Map<string, SVGCircleElement>>(new Map());
  const labelMapRef = useRef<Map<string, SVGTextElement>>(new Map());
  // Which labels are shown by default (selected/hover are layered on top of this).
  const defaultLabelsRef = useRef<Set<string>>(new Set());
  // Persisted zoom/pan transform — survives the SVG rebuild on data change.
  const zoomRef = useRef<ZoomTransform>(zoomIdentity);
  // The node whose label is force-shown via hover (in addition to the default set).
  const hoverRef = useRef<string | null>(null);
  // Current selection, read inside event closures so they never go stale.
  const selectedRef = useRef<string | null>(selectedNodeId);
  selectedRef.current = selectedNodeId;

  // Effect 1: rebuild simulation when graph structure changes (NOT when selectedNodeId changes)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const W = svg.clientWidth || 800;
    const H = svg.clientHeight || 600;

    // Seed positions from previous simulation run; new nodes start at center
    const nodes: SimNode[] = Object.values(agents).map((a) => {
      const prev = posMapRef.current.get(a.id);
      return { id: a.id, x: prev?.x ?? W / 2, y: prev?.y ?? H / 2 };
    });

    const spawnLinks: SimLink[] = Object.values(agents)
      .filter((a) => a.parent_id && agents[a.parent_id])
      .map((a) => ({ source: a.parent_id!, target: a.id, type: "spawn" as const, weight: 1 }));
    const msgLinks: SimLink[] = Object.entries(messageEdges)
      .filter(([key]) => {
        const [from, to] = key.split(":");
        return from !== to && agents[from] && agents[to];
      })
      .map(([key, edge]) => {
        const [from, to] = key.split(":");
        return { source: from, target: to, type: "message" as const, weight: edge.messages.length };
      });
    const links = [...spawnLinks, ...msgLinks];

    /* activity per agent — drives node radius (structure at a glance) */
    const activity = new Map<string, number>();
    for (const a of Object.values(agents)) activity.set(a.id, a.tool_calls.length);
    for (const e of Object.values(messageEdges)) {
      activity.set(e.from_agent_id, (activity.get(e.from_agent_id) ?? 0) + e.messages.length);
      activity.set(e.to_agent_id, (activity.get(e.to_agent_id) ?? 0) + e.messages.length);
    }
    const isRoot = (id: string) => !agents[id]?.parent_id;
    const radiusOf = (id: string) =>
      Math.min((isRoot(id) ? 14 : 10) + 2 * Math.sqrt(activity.get(id) ?? 0), 30);

    // Default-visible labels: the selected node, any node with a live op, and the
    // top-N by activity. Everything else is revealed on hover. This is what stops
    // a 73-node star from rendering 73 overlapping labels.
    const topByActivity = [...nodes]
      .sort((a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0))
      .slice(0, MAX_LABELS)
      .map((n) => n.id);
    const defaultLabels = new Set<string>(topByActivity);
    for (const n of nodes) {
      if (isRoot(n.id)) defaultLabels.add(n.id);
      if (operationBadge(n.id, operations)) defaultLabels.add(n.id);
    }
    defaultLabelsRef.current = defaultLabels;
    labelMapRef.current.clear();

    if (simRef.current) simRef.current.stop();

    // Layout: link + charge + center, PLUS a collision force (so circles and
    // their label band don't overlap) and a gentle radial ring for non-root
    // nodes (turns a 1→N star from a clumped hairball into a readable ring).
    const ring = Math.min(W, H) * 0.34;
    const sim = d3.forceSimulation<SimNode>(nodes)
      .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(110).strength(0.35))
      .force("charge", d3.forceManyBody().strength(-220))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide<SimNode>().radius((d) => radiusOf(d.id) + 22).iterations(2))
      .force("radial", d3.forceRadial<SimNode>((d) => (isRoot(d.id) ? 0 : ring), W / 2, H / 2).strength((d) => (isRoot(d.id) ? 0 : 0.22)));

    simRef.current = sim;

    // Clear and rebuild SVG
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path class="g2-arrow" d="M0,0 L0,6 L6,3 z"/>
      </marker>
      <marker id="arrow-msg" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path class="g2-arrow-msg" d="M0,0 L0,6 L6,3 z"/>
      </marker>
      <style>
        @keyframes dash { to { stroke-dashoffset: -16; } }
        .msg-edge { animation: dash 0.9s linear infinite; }
      </style>
    `;
    svg.appendChild(defs);

    // Everything pannable/zoomable lives in this group; the zoom transform is
    // applied to its `transform` attribute.
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", zoomRef.current.toString());
    svg.appendChild(g);

    const edgeEls: SVGLineElement[] = links.map((link) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      if (link.type === "spawn") {
        line.setAttribute("class", "g2-edge-spawn");
        line.setAttribute("stroke-width", "1.2");
        line.setAttribute("marker-end", "url(#arrow)");
      } else {
        line.setAttribute("stroke-opacity", "0.7");
        line.setAttribute("stroke-width", String(Math.min(1 + Math.sqrt(link.weight), 6)));
        line.setAttribute("stroke-dasharray", "5 4");
        line.setAttribute("marker-end", "url(#arrow-msg)");
        line.setAttribute("class", "msg-edge g2-edge-msg");
        line.style.cursor = "pointer";
        const src = typeof link.source === "string" ? link.source : (link.source as SimNode).id;
        const tgt = typeof link.target === "string" ? link.target : (link.target as SimNode).id;
        line.addEventListener("click", () => onSelectEdge(`${src}:${tgt}`));
      }
      g.appendChild(line);
      return line;
    });

    circleMapRef.current.clear();

    const nodeEls = nodes.map((node) => {
      const agent = agents[node.id];
      const root = isRoot(node.id);
      // A root shows its live status color when active (running/waiting/error) so
      // a lone shell/orchestrator node doesn't look idle; ROOT_COLOR is reserved
      // for structurally-idle roots (complete/paused). Matches the 3D field.
      const active = agent.status === "running" || agent.status === "waiting" || agent.status === "error";
      const color = (root && !active) ? ROOT_COLOR : (STATUS_COLORS[agent.status] ?? ROOT_COLOR);
      const r = radiusOf(node.id);

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", String(r));
      circle.setAttribute("class", "g2-node");
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", selectedNodeId === node.id ? "3" : "1.5");
      circle.style.cursor = "pointer";
      g.appendChild(circle);
      circleMapRef.current.set(node.id, circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dy", String(r + 14));
      label.setAttribute("class", "g2-label");
      label.setAttribute("font-size", "10");
      label.setAttribute("pointer-events", "none");
      label.textContent = agent.name;
      label.style.display = (defaultLabels.has(node.id) || node.id === selectedRef.current) ? "" : "none";
      g.appendChild(label);
      labelMapRef.current.set(node.id, label);

      // hover reveals this node's label even if it's not in the default set
      circle.addEventListener("mouseenter", () => { hoverRef.current = node.id; label.style.display = ""; });
      circle.addEventListener("mouseleave", () => {
        hoverRef.current = null;
        // read selection from the ref so this closure never goes stale
        if (!defaultLabels.has(node.id) && selectedRef.current !== node.id) label.style.display = "none";
      });

      // operation badge: a small glyph for a LIVE op this node owns (grounded —
      // null when the node owns no live operation, so nothing is drawn)
      const badge = operationBadge(node.id, operations);
      let badgeEl: SVGTextElement | null = null;
      if (badge) {
        badgeEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        badgeEl.setAttribute("text-anchor", "middle");
        badgeEl.setAttribute("fill", "#b78bff");
        badgeEl.setAttribute("font-size", "12");
        badgeEl.setAttribute("font-family", "var(--font-mono)");
        badgeEl.setAttribute("pointer-events", "none");
        badgeEl.textContent = badge.glyph;
        const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
        t.textContent = `${badge.op_type}: ${badge.label}`;
        badgeEl.appendChild(t);
        g.appendChild(badgeEl);
      }

      // drag to reposition (coords in the zoomed group's space via container).
      // A tiny drag (no real movement) is treated as a click → select.
      let downX = 0, downY = 0;
      const dragBehavior = d3drag<SVGCircleElement, unknown>()
        .container(() => g)
        .on("start", (ev: D3DragEvent<SVGCircleElement, unknown, unknown>) => {
          if (!ev.active) sim.alphaTarget(0.3).restart();
          downX = ev.x; downY = ev.y;
          node.fx = node.x; node.fy = node.y;
        })
        .on("drag", (ev: D3DragEvent<SVGCircleElement, unknown, unknown>) => {
          node.fx = ev.x; node.fy = ev.y;
        })
        .on("end", (ev: D3DragEvent<SVGCircleElement, unknown, unknown>) => {
          if (!ev.active) sim.alphaTarget(0);
          const moved = Math.hypot(ev.x - downX, ev.y - downY);
          node.fx = null; node.fy = null;   // release the pin so it rejoins the layout
          if (moved < 3) onSelectNode(node.id);
        });
      select(circle).call(dragBehavior);

      return { circle, label, node, badgeEl, badgeR: r };
    });

    // Zoom + pan on the whole SVG. Wheel zooms anywhere; background drag pans;
    // a mousedown ON a node is left to d3-drag (so node drag != canvas pan).
    const zb = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 6])
      .filter((ev: Event) => {
        if (ev.type === "wheel") return true;
        const target = ev.target as Element | null;
        return !(ev as MouseEvent).button && !(target && target instanceof SVGCircleElement);
      })
      .on("zoom", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        zoomRef.current = ev.transform;
        g.setAttribute("transform", ev.transform.toString());
      });
    const sel = select(svg);
    sel.call(zb);
    // re-sync the behavior's internal state to the persisted transform
    sel.call(zb.transform, zoomRef.current);

    sim.on("tick", () => {
      nodes.forEach((node, i) => {
        const { x = 0, y = 0 } = node;
        posMapRef.current.set(node.id, { x, y });
        nodeEls[i].circle.setAttribute("cx", String(x));
        nodeEls[i].circle.setAttribute("cy", String(y));
        nodeEls[i].label.setAttribute("x", String(x));
        nodeEls[i].label.setAttribute("y", String(y));
        const be = nodeEls[i].badgeEl;
        if (be) {
          be.setAttribute("x", String(x + nodeEls[i].badgeR + 4));
          be.setAttribute("y", String(y - nodeEls[i].badgeR));
        }
      });
      links.forEach((link, i) => {
        const s = link.source as SimNode;
        const t = link.target as SimNode;
        if (s.x != null && t.x != null) {
          edgeEls[i].setAttribute("x1", String(s.x));
          edgeEls[i].setAttribute("y1", String(s.y ?? 0));
          edgeEls[i].setAttribute("x2", String(t.x));
          edgeEls[i].setAttribute("y2", String(t.y ?? 0));
        }
      });
    });

    return () => { sim.stop(); };
  // selectedNodeId intentionally NOT in deps — handled by Effect 2
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, messageEdges, operations, onSelectNode, onSelectEdge]);

  // Effect 2: update stroke-width AND label visibility on selection change WITHOUT
  // restarting the simulation. The selected node's label always shows; on
  // deselect it reverts to whether it was a default/hovered label.
  useEffect(() => {
    for (const [id, circle] of circleMapRef.current) {
      circle.setAttribute("stroke-width", id === selectedNodeId ? "3" : "1.5");
    }
    for (const [id, label] of labelMapRef.current) {
      const show = id === selectedNodeId || id === hoverRef.current || defaultLabelsRef.current.has(id);
      label.style.display = show ? "" : "none";
    }
  }, [selectedNodeId]);

  return (
    <svg
      ref={svgRef}
      className="g2-svg"
      style={{ width: "100%", height: "100%", background: "transparent" }}
    />
  );
}
