import { useEffect, useRef } from "react";
import ForceGraph3D, { ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { AgentNode, MessageEdge, OperationState } from "../types";
import type { Theme } from "../theme/theme";
import { operationBadge } from "../operations";

interface Props {
  agents: Record<string, AgentNode>;
  messageEdges: Record<string, MessageEdge>;
  operations: Map<string, OperationState>;
  selectedNodeId: string | null;
  funMode: boolean;
  theme: Theme;
  onSelectNode: (id: string | null) => void;
}

// The 3D field follows the theme: a clean paper canvas in light (no resting
// glow — Hyperdrive is the opt-in spectacle), the deep void in dark.
const FIELD_BG: Record<Theme, string> = { light: "#e9e5db", dark: "#04060d" };
const RESTING_BLOOM: Record<Theme, number> = { light: 0.05, dark: 0.3 };

const STATUS_COLOR: Record<string, string> = {
  running: "#3fe0ff",
  waiting: "#ff9e3d",
  complete: "#34d17e",
  error: "#ff5277",
  paused: "#8b9bb4",
};

// HYPERDRIVE palette — saturated neon for the fun-mode particle storm
const NEON = ["#ff2d95", "#3fe0ff", "#ffe14d", "#8a5cff", "#34ff9e", "#ff7a3d"];

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
  label: THREE.Sprite;
  labelText: string;          // kept so the label can be rebuilt on theme change
  badge: THREE.Sprite | null; // live-operation glyph; null = node owns no live op
  badgeType: string | null;   // op_type currently shown (so we know when to rebuild)
  status: string;
  hue: number; // stable per-node hue offset for fun mode
}

/* radial-gradient halo — inner stop pulled off pure-white so the status hue
   survives the bloom pass instead of washing toward white */
function makeHaloTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.72)");
  g.addColorStop(0.18, "rgba(255,255,255,0.30)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* per-theme plate/text colors so labels & badges read on the light paper field
   too (dark plates used to float on cream). */
const LABEL_PLATE: Record<Theme, { plate: string; border: string; text: string }> = {
  dark: { plate: "rgba(6,11,22,0.74)", border: "rgba(125,170,255,0.22)", text: "rgba(216,226,244,0.97)" },
  light: { plate: "rgba(255,255,255,0.88)", border: "rgba(20,18,12,0.14)", text: "#1b1916" },
};
const BADGE_PLATE: Record<Theme, { plate: string; border: string; text: string }> = {
  dark: { plate: "rgba(6,11,22,0.82)", border: "rgba(183,139,255,0.7)", text: "rgba(199,170,255,0.98)" },
  light: { plate: "rgba(255,255,255,0.92)", border: "rgba(123,80,200,0.6)", text: "#6b3fb0" },
};

/* label on a glass plate so a name is legible even over a bright glow */
function makeLabelSprite(text: string, theme: Theme): THREE.Sprite {
  const col = LABEL_PLATE[theme];
  const pad = 11;
  const fontPx = 26;
  const font = `600 ${fontPx}px "Spline Sans Mono", "IBM Plex Mono", monospace`;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const tw = Math.ceil(measure.measureText(text).width);
  const w = tw + pad * 2;
  const h = Math.round(fontPx + pad * 1.3);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = col.plate;
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, 7);
  ctx.fill();
  ctx.strokeStyle = col.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = font;
  ctx.fillStyle = col.text;
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  }));
  sprite.renderOrder = 999;
  const scale = 0.2;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.set(0, 9.5, 0);
  return sprite;
}

/* operation badge: a small glyph on a dark plate, mirroring the label sprite
   pattern. Placed to the upper-right of the node. Violet so it reads distinct
   from the cyan/gold status taxonomy. */
function makeBadgeSprite(glyph: string, theme: Theme): THREE.Sprite {
  const col = BADGE_PLATE[theme];
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = col.plate;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = col.border;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = `600 34px "Spline Sans Mono", "IBM Plex Mono", monospace`;
  ctx.fillStyle = col.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, size / 2, size / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  }));
  sprite.renderOrder = 1000;
  sprite.scale.set(4.4, 4.4, 1);
  sprite.position.set(5.5, 5.5, 0);
  return sprite;
}

function makeStarfield(): THREE.Points {
  const COUNT = 2200;
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
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

export function Scene3D({ agents, messageEdges, operations, selectedNodeId, funMode, theme, onSelectNode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance<VizNode, VizLink> | null>(null);
  const dataRef = useRef<{ nodes: VizNode[]; links: VizLink[] }>({ nodes: [], links: [] });
  const visualsRef = useRef<Map<string, NodeVisual>>(new Map());
  const msgCountsRef = useRef<Map<string, number>>(new Map());
  const haloTexRef = useRef<THREE.Texture | null>(null);
  const bloomRef = useRef<UnrealBloomPass | null>(null);
  const controlsRef = useRef<{ autoRotate?: boolean; autoRotateSpeed?: number } | null>(null);
  const starfieldRef = useRef<THREE.Points | null>(null);
  const rafRef = useRef<number>(0);
  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;
  const selectedRef = useRef<string | null>(selectedNodeId);
  selectedRef.current = selectedNodeId;
  const operationsRef = useRef(operations);
  operationsRef.current = operations;
  const funRef = useRef(funMode);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const hoverRef = useRef<string | null>(null);

  /* ---- one-time scene construction ---- */
  useEffect(() => {
    const el = containerRef.current!;
    haloTexRef.current = makeHaloTexture();
    const visuals = visualsRef.current;

    const TypedForceGraph3D = ForceGraph3D as unknown as {
      new (element: HTMLElement, config?: { controlType?: string }): ForceGraph3DInstance<VizNode, VizLink>;
    };
    const graph = new TypedForceGraph3D(el, { controlType: "orbit" })
      .backgroundColor(FIELD_BG[themeRef.current])
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
          map: haloTexRef.current!, color, transparent: true, opacity: 0.18, depthWrite: false,
        }));
        halo.scale.set(9, 9, 1);
        group.add(halo);

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(7.5, 0.42, 10, 48),
          new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95 })
        );
        ring.visible = n.pending > 0;
        group.add(ring);

        const labelText = n.name || n.id.slice(0, 6);
        const label = makeLabelSprite(labelText, themeRef.current);
        group.add(label);

        // operation badge: a live-op glyph (grounded — null when no live op)
        const b = operationBadge(n.id, operationsRef.current);
        let badge: THREE.Sprite | null = null;
        if (b) {
          badge = makeBadgeSprite(b.glyph, themeRef.current);
          group.add(badge);
        }

        visuals.set(n.id, {
          group, core, halo, ring, label, labelText, badge, badgeType: b?.op_type ?? null,
          status: n.status, hue: Math.random(),
        });
        return group;
      })
      .linkColor((l: VizLink) => (l.type === "msg" ? "#7df3ff" : "#8294b4"))
      .linkOpacity(0.35)
      .linkWidth((l: VizLink) => (l.type === "msg" ? 0.7 : 0.25))
      .linkDirectionalParticleWidth(2.4)
      .linkDirectionalParticleSpeed(0.012)
      .linkDirectionalParticleColor(() => "#7df3ff")
      .onNodeClick((n: VizNode) => {
        onSelectRef.current(n.id);
        const dist = 110;
        const len = Math.hypot(n.x ?? 1, n.y ?? 1, n.z ?? 1) || 1;
        const ratio = 1 + dist / len;
        graph.cameraPosition(
          { x: (n.x ?? 0) * ratio, y: (n.y ?? 0) * ratio, z: (n.z ?? 0) * ratio },
          { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 },
          900
        );
      })
      .onBackgroundClick(() => onSelectRef.current(null))
      .onNodeHover((n: VizNode | null) => { hoverRef.current = n?.id ?? null; });
      // NOTE: tried dagMode('radialout') for [22] but it CLUMPED the 72 same-depth
      // children tightly around the hub (worse than the force layout's spread), so
      // it's intentionally not enabled. The existing charge/link forces spread the
      // star better; revisit only with a real multi-level tree.

    graphRef.current = graph;
    graph.cameraPosition({ x: 0, y: 60, z: 340 });

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(el.clientWidth, el.clientHeight), RESTING_BLOOM[themeRef.current], 0.25, 0.35
    );
    bloomRef.current = bloom;
    graph.postProcessingComposer().addPass(bloom);

    const starfield = makeStarfield();
    starfield.visible = themeRef.current === "dark"; // starfield reads as noise on paper
    starfieldRef.current = starfield;
    graph.scene().add(starfield);

    const controls = graph.controls() as {
      autoRotate?: boolean; autoRotateSpeed?: number;
      enablePan?: boolean; panSpeed?: number; zoomSpeed?: number;
      minDistance?: number; maxDistance?: number;
      addEventListener?: (e: string, f: () => void) => void;
    };
    controlsRef.current = controls;
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.45;
      // Explicit, sane zoom/pan limits (were implicit defaults).
      controls.enablePan = true;
      controls.panSpeed = 0.8;
      controls.zoomSpeed = 0.9;
      controls.minDistance = 40;
      controls.maxDistance = 1200;
      controls.addEventListener?.("start", () => { if (!funRef.current) controls.autoRotate = false; });
    }
    // OrbitControls' "start" doesn't fire on wheel-zoom, so autoRotate keeps
    // spinning and fights the user as they scroll to zoom. Halt it on the first
    // wheel/pointer gesture (Hyperdrive owns rotation, so leave it alone there).
    const stopAutoRotate = () => { if (controls && !funRef.current) controls.autoRotate = false; };
    el.addEventListener("wheel", stopAutoRotate, { passive: true });
    el.addEventListener("pointerdown", stopAutoRotate);

    const proj = new THREE.Vector3();

    const animate = () => {
      const t = performance.now() / 1000;
      const cam = graph.camera();
      const fun = funRef.current;
      const W = el.clientWidth, H = el.clientHeight;

      // ---- HYPERDRIVE: rainbow throb, supernova bloom, spinning sky ----
      if (fun) {
        if (bloomRef.current) bloomRef.current.strength = 2.0 + 0.7 * Math.sin(t * 3);
        if (starfieldRef.current) {
          starfieldRef.current.rotation.y += 0.004;
          starfieldRef.current.rotation.x += 0.0015;
        }
      }

      // ---- label declutter: project to screen, greedily hide overlaps ----
      const items: { v: NodeVisual; id: string; sx: number; sy: number; dist: number; infront: boolean; pri: number }[] = [];
      for (const [id, v] of visuals) {
        // fun-mode node theatrics
        if (fun) {
          const hue = (t * 0.12 + v.hue) % 1;
          const col = new THREE.Color().setHSL(hue, 1, 0.6);
          v.core.material.color = col;
          v.halo.material.color = col;
          const hs = 16 + 5 * Math.sin(t * 4 + v.hue * 7);
          v.halo.scale.set(hs, hs, 1);
          v.core.scale.setScalar(1.2 + 0.35 * Math.sin(t * 6 + v.hue * 9));
        } else {
          if (v.ring.visible) {
            const s = 1 + 0.18 * Math.sin(t * 4.2);
            v.ring.scale.set(s, s, s);
            v.ring.material.opacity = 0.65 + 0.35 * Math.sin(t * 4.2);
            v.ring.lookAt(cam.position);
          }
          if (v.status === "running") {
            const hs = 9 + 1.1 * Math.sin(t * 2.1);
            v.halo.scale.set(hs, hs, 1);
          }
        }

        v.group.getWorldPosition(proj);
        const dist = cam.position.distanceTo(proj);
        proj.project(cam);
        const infront = proj.z < 1;
        const sx = (proj.x * 0.5 + 0.5) * W;
        const sy = (-proj.y * 0.5 + 0.5) * H;
        let pri = 1;
        if (id === hoverRef.current) pri = 5;
        else if (id === selectedRef.current) pri = 4;
        else if (v.ring.visible) pri = 3;
        else if (v.status === "running") pri = 2;
        items.push({ v, id, sx, sy, dist, infront, pri });
      }

      // highest priority + nearest first; everyone else yields the space
      items.sort((a, b) => b.pri - a.pri || a.dist - b.dist);
      const placed: { x: number; y: number }[] = [];
      const MINX = 96, MINY = 16;
      for (const it of items) {
        if (fun || !it.infront) { it.v.label.visible = false; continue; }
        let ok = it.id === selectedRef.current || it.id === hoverRef.current;
        if (!ok) {
          ok = true;
          for (const p of placed) {
            if (Math.abs(p.x - it.sx) < MINX && Math.abs(p.y - it.sy) < MINY) { ok = false; break; }
          }
        }
        it.v.label.visible = ok;
        if (ok) placed.push({ x: it.sx, y: it.sy });
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
      el.removeEventListener("wheel", stopAutoRotate);
      el.removeEventListener("pointerdown", stopAutoRotate);
      ro.disconnect();
      graph._destructor();
      graphRef.current = null;
      visuals.clear();
      msgCountsRef.current.clear();
      dataRef.current = { nodes: [], links: [] };
    };
  }, []);

  /* ---- HYPERDRIVE toggle: flip the scene-wide knobs, restore on exit ---- */
  useEffect(() => {
    funRef.current = funMode;
    const graph = graphRef.current;
    const bloom = bloomRef.current;
    const controls = controlsRef.current;
    if (!graph) return;

    if (funMode) {
      if (bloom) { bloom.radius = 0.9; bloom.strength = 2.0; }
      if (controls) { controls.autoRotate = true; controls.autoRotateSpeed = 6.5; }
      graph.linkOpacity(0.85)
        .linkDirectionalParticles(5)
        .linkDirectionalParticleSpeed(0.05)
        .linkDirectionalParticleWidth(3.4)
        .linkDirectionalParticleColor(() => NEON[Math.floor(Math.random() * NEON.length)]);
    } else {
      if (bloom) { bloom.radius = 0.25; bloom.strength = RESTING_BLOOM[themeRef.current]; }
      if (controls) { controls.autoRotateSpeed = 0.45; }
      graph.linkOpacity(0.35)
        .linkDirectionalParticles(0)
        .linkDirectionalParticleSpeed(0.012)
        .linkDirectionalParticleWidth(2.4)
        .linkDirectionalParticleColor(() => "#7df3ff");
      // restore status colors + resting scales the fun loop overrode
      for (const v of visualsRef.current.values()) {
        const color = new THREE.Color(STATUS_COLOR[v.status] ?? "#8b9bb4");
        v.core.material.color = color;
        v.halo.material.color = color;
        v.core.scale.setScalar(1);
        v.halo.scale.set(9, 9, 1);
      }
    }
  }, [funMode]);

  /* ---- theme: repaint the field, drop the resting glow + starfield in light ---- */
  useEffect(() => {
    themeRef.current = theme;
    const graph = graphRef.current;
    if (!graph) return;
    graph.backgroundColor(FIELD_BG[theme]);
    if (starfieldRef.current) starfieldRef.current.visible = theme === "dark";
    // Hyperdrive owns the bloom while it's on; otherwise track the theme's resting glow.
    if (bloomRef.current && !funRef.current) bloomRef.current.strength = RESTING_BLOOM[theme];
    // Repaint label + badge plates for the new theme (dark plates floated on the
    // light paper field).
    for (const [id, v] of visualsRef.current) {
      v.group.remove(v.label);
      v.label.material.map?.dispose();
      v.label.material.dispose();
      const nl = makeLabelSprite(v.labelText, theme);
      v.group.add(nl);
      v.label = nl;
      if (v.badge) {
        const b = operationBadge(id, operationsRef.current);
        v.group.remove(v.badge);
        v.badge.material.map?.dispose();
        v.badge.material.dispose();
        v.badge = b ? makeBadgeSprite(b.glyph, theme) : null;
        if (v.badge) v.group.add(v.badge);
      }
    }
  }, [theme]);

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

    for (const a of Object.values(agents)) {
      const v = visualsRef.current.get(a.id);
      if (!v) continue;
      const pending = a.tool_calls.some((tc) => tc.pending);
      v.ring.visible = pending;
      if (v.status !== a.status) {
        v.status = a.status;
        if (!funRef.current) {
          const color = new THREE.Color(STATUS_COLOR[a.status] ?? "#8b9bb4");
          v.core.material.color = color;
          v.halo.material.color = color;
          if (a.status !== "running") v.halo.scale.set(9, 9, 1);
        }
      }
    }

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

  /* ---- operation badges: add/swap/remove the live-op glyph per node ---- */
  useEffect(() => {
    for (const [id, v] of visualsRef.current) {
      const b = operationBadge(id, operations);
      const wantType = b?.op_type ?? null;
      if (wantType === v.badgeType) continue;  // unchanged — no churn
      if (v.badge) {
        v.group.remove(v.badge);
        v.badge.material.map?.dispose();
        v.badge.material.dispose();
        v.badge = null;
      }
      if (b) {
        v.badge = makeBadgeSprite(b.glyph, themeRef.current);
        v.group.add(v.badge);
      }
      v.badgeType = wantType;
    }
  }, [operations]);

  /* ---- selection highlight: brighten the chosen one ---- */
  useEffect(() => {
    for (const [id, v] of visualsRef.current) {
      const selected = id === selectedNodeId;
      if (!funRef.current) v.core.scale.setScalar(selected ? 1.45 : 1);
      v.halo.material.opacity = selected ? 1 : 0.85;
    }
  }, [selectedNodeId, agents]);

  return <div ref={containerRef} className="stage-3d" />;
}
