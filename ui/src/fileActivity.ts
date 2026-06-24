import type { AgentNode } from "./types";

// Derive a filesystem-activity tree purely from events we ALREADY capture: the
// Read / Write / Edit tool calls carry an exact `file_path` in their args. No new
// instrumentation. Reads are passive (cool), Write/Edit are mutating (warm). This
// is the grounded Phase-1 source for the filesystem view; Bash-derived paths are a
// separate, lower-confidence tier we deliberately do NOT blend in here.

const READ_TOOLS = new Set(["Read"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

export interface FileNode {
  name: string;            // path segment (dir or file name)
  path: string;            // path relative to the common root
  reads: number;
  writes: number;
  touches: number;         // reads + writes (drives tile size)
  agentIds: string[];      // agents that touched this file (leaf only)
  children?: FileNode[];   // dirs have children; files are leaves
}

export interface FileActivity {
  root: FileNode | null;   // null when nothing was touched
  rootLabel: string;       // human label for the common root (repo-ish)
  fileCount: number;
  dirCount: number;
}

interface Touch { path: string; read: boolean; agentId: string }

function collectTouches(agents: Record<string, AgentNode>): Touch[] {
  const out: Touch[] = [];
  for (const a of Object.values(agents)) {
    for (const tc of a.tool_calls) {
      const fp = tc.args?.file_path;
      if (typeof fp !== "string" || !fp) continue;
      if (READ_TOOLS.has(tc.name)) out.push({ path: fp, read: true, agentId: a.id });
      else if (WRITE_TOOLS.has(tc.name)) out.push({ path: fp, read: false, agentId: a.id });
    }
  }
  return out;
}

// Longest common DIRECTORY prefix (never consumes a filename) so paths render
// repo-relative — both tidier and less of a privacy leak than absolute paths.
export function commonDirPrefix(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (!dirs.every((d) => d[i] === first[i])) break;
  }
  return first.slice(0, i);
}

export function buildFileActivity(agents: Record<string, AgentNode>): FileActivity {
  const touches = collectTouches(agents);
  if (touches.length === 0) return { root: null, rootLabel: "", fileCount: 0, dirCount: 0 };

  const prefix = commonDirPrefix(touches.map((t) => t.path));
  const rootLabel = prefix.length ? (prefix[prefix.length - 1] || "/") : "/";

  // aggregate per file (relative to the common prefix)
  const files = new Map<string, { reads: number; writes: number; agents: Set<string> }>();
  for (const t of touches) {
    const rel = t.path.split("/").slice(prefix.length).join("/") || t.path;
    let f = files.get(rel);
    if (!f) { f = { reads: 0, writes: 0, agents: new Set() }; files.set(rel, f); }
    if (t.read) f.reads++; else f.writes++;
    f.agents.add(t.agentId);
  }

  // build the directory tree
  const root: FileNode = { name: rootLabel, path: "", reads: 0, writes: 0, touches: 0, agentIds: [], children: [] };
  let dirCount = 0;
  for (const [rel, f] of files) {
    const segs = rel.split("/");
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const isLeaf = i === segs.length - 1;
      const seg = segs[i];
      const childPath = segs.slice(0, i + 1).join("/");
      let child = node.children!.find((c) => c.name === seg);
      if (!child) {
        child = { name: seg, path: childPath, reads: 0, writes: 0, touches: 0, agentIds: [], children: isLeaf ? undefined : [] };
        if (!isLeaf) dirCount++;
        node.children!.push(child);
      }
      if (isLeaf) {
        child.reads = f.reads; child.writes = f.writes; child.touches = f.reads + f.writes;
        child.agentIds = [...f.agents];
      }
      node = child;
    }
  }

  // roll dir totals up from leaves
  const roll = (n: FileNode): void => {
    if (!n.children) return;
    for (const c of n.children) roll(c);
    n.reads = n.children.reduce((s, c) => s + c.reads, 0);
    n.writes = n.children.reduce((s, c) => s + c.writes, 0);
    n.touches = n.reads + n.writes;
  };
  roll(root);

  return { root, rootLabel, fileCount: files.size, dirCount };
}
