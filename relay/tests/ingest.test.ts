import WebSocket from "ws";
import { createRelay } from "../src/relay";

// POST /ingest (the shell hook) funnels through the same ingest() the WS /sdk
// path uses. index.ts is just HTTP glue around relay.ingest(); we test the
// shared method directly (importing index.ts would auto-start a listener).
describe("relay.ingest (HTTP /ingest path)", () => {
  let relay: ReturnType<typeof createRelay>;
  let port: number;

  beforeEach(async () => {
    relay = createRelay(0);
    await relay.ready;
    port = relay.port();
  });

  afterEach((done) => { relay.close(done); });

  test("an ingested event fans out to a live browser client", (done) => {
    const browserWs = new WebSocket(`ws://localhost:${port}/`);
    browserWs.on("open", () => {
      relay.ingest({ kind: "log", agent_id: "sh", content: "npm test", level: "info", session_id: "term-1", timestamp: 1 });
    });
    browserWs.on("message", (data) => {
      const events = JSON.parse(data.toString());
      const evt = Array.isArray(events) ? events[events.length - 1] : events;
      expect(evt.kind).toBe("log");
      expect(evt.content).toBe("npm test");
      expect(evt.session_id).toBe("term-1");
      browserWs.close();
      done();
    });
  });

  test("an ingested session_start registers the session (buffered for late browsers)", (done) => {
    relay.ingest({ kind: "session_start", name: "my-terminal", source: "shell", session_id: "term-9", timestamp: 2 });
    setTimeout(() => {
      const lateBrowser = new WebSocket(`ws://localhost:${port}/`);
      lateBrowser.on("message", (data) => {
        const events = JSON.parse(data.toString());
        expect(Array.isArray(events)).toBe(true);
        const start = events.find((e: { kind: string }) => e.kind === "session_start");
        expect(start).toBeTruthy();
        expect(start.session_id).toBe("term-9");
        expect(start.name).toBe("my-terminal");
        lateBrowser.close();
        done();
      });
    }, 50);
  });
});
