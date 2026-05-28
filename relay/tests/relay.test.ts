import WebSocket from "ws";
import { createRelay } from "../src/relay";

describe("relay", () => {
  let relay: ReturnType<typeof createRelay>;
  const PORT = 13333;

  beforeEach(() => {
    relay = createRelay(PORT);
  });

  afterEach((done) => {
    relay.close(done);
  });

  test("fans SDK event out to browser client", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${PORT}/sdk`);
    const browserWs = new WebSocket(`ws://localhost:${PORT}/`);

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
    const sdkWs = new WebSocket(`ws://localhost:${PORT}/sdk`);
    const browserWs = new WebSocket(`ws://localhost:${PORT}/`);

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

  test("new browser client receives buffered events on connect", (done) => {
    const sdkWs = new WebSocket(`ws://localhost:${PORT}/sdk`);

    sdkWs.on("open", () => {
      sdkWs.send(JSON.stringify({ kind: "agent_spawn", agent_id: "a2", name: "buffered", parent_id: null, timestamp: Date.now() }));

      setTimeout(() => {
        const lateBrowser = new WebSocket(`ws://localhost:${PORT}/`);
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
