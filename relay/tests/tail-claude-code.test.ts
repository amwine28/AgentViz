import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  projectDirFor,
  discoverActiveTranscript,
  stampSession,
  nextBatch,
} from "../src/tail-claude-code";

describe("tail-claude-code pure helpers", () => {
  test("projectDirFor mangles every non-alphanumeric char to a dash", () => {
    const home = "/home/u";
    expect(projectDirFor("/Users/aaronwinegrad/dev/AgentViz", home))
      .toBe(path.join(home, ".claude/projects/-Users-aaronwinegrad-dev-AgentViz"));
    // dots, spaces, underscores → dashes too
    expect(projectDirFor("/a/b.c d_e", home))
      .toBe(path.join(home, ".claude/projects/-a-b-c-d-e"));
  });

  test("stampSession adds session_id without mutating other fields", () => {
    const events = [{ kind: "log", content: "x", seq: 0 }];
    const out = stampSession(events, "term-1");
    expect(out[0]).toEqual({ kind: "log", content: "x", seq: 0, session_id: "term-1" });
    expect(events[0]).not.toHaveProperty("session_id"); // original untouched
  });

  test("nextBatch emits only the new tail and advances the cursor", () => {
    const all = [{ kind: "a" }, { kind: "b" }, { kind: "c" }];
    const first = nextBatch(0, all, "s");
    expect(first.count).toBe(3);
    expect(first.events.map((e) => e.kind)).toEqual(["a", "b", "c"]);
    expect(first.events.every((e) => e.session_id === "s")).toBe(true);

    // nothing new yet
    expect(nextBatch(3, all, "s")).toEqual({ events: [], count: 3 });

    // one appended → only it is sent
    const grown = [...all, { kind: "d" }];
    const second = nextBatch(3, grown, "s");
    expect(second.count).toBe(4);
    expect(second.events.map((e) => e.kind)).toEqual(["d"]);
  });

  test("nextBatch is defensive if the list somehow shrank (never re-sends)", () => {
    expect(nextBatch(5, [{ kind: "a" }], "s")).toEqual({ events: [], count: 5 });
  });
});

describe("discoverActiveTranscript", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "av-tail-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("returns null when the project dir does not exist", () => {
    expect(discoverActiveTranscript("/Users/x/proj", home)).toBeNull();
  });

  test("returns null when the project dir has no .jsonl", () => {
    const dir = projectDirFor("/Users/x/proj", home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "hi");
    expect(discoverActiveTranscript("/Users/x/proj", home)).toBeNull();
  });

  test("returns the most recently modified transcript", () => {
    const cwd = "/Users/x/proj";
    const dir = projectDirFor(cwd, home);
    fs.mkdirSync(dir, { recursive: true });
    const older = path.join(dir, "older.jsonl");
    const newer = path.join(dir, "newer.jsonl");
    fs.writeFileSync(older, "{}");
    fs.writeFileSync(newer, "{}");
    // force a clear mtime ordering (older < newer)
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(2000), new Date(2000));
    expect(discoverActiveTranscript(cwd, home)).toBe(newer);
  });
});
