import { WebSocket } from "ws";
import { SessionRegistry } from "../src/sessions";

const fakeSocket = () => ({}) as unknown as WebSocket;

describe("SessionRegistry", () => {
  test("ensure creates once, reuses after, and updates the name", () => {
    const r = new SessionRegistry();
    const a = r.ensure("s1");
    expect(a.isNew).toBe(true);
    const b = r.ensure("s1", "My Run");
    expect(b.isNew).toBe(false);
    expect(b.state).toBe(a.state);
    expect(r.get("s1")!.name).toBe("My Run");
  });

  test("each session has an independent buffer", () => {
    const r = new SessionRegistry();
    r.ensure("A").state.buffer.push({ kind: "log", session_id: "A" });
    r.ensure("B").state.buffer.push({ kind: "log", session_id: "B" });
    expect(r.get("A")!.buffer.all()).toHaveLength(1);
    expect(r.get("B")!.buffer.all()).toHaveLength(1);
    expect(r.all()).toHaveLength(2);
  });

  test("detachSocket removes the socket and marks the session closed when its last socket goes", () => {
    const r = new SessionRegistry();
    const ws = fakeSocket();
    r.ensure("A").state.sdkSockets.add(ws);
    const affected = r.detachSocket(ws);
    expect(affected.map((s) => s.sessionId)).toEqual(["A"]);
    expect(r.get("A")!.closed).toBe(true);
    expect(r.get("A")!.sdkSockets.size).toBe(0);
  });
});
