import { useEffect, useRef } from "react";
import * as d3 from "d3-force";
import type { AgentNode, MessageEdge } from "../types";

interface Props {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (key: string) => void;
  onCommand: (cmd: object) => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "#60a5fa",
  waiting: "#f59e0b",
  complete: "#34d399",
  error: "#f87171",
  paused: "#f59e0b",
};
const ROOT_COLOR = "#a78bfa";

interface SimNode extends d3.SimulationNodeDatum { id: string }
interface SimLink extends d3.SimulationLinkDatum<SimNode> { type: "spawn" | "message" }

export function Graph({ agents, messageEdges, selectedNodeId, onSelectNode, onSelectEdge }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const W = svg.clientWidth || 800;
    const H = svg.clientHeight || 600;

    const nodes: SimNode[] = Object.values(agents).map((a) => ({ id: a.id, x: W / 2, y: H / 2 }));
    const spawnLinks: SimLink[] = Object.values(agents)
      .filter((a) => a.parent_id)
      .map((a) => ({ source: a.parent_id!, target: a.id, type: "spawn" as const }));
    const msgLinks: SimLink[] = Object.keys(messageEdges).map((key) => {
      const [from, to] = key.split(":");
      return { source: from, target: to, type: "message" as const };
    });
    const links = [...spawnLinks, ...msgLinks];

    if (simRef.current) simRef.current.stop();

    const sim = d3.forceSimulation<SimNode>(nodes)
      .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(120))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(W / 2, H / 2));

    simRef.current = sim;

    // Clear previous render
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Defs: arrow markers + animation
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#2d2d4e"/>
      </marker>
      <marker id="arrow-msg" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#a78bfa"/>
      </marker>
      <style>
        @keyframes dash { to { stroke-dashoffset: -16; } }
        .msg-edge { animation: dash 0.9s linear infinite; }
      </style>
    `;
    svg.appendChild(defs);

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);

    // Edges
    const edgeEls: SVGLineElement[] = links.map((link) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      if (link.type === "spawn") {
        line.setAttribute("stroke", "#2d2d4e");
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("marker-end", "url(#arrow)");
      } else {
        line.setAttribute("stroke", "#a78bfa");
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("stroke-dasharray", "5 4");
        line.setAttribute("marker-end", "url(#arrow-msg)");
        line.setAttribute("class", "msg-edge");
        line.style.cursor = "pointer";
        const src = typeof link.source === "string" ? link.source : (link.source as SimNode).id;
        const tgt = typeof link.target === "string" ? link.target : (link.target as SimNode).id;
        const key = `${src}:${tgt}`;
        line.addEventListener("click", () => onSelectEdge(key));
      }
      g.appendChild(line);
      return line;
    });

    // Nodes
    const nodeEls = nodes.map((node) => {
      const agent = agents[node.id];
      const isRoot = !agent.parent_id;
      const color = isRoot ? ROOT_COLOR : (STATUS_COLORS[agent.status] ?? "#888");
      const r = isRoot ? 20 : 14;

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", "#1a1a2e");
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", selectedNodeId === node.id ? "3" : "1.5");
      circle.style.cursor = "pointer";
      circle.addEventListener("click", () => onSelectNode(node.id));
      g.appendChild(circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dy", String(r + 14));
      label.setAttribute("fill", "#aaa");
      label.setAttribute("font-size", "10");
      label.setAttribute("pointer-events", "none");
      label.textContent = agent.name;
      g.appendChild(label);

      return { circle, label, node };
    });

    sim.on("tick", () => {
      nodes.forEach((node, i) => {
        const { x = 0, y = 0 } = node;
        nodeEls[i].circle.setAttribute("cx", String(x));
        nodeEls[i].circle.setAttribute("cy", String(y));
        nodeEls[i].label.setAttribute("x", String(x));
        nodeEls[i].label.setAttribute("y", String(y));
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
  }, [agents, messageEdges, selectedNodeId, onSelectNode, onSelectEdge]);

  return (
    <svg
      ref={svgRef}
      style={{ width: "100%", height: "100%", background: "#0d0d14" }}
    />
  );
}
