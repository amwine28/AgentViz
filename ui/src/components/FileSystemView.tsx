import { useEffect, useRef, useState } from "react";
import { hierarchy, treemap, type HierarchyRectangularNode } from "d3-hierarchy";
import type { AgentNode } from "../types";
import { buildFileActivity, type FileNode } from "../fileActivity";

// Phase-1 "physical manifestation of folders": a directory treemap of the files
// Claude actually touched, derived 100% from existing Read/Write/Edit tool-call
// paths (see fileActivity.ts). Reads = cool, writes/edits = warm; tile size = how
// often the file was touched. Click a file → select the agent that touched it.
export function FileSystemView({
  agents,
  onSelectNode,
}: {
  agents: Record<string, AgentNode>;
  onSelectNode: (id: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fa = buildFileActivity(agents);
  const W = size.w || 800;
  const H = size.h || 600;

  let leaves: HierarchyRectangularNode<FileNode>[] = [];
  let dirs: HierarchyRectangularNode<FileNode>[] = [];
  if (fa.root) {
    const root = hierarchy<FileNode>(fa.root, (d) => d.children)
      .sum((d) => (d.children ? 0 : Math.max(1, d.touches)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    treemap<FileNode>().size([W, H]).paddingTop(16).paddingInner(2).round(true)(root);
    leaves = root.leaves() as HierarchyRectangularNode<FileNode>[];
    // dir rectangles one level under the root, for group framing/labels
    dirs = (root.descendants() as HierarchyRectangularNode<FileNode>[])
      .filter((d) => d.depth === 1 && d.children && d.children.length > 0);
  }

  return (
    <div className="stage-files" ref={ref}>
      {!fa.root ? (
        <div className="fs-empty">
          no file activity yet — the files Claude reads &amp; writes will map here
        </div>
      ) : (
        <>
          <div className="fs-head">
            <span className="fs-root">{fa.rootLabel}</span>
            <span className="fs-stat">{fa.fileCount} files · {fa.dirCount} dirs touched</span>
            <span className="fs-legend"><i className="fs-swatch read" /> read <i className="fs-swatch write" /> written</span>
          </div>
          <svg width={W} height={H} className="fs-svg">
            {dirs.map((d) => (
              <g key={`d-${d.data.path}`}>
                <rect className="fs-dir" x={d.x0} y={d.y0} width={Math.max(0, d.x1 - d.x0)} height={Math.max(0, d.y1 - d.y0)} rx={3} />
                <text className="fs-dir-label" x={d.x0 + 5} y={d.y0 + 11}>{d.data.name}</text>
              </g>
            ))}
            {leaves.map((l) => {
              const w = Math.max(0, l.x1 - l.x0);
              const h = Math.max(0, l.y1 - l.y0);
              const written = l.data.writes > 0;
              const intensity = Math.min(1, 0.35 + Math.log2(1 + l.data.touches) * 0.18);
              return (
                <g
                  key={l.data.path}
                  className="fs-tile"
                  onClick={() => onSelectNode(l.data.agentIds[0] ?? null)}
                >
                  <title>{`${l.data.path}\n${l.data.reads} reads · ${l.data.writes} writes`}</title>
                  <rect
                    className={written ? "fs-rect write" : "fs-rect read"}
                    x={l.x0} y={l.y0} width={w} height={h} rx={2}
                    style={{ opacity: intensity }}
                  />
                  {w > 46 && h > 14 && (
                    <text className="fs-file-label" x={l.x0 + 4} y={l.y0 + 12}>
                      {l.data.name.length * 6.5 < w - 8 ? l.data.name : l.data.name.slice(0, Math.max(1, Math.floor((w - 8) / 6.5))) + "…"}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}
