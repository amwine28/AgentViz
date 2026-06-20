import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import WebSocket from "ws";
import { RunRecorder } from "../src/recorder";
import { createRelay } from "../src/relay";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-rec-"));
}

describe("RunRecorder", () => {
  test("appends events to a per-run JSONL keyed by run_id", () => {
    const dir = tmpDir();
    const rec = new RunRecorder(dir);
    rec.record({ kind: "session_start", name: "x", run_id: "run-A", seq: 0 });
    rec.record({ kind: "agent_spawn", agent_id: "a1", run_id: "run-A", seq: 0 });
    rec.record({ kind: "agent_spawn", agent_id: "b1", run_id: "run-B", seq: 0 });

    const a = fs.readFileSync(path.join(dir, "run-A.jsonl"), "utf8").trim().split("\n");
    expect(a).toHaveLength(2);
    expect(JSON.parse(a[0]).kind).toBe("session_start");
    expect(JSON.parse(a[1]).agent_id).toBe("a1");
    const b = fs.readFileSync(path.join(dir, "run-B.jsonl"), "utf8").trim().split("\n");
    expect(b).toHaveLength(1);
  });

  test("events without run_id go to _norun.jsonl; no crash", () => {
    const dir = tmpDir();
    const rec = new RunRecorder(dir);
    rec.record({ kind: "log", content: "no run id here" });
    expect(fs.existsSync(path.join(dir, "_norun.jsonl"))).toBe(true);
  });

  test("v2: keys on session_id when run_id absent; run_id still wins when both present", () => {
    const dir = tmpDir();
    const rec = new RunRecorder(dir);
    rec.record({ kind: "log", content: "shell tab", session_id: "tab-7" });
    rec.record({ kind: "agent_spawn", agent_id: "a1", run_id: "run-A", session_id: "tab-7" });
    expect(fs.existsSync(path.join(dir, "tab-7.jsonl"))).toBe(true);
    // run_id takes precedence so SDK replay keys stay stable
    expect(fs.existsSync(path.join(dir, "run-A.jsonl"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "tab-7.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("createRelay tees SDK events to the recorder", (done) => {
    const dir = tmpDir();
    const relay = createRelay(0, new RunRecorder(dir));
    relay.ready.then(() => {
      const port = relay.port();
      const sdk = new WebSocket(`ws://localhost:${port}/sdk`);
      sdk.on("open", () => {
        sdk.send(JSON.stringify({ kind: "agent_spawn", agent_id: "a1", run_id: "run-Z", seq: 0 }));
        setTimeout(() => {
          const f = path.join(dir, "run-Z.jsonl");
          expect(fs.existsSync(f)).toBe(true);
          expect(JSON.parse(fs.readFileSync(f, "utf8").trim()).agent_id).toBe("a1");
          sdk.close();
          relay.close(done);
        }, 80);
      });
    });
  });
});
