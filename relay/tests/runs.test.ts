import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listRuns, readRun } from "../src/runs";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-runs-"));
}

describe("runs (browse/replay recorded runs)", () => {
  test("listRuns summarizes each run, names it from session_start, newest first", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "run-A.jsonl"),
      JSON.stringify({ kind: "session_start", name: "my run", run_id: "run-A" }) + "\n" +
      JSON.stringify({ kind: "agent_spawn", agent_id: "a1", run_id: "run-A" }) + "\n");
    // ensure run-B is newer
    const b = path.join(dir, "run-B.jsonl");
    fs.writeFileSync(b, JSON.stringify({ kind: "session_start", name: "later", run_id: "run-B" }) + "\n");
    fs.utimesSync(b, new Date(), new Date(Date.now() + 5000));

    const runs = listRuns(dir);
    expect(runs.map((r) => r.run_id)).toEqual(["run-B", "run-A"]);   // newest first
    const a = runs.find((r) => r.run_id === "run-A")!;
    expect(a.name).toBe("my run");
    expect(a.events).toBe(2);
  });

  test("readRun returns the run's events as parsed objects; missing -> null", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "run-X.jsonl"),
      JSON.stringify({ kind: "session_start", name: "x", run_id: "run-X" }) + "\n" +
      JSON.stringify({ kind: "agent_spawn", agent_id: "a1", run_id: "run-X" }) + "\n");
    const events = readRun(dir, "run-X")!;
    expect(events).toHaveLength(2);
    expect((events[0] as { kind: string }).kind).toBe("session_start");
    expect(readRun(dir, "nope")).toBeNull();
  });

  test("listRuns on a missing dir returns [] (no crash)", () => {
    expect(listRuns(path.join(os.tmpdir(), "agentviz-does-not-exist-zzz"))).toEqual([]);
  });
});
