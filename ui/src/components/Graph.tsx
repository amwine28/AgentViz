import { useEffect, useRef } from "react";
import * as d3 from "d3-force";
import type { AgentNode, MessageEdge, OperationState } from "../types";
import { operationBadge } from "../operations";

interface Props {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>;
  operations: Map<string, OperationState>;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (key: string) => void;
  onCommand: (cmd: object) => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "#3fe0ff",
  waiting: "#ff9e3d",
  complete: "#34d17e",
  error: "#ff5277",
  paused: "#8b9bb4",
};
const ROOT_COLOR = "#7daaff";

interface SimNode extends d3.SimulationNodeDatum { id: string }
interface SimLink extends d3.SimulationLinkDatum<SimNode> { type: "spawn" | "message"; weight: number }

export function Graph({ agents, messageEdges, operations, selectedNodeId, onSelectNode, onSelectEdge }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  // Tracks current node positions so we can seed them on re-render
  const posMapRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Maps agent_id → circle element for fast selection highlighting
  const circleMapRef = useRef<Map<string, SVGCircleElement>>(new Map());

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

    if (simRef.current) simRef.current.stop();

    const sim = d3.forceSimulation<SimNode>(nodes)
      .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(120))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(W / 2, H / 2));

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

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);

    const edgeEls: SVGLineElement[] = links.map((link) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      if (link.type === "spawn") {
        // stroke color comes from CSS (.g2-edge-spawn) so it follows the theme
        line.setAttribute("class", "g2-edge-spawn");
        line.setAttribute("stroke-width", "1.2");
        line.setAttribute("marker-end", "url(#arrow)");
      } else {
        // edge weight = message volume; thickness makes the busy paths obvious
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

    // Rebuild circleMap for selection highlighting
    circleMapRef.current.clear();

    const nodeEls = nodes.map((node) => {
      const agent = agents[node.id];
      const isRoot = !agent.parent_id;
      const color = isRoot ? ROOT_COLOR : (STATUS_COLORS[agent.status] ?? "#8b9bb4");
      // radius encodes activity (tool calls + messages), root gets a floor bump
      const r = Math.min((isRoot ? 14 : 10) + 2 * Math.sqrt(activity.get(node.id) ?? 0), 30);

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", String(r));
      // fill comes from CSS (.g2-node) so nodes are light cards on the light
      // theme, dark on dark; the status STROKE stays the shared phosphor hue.
      circle.setAttribute("class", "g2-node");
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", selectedNodeId === node.id ? "3" : "1.5");
      circle.style.cursor = "pointer";
      circle.addEventListener("click", () => onSelectNode(node.id));
      g.appendChild(circle);

      // Register for fast highlight updates
      circleMapRef.current.set(node.id, circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dy", String(r + 14));
      // fill + font from CSS (.g2-label) so labels stay readable on either theme
      label.setAttribute("class", "g2-label");
      label.setAttribute("font-size", "10");
      label.setAttribute("pointer-events", "none");
      label.textContent = agent.name;
      g.appendChild(label);

      // operation badge: a small glyph for a LIVE op this node owns (grounded —
      // null when the node owns no live operation, so nothing is drawn)
      const badge = operationBadge(node.id, operations);
      let badgeEl: SVGTextElement | null = null;
      if (badge) {
        badgeEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        badgeEl.setAttribute("text-anchor", "middle");
        badgeEl.setAttribute("fill", "#b78bff");
        badgeEl.setAttribute("font-size", "12");
        badgeEl.setAttribute("font-family", "IBM Plex Mono, monospace");
        badgeEl.setAttribute("pointer-events", "none");
        badgeEl.textContent = badge.glyph;
        const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
        t.textContent = `${badge.op_type}: ${badge.label}`;
        badgeEl.appendChild(t);
        g.appendChild(badgeEl);
      }

      return { circle, label, node, badgeEl, badgeR: r };
    });

    sim.on("tick", () => {
      nodes.forEach((node, i) => {
        const { x = 0, y = 0 } = node;
        // Save position for next render cycle
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

  // Effect 2: update stroke-width on selection change WITHOUT restarting simulation
  useEffect(() => {
    for (const [id, circle] of circleMapRef.current) {
      circle.setAttribute("stroke-width", id === selectedNodeId ? "3" : "1.5");
    }
  }, [selectedNodeId]);

  return (
    <svg
      ref={svgRef}
      style={{ width: "100%", height: "100%", background: "transparent" }}
    />
  );
}
