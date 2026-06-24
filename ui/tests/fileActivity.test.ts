import { describe, it, expect } from "vitest";
import { buildFileActivity, commonDirPrefix } from "../src/fileActivity";
import type { AgentNode } from "../src/types";

function agent(id: string, calls: Array<{ name: string; file_path?: string }>): AgentNode {
  return {
    id, name: id, parent_id: null, status: "complete", completed_at: null, exit_status: null,
    tool_calls: calls.map((c, i) => ({ call_id: `${id}-${i}`, name: c.name, args: c.file_path ? { file_path: c.file_path } : {}, pending: false })),
    logs: [],
  };
}

describe("commonDirPrefix", () => {
  it("returns the longest common directory prefix (never the filename)", () => {
    expect(commonDirPrefix(["/a/b/c.ts", "/a/b/d.ts"])).toEqual(["", "a", "b"]);
    expect(commonDirPrefix(["/a/b/c.ts", "/a/x/d.ts"])).toEqual(["", "a"]);
    expect(commonDirPrefix(["/only/one.ts"])).toEqual(["", "only"]);
    expect(commonDirPrefix([])).toEqual([]);
  });
});

describe("buildFileActivity", () => {
  it("returns an empty result when nothing was touched", () => {
    const fa = buildFileActivity({ a: agent("a", [{ name: "Bash" }, { name: "Read" }]) });
    expect(fa.root).toBeNull();
    expect(fa.fileCount).toBe(0);
  });

  it("counts reads vs writes per file and rolls dir totals up", () => {
    const agents = {
      a: agent("a", [
        { name: "Read", file_path: "/repo/src/store.ts" },
        { name: "Edit", file_path: "/repo/src/store.ts" },
        { name: "Write", file_path: "/repo/src/ui/App.tsx" },
      ]),
      b: agent("b", [{ name: "Read", file_path: "/repo/src/store.ts" }]),
    };
    const fa = buildFileActivity(agents);
    expect(fa.rootLabel).toBe("src"); // common dir prefix is /repo/src
    expect(fa.fileCount).toBe(2);
    expect(fa.root).not.toBeNull();
    const root = fa.root!;
    // root totals = all touches: store.ts (2 reads + 1 write) + App.tsx (1 write)
    expect(root.reads).toBe(2);
    expect(root.writes).toBe(2);
    expect(root.touches).toBe(4);
    // store.ts leaf carries both agents that touched it
    const findLeaf = (n: typeof root, name: string): typeof root | undefined =>
      n.name === name && !n.children ? n : n.children?.map((c) => findLeaf(c, name)).find(Boolean);
    const store = findLeaf(root, "store.ts");
    expect(store?.reads).toBe(2);
    expect(store?.writes).toBe(1);
    expect(store?.agentIds.sort()).toEqual(["a", "b"]);
  });

  it("ignores tool calls without a file_path (Bash etc.)", () => {
    const fa = buildFileActivity({
      a: agent("a", [{ name: "Bash" }, { name: "Read", file_path: "/x/y.ts" }, { name: "Read" }]),
    });
    expect(fa.fileCount).toBe(1);
  });
});
