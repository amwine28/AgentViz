import { useEffect, useRef } from "react";
import ForceGraph3D, { ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { AgentNode, MessageEdge } from "../types";

interface Props {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}

const STATUS_COLOR: Record<string, string> = {
  running: "#3fe0ff",
  waiting: "#ffb454",
  complete: "#6ef7a0",
  error: "#ff5277",
  paused: "#8b9bb4",
};

interface VizNode {
  id: string;
  name: string;
  status: string;
  pending: number;
  x?: number; y?: number; z?: number;
}
interface VizLink {
  key: string;
  source: string | VizNode;
  target: string | VizNode;
  type: "spawn" | "msg";
}

interface NodeVisual {
  group: THREE.Group;
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Sprite;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  status: string;
}

/* radial-gradient halo texture, tinted per node via material color */
function makeHaloTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.25, "rgba(255,255,255,0.32)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeLabelSprite(text: string): THREE.Sprite {
  const pad = 8;
  const fontPx = 26;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `600 ${fontPx}px "IBM Plex Mono", monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  c.width = w; c.height = h;
  const ctx2 = c.getContext("2d")!;
  ctx2.font = `600 ${fontPx}px "IBM Plex Mono", monospace`;
  ctx2.fillStyle = "rgba(201,215,238,0.92)";
  ctx2.textBaseline = "middle";
  ctx2.fillText(text, pad, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  // depthTest off + high renderOrder: the name must never be swallowed by glow
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  }));
  sprite.renderOrder = 999;
  const scale = 0.22;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.set(0, 11.5, 0);
  return sprite;
}

function makeStarfield(): THREE.Points {
  const COUNT = 2200;
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    // shell distribution so stars stay behind the graph
    const r = 1400 + Math.random() * 2600;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9db8ff, size: 1.6, transparent: true, opacity: 0.55, sizeAttenuation: true,
  });
  return new THREE.Points(geo, mat);
}

export function Scene3D({ agents, messageEdges, selectedNodeId, onSelectNode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance<VizNode, VizLink> | null>(null);
  const dataRef = useRef<{ nodes: VizNode[]; links: VizLink[] }>({ nodes: [], links: [] });
  const visualsRef = useRef<Map<string, NodeVisual>>(new Map());
  const msgCountsRef = useRef<Map<string, number>>(new Map());
  const haloTexRef = useRef<THREE.Texture | null>(null);
  const rafRef = useRef<number>(0);
  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  /* ---- one-time scene construction ---- */
  useEffect(() => {
    const el = containerRef.current!;
    haloTexRef.current = makeHaloTexture();
    const visuals = visualsRef.current;

    const TypedForceGraph3D = ForceGraph3D as unknown as {
      new (element: HTMLElement, config?: { controlType?: string }): ForceGraph3DInstance<VizNode, VizLink>;
    };
    const graph = new TypedForceGraph3D(el, { controlType: "orbit" })
      .backgroundColor("#04060d")
      .showNavInfo(false)
      .nodeThreeObject((n: VizNode) => {
        const color = new THREE.Color(STATUS_COLOR[n.status] ?? "#8b9bb4");
        const group = new THREE.Group();

        const core = new THREE.Mesh(
          new THREE.SphereGeometry(3.4, 24, 24),
          new THREE.MeshBasicMaterial({ color })
        );
        group.add(core);

        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: haloTexRef.current!, color, transparent: true, opacity: 0.28, depthWrite: false,
        }));
        halo.scale.set(11, 11, 1);
        group.add(halo);

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(7.5, 0.42, 10, 48),
          new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95 })
        );
        ring.visible = n.pending > 0;
        group.add(ring);

        group.add(makeLabelSprite(n.name || n.id.slice(0, 6)));

        visuals.set(n.id, { group, core, halo, ring, status: n.status });
        return group;
      })
      .linkColor((l: VizLink) => (l.type === "msg" ? "#3fe0ff" : "#5d6f8d"))
      .linkOpacity(0.35)
      .linkWidth((l: VizLink) => (l.type === "msg" ? 0.7 : 0.25))
      .linkDirectionalParticleWidth(2.4)
      .linkDirectionalParticleSpeed(0.012)
      .linkDirectionalParticleColor(() => "#7df3ff")
      .onNodeClick((n: VizNode) => {
        onSelectRef.current(n.id);
        // cinematic fly-to: park the camera at a respectful distance
        const dist = 110;
        const len = Math.hypot(n.x ?? 1, n.y ?? 1, n.z ?? 1) || 1;
        const ratio = 1 + dist / len;
        graph.cameraPosition(
          { x: (n.x ?? 0) * ratio, y: (n.y ?? 0) * ratio, z: (n.z ?? 0) * ratio },
          { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 },
          900
        );
      })
      .onBackgroundClick(() => onSelectRef.current(null));

    graphRef.current = graph;
    graph.cameraPosition({ x: 0, y: 60, z: 340 });

    /* bloom — the glow that makes it cinematic */
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(el.clientWidth, el.clientHeight), 0.45, 0.3, 0.2
    );
    graph.postProcessingComposer().addPass(bloom);

    graph.scene().add(makeStarfield());

    /* slow auto-orbit until the pilot takes the stick */
    const controls = graph.controls() as { autoRotate?: boolean; autoRotateSpeed?: number; addEventListener?: (e: string, f: () => void) => void };
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.45;
      controls.addEventListener?.("start", () => { controls.autoRotate = false; });
    }

    /* pulse loop: approval rings breathe + billboard, running halos shimmer */
    const animate = () => {
      const t = performance.now() / 1000;
      const cam = graph.camera();
      for (const v of visuals.values()) {
        if (v.ring.visible) {
          const s = 1 + 0.18 * Math.sin(t * 4.2);
          v.ring.scale.set(s, s, s);
          v.ring.material.opacity = 0.65 + 0.35 * Math.sin(t * 4.2);
          v.ring.lookAt(cam.position);
        }
        if (v.status === "running") {
          const hs = 11 + 1.3 * Math.sin(t * 2.1);
          v.halo.scale.set(hs, hs, 1);
        }
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    const ro = new ResizeObserver(() => {
      graph.width(el.clientWidth).height(el.clientHeight);
      bloom.setSize(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      graph._destructor();
      graphRef.current = null;
      visuals.clear();
      msgCountsRef.current.clear();
      dataRef.current = { nodes: [], links: [] };
    };
  }, []);

  /* ---- data sync: preserve node identity so layout stays stable ---- */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const prevNodes = new Map(dataRef.current.nodes.map((n) => [n.id, n]));
    const prevLinks = new Map(dataRef.current.links.map((l) => [l.key, l]));

    const nodes: VizNode[] = Object.values(agents).map((a) => {
      const pending = a.tool_calls.filter((tc) => tc.pending).length;
      const existing = prevNodes.get(a.id);
      if (existing) {
        existing.name = a.name;
        existing.status = a.status;
        existing.pending = pending;
        return existing;
      }
      return { id: a.id, name: a.name, status: a.status, pending };
    });
    const ids = new Set(nodes.map((n) => n.id));

    const links: VizLink[] = [];
    for (const a of Object.values(agents)) {
      if (a.parent_id && ids.has(a.parent_id)) {
        const key = `spawn:${a.parent_id}:${a.id}`;
        links.push(prevLinks.get(key) ?? { key, source: a.parent_id, target: a.id, type: "spawn" });
      }
    }
    for (const e of Object.values(messageEdges)) {
      if (!ids.has(e.from_agent_id) || !ids.has(e.to_agent_id) || e.from_agent_id === e.to_agent_id) continue;
      const key = `msg:${e.from_agent_id}:${e.to_agent_id}`;
      links.push(prevLinks.get(key) ?? { key, source: e.from_agent_id, target: e.to_agent_id, type: "msg" });
    }

    const structureChanged =
      nodes.length !== dataRef.current.nodes.length ||
      links.length !== dataRef.current.links.length ||
      nodes.some((n) => !prevNodes.has(n.id));

    dataRef.current = { nodes, links };
    if (structureChanged) {
      graph.graphData(dataRef.current);
    }

    /* live visual updates without rebuilding objects */
    for (const a of Object.values(agents)) {
      const v = visualsRef.current.get(a.id);
      if (!v) continue;
      const pending = a.tool_calls.some((tc) => tc.pending);
      v.ring.visible = pending;
      if (v.status !== a.status) {
        v.status = a.status;
        const color = new THREE.Color(STATUS_COLOR[a.status] ?? "#8b9bb4");
        v.core.material.color = color;
        v.halo.material.color = color;
        if (a.status !== "running") v.halo.scale.set(11, 11, 1);
      }
    }

    /* pulse a particle down the edge for each new message */
    for (const [key, e] of Object.entries(messageEdges)) {
      const prev = msgCountsRef.current.get(key) ?? 0;
      if (e.messages.length > prev) {
        const link = dataRef.current.links.find((l) => l.key === `msg:${e.from_agent_id}:${e.to_agent_id}`);
        if (link) {
          for (let i = prev; i < e.messages.length; i++) {
            (graph as unknown as { emitParticle: (l: VizLink) => void }).emitParticle(link);
          }
        }
      }
      msgCountsRef.current.set(key, e.messages.length);
    }
  }, [agents, messageEdges]);

  /* ---- selection highlight: brighten the chosen one ---- */
  useEffect(() => {
    for (const [id, v] of visualsRef.current) {
      const selected = id === selectedNodeId;
      v.core.scale.setScalar(selected ? 1.45 : 1);
      v.halo.material.opacity = selected ? 1 : 0.85;
    }
  }, [selectedNodeId, agents]);

  return <div ref={containerRef} className="stage-3d" />;
}
