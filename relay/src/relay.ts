import { WebSocketServer, WebSocket, ServerOptions } from "ws";
import { IncomingMessage, Server as HttpServer } from "http";
import { SessionRegistry } from "./sessions";
import { RunRecorder } from "./recorder";

const LEGACY_SESSION = "_legacy";

function sessionIdOf(event: unknown): string {
  const sid = event && typeof event === "object" ? (event as { session_id?: unknown }).session_id : undefined;
  return typeof sid === "string" && sid ? sid : LEGACY_SESSION;
}

export function createRelay(portOrServer: number | HttpServer, recorder?: RunRecorder) {
  // One buffer per session id — a new session no longer wipes the others.
  const registry = new SessionRegistry();
  const sdkClients = new Set<WebSocket>();
  const browserClients = new Set<WebSocket>();

  const opts: ServerOptions = typeof portOrServer === "number"
    ? { port: portOrServer }
    : { server: portOrServer };

  const wss = new WebSocketServer(opts);

  // When attached to an http.Server, ws re-emits server errors (e.g.
  // EADDRINUSE) on the wss; without a listener that crashes the process
  // before the http server's own error handler can fall back to another port.
  wss.on("error", () => { /* handled by the owning http server */ });

  function isSdkPath(req: IncomingMessage): boolean {
    return req.url === "/sdk";
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (isSdkPath(req)) {
      sdkClients.add(ws);

      ws.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString());
          const sid = sessionIdOf(event);
          const isStart = event && event.kind === "session_start";
          const { state } = registry.ensure(sid, isStart ? (event.name as string | undefined) : undefined);
          state.sdkSockets.add(ws);
          // session_start clears ONLY this session's buffer — never the others.
          if (isStart) state.buffer.clear();
          recorder?.record(event);   // durable per-run log (keyed run_id ?? session_id)
          state.buffer.push(event);
          for (const browser of browserClients) {
            if (browser.readyState === WebSocket.OPEN) {
              try { browser.send(JSON.stringify(event)); } catch { /* ignore closed socket */ }
            }
          }
        } catch { /* ignore malformed */ }
      });

      const dropSdk = () => { sdkClients.delete(ws); registry.detachSocket(ws); };
      ws.on("close", dropSdk);
      ws.on("error", dropSdk);
    } else {
      // Browser catch-up: the union of every live session's buffer (each event
      // carries its session_id, so the store fans them into the right tab).
      const catchUp = registry.all().flatMap((s) => s.buffer.all());
      if (catchUp.length > 0) {
        try { ws.send(JSON.stringify(catchUp)); } catch { /* ignore closed socket */ }
      }
      browserClients.add(ws);

      ws.on("message", (data) => {
        // Commands from browser → route to the SDK sockets OWNING the target
        // session_id; if none is given, broadcast to all (legacy single-session).
        try {
          const cmd = JSON.parse(data.toString());
          const targetSid = typeof cmd.session_id === "string" && cmd.session_id ? cmd.session_id : null;
          const targets = targetSid ? (registry.get(targetSid)?.sdkSockets ?? new Set<WebSocket>()) : sdkClients;
          for (const sdk of targets) {
            if (sdk.readyState === WebSocket.OPEN) {
              try { sdk.send(JSON.stringify(cmd)); } catch { /* ignore closed socket */ }
            }
          }
        } catch { /* ignore */ }
      });

      ws.on("close", () => browserClients.delete(ws));
      ws.on("error", () => browserClients.delete(ws));
    }
  });

  const ready = new Promise<void>((resolve) => {
    // When attaching to an existing http.Server, the wss is already "listening"
    // synchronously (no separate bind needed). When binding to a port, the
    // underlying net.Server fires "listening" once the port is acquired.
    if (typeof portOrServer !== "number") {
      resolve();
    } else {
      wss.once("listening", resolve);
    }
  });

  return {
    close: (cb?: () => void) => wss.close(cb),
    port: (): number => {
      const addr = wss.address();
      return addr && typeof addr === "object" ? addr.port : 0;
    },
    ready,
  };
}
