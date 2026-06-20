import WebSocket from "ws";
import { createRelay } from "../src/relay";

describe("relay multi-session", () => {
  let relay: ReturnType<typeof createRelay>;
  let port: number;

  beforeEach(async () => {
    relay = createRelay(0);
    await relay.ready;
    port = relay.port();
  });
  afterEach((done) => relay.close(done));

  test("two concurrent sessions do not clobber each other (B's session_start keeps A alive)", (done) => {
    const a = new WebSocket(`ws://localhost:${port}/sdk`);
    const b = new WebSocket(`ws://localhost:${port}/sdk`);

    a.on("open", () => {
      a.send(JSON.stringify({ kind: "session_start", name: "Run A", session_id: "A", timestamp: 1 }));
      a.send(JSON.stringify({ kind: "agent_spawn", agent_id: "a1", session_id: "A", timestamp: 2 }));
      b.on("open", () => {
        // B starting AFTER A previously wiped A via the global buffer — must not now
        b.send(JSON.stringify({ kind: "session_start", name: "Run B", session_id: "B", timestamp: 3 }));
        b.send(JSON.stringify({ kind: "agent_spawn", agent_id: "b1", session_id: "B", timestamp: 4 }));
        setTimeout(() => {
          const browser = new WebSocket(`ws://localhost:${port}/`);
          browser.on("message", (data) => {
            const events = JSON.parse(data.toString());
            const ids = events.map((e: { agent_id?: string }) => e.agent_id).filter(Boolean);
            expect(ids).toContain("a1"); // A survived B's session_start
            expect(ids).toContain("b1");
            browser.close(); a.close(); b.close();
            done();
          });
        }, 60);
      });
    });
  }, 15000);

  test("a command routes only to the SDK socket owning its session_id", (done) => {
    const a = new WebSocket(`ws://localhost:${port}/sdk`);
    const b = new WebSocket(`ws://localhost:${port}/sdk`);
    let bGotIt = false;
    b.on("message", () => { bGotIt = true; });

    a.on("open", () => {
      a.send(JSON.stringify({ kind: "session_start", name: "A", session_id: "A", timestamp: 1 }));
      b.on("open", () => {
        b.send(JSON.stringify({ kind: "session_start", name: "B", session_id: "B", timestamp: 1 }));
        setTimeout(() => {
          const browser = new WebSocket(`ws://localhost:${port}/`);
          browser.on("open", () => {
            browser.send(JSON.stringify({ kind: "tool_approve", agent_id: "x", call_id: "c1", session_id: "A" }));
          });
          a.on("message", (data) => {
            const cmd = JSON.parse(data.toString());
            if (cmd.kind !== "tool_approve") return;
            expect(cmd.session_id).toBe("A");
            setTimeout(() => {
              expect(bGotIt).toBe(false); // B never received A's command
              browser.close(); a.close(); b.close();
              done();
            }, 40);
          });
        }, 60);
      });
    });
  }, 15000);
});
