import WebSocket from "ws";
import { createRelay } from "../src/relay";

describe("relay", () => {
  let relay: ReturnType<typeof createRelay>;
  let port: number;

  beforeEach(async () => {
    relay = createRelay(0);
    await relay.ready;
    port = relay.port();
  });

  afterEach((done) => {
    relay.close(done);
  });

  test("fans SDK event out to browser client", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${port}/sdk`);
    const browserWs = new WebSocket(`ws://localhost:${port}/`);

    browserWs.on("message", (data) => {
      const events = JSON.parse(data.toString());
      const evt = Array.isArray(events) ? events[events.length - 1] : events;
      expect(evt.kind).toBe("agent_spawn");
      expect(evt.agent_id).toBe("a1");
      sdkWs.close();
      browserWs.close();
      done();
    });

    sdkWs.on("open", () => {
      sdkWs.send(JSON.stringify({ kind: "agent_spawn", agent_id: "a1", name: "test", parent_id: null, timestamp: Date.now() }));
    });
  });

  test("routes command from browser to SDK client", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${port}/sdk`);
    const browserWs = new WebSocket(`ws://localhost:${port}/`);

    sdkWs.on("message", (data) => {
      const cmd = JSON.parse(data.toString());
      expect(cmd.kind).toBe("tool_approve");
      expect(cmd.call_id).toBe("c1");
      sdkWs.close();
      browserWs.close();
      done();
    });

    browserWs.on("open", () => {
      browserWs.send(JSON.stringify({ kind: "tool_approve", agent_id: "a1", call_id: "c1" }));
    });
  });

  test("session_start clears the buffer so new sessions have no ghost events", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${port}/sdk`);

    sdkWs.on("open", () => {
      sdkWs.send(JSON.stringify({ kind: "agent_spawn", agent_id: "old-ghost", name: "stale", parent_id: null, timestamp: 1 }));
      setTimeout(() => {
        sdkWs.send(JSON.stringify({ kind: "session_start", name: "fresh", timestamp: 2 }));
        setTimeout(() => {
          const lateBrowser = new WebSocket(`ws://localhost:${port}/`);
          lateBrowser.on("message", (data) => {
            const events = JSON.parse(data.toString());
            expect(Array.isArray(events)).toBe(true);
            expect(events.some((e: { agent_id?: string }) => e.agent_id === "old-ghost")).toBe(false);
            expect(events.some((e: { kind: string }) => e.kind === "session_start")).toBe(true);
            lateBrowser.close();
            sdkWs.close();
            done();
          });
        }, 50);
      }, 50);
    });
  });

  test("buffer holds a normal run without dropping (5000 events)", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${port}/sdk`);

    sdkWs.on("open", () => {
      for (let i = 0; i < 5000; i++) {
        sdkWs.send(JSON.stringify({ kind: "log", agent_id: "a1", content: `e${i}`, level: "info", timestamp: i, seq: i }));
      }
      setTimeout(() => {
        const lateBrowser = new WebSocket(`ws://localhost:${port}/`);
        lateBrowser.on("message", (data) => {
          const events = JSON.parse(data.toString());
          expect(events.length).toBe(5000);
          expect(events[0].content).toBe("e0");
          expect(events[4999].content).toBe("e4999");
          lateBrowser.close();
          sdkWs.close();
          done();
        });
      }, 300);
    });
  }, 15000);

  test("new browser client receives buffered events on connect", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${port}/sdk`);

    sdkWs.on("open", () => {
      sdkWs.send(JSON.stringify({ kind: "agent_spawn", agent_id: "a2", name: "buffered", parent_id: null, timestamp: Date.now() }));

      setTimeout(() => {
        const lateBrowser = new WebSocket(`ws://localhost:${port}/`);
        lateBrowser.on("message", (data) => {
          const events = JSON.parse(data.toString());
          expect(Array.isArray(events)).toBe(true);
          expect(events.some((e: { agent_id: string }) => e.agent_id === "a2")).toBe(true);
          lateBrowser.close();
          sdkWs.close();
          done();
        });
      }, 50);
    });
  });
});
