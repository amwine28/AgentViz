import { WebSocketServer, WebSocket, ServerOptions } from "ws";
import { IncomingMessage, Server as HttpServer } from "http";
import { SessionBuffer } from "./buffer";

export function createRelay(portOrServer: number | HttpServer) {
  const buffer = new SessionBuffer();
  const sdkClients = new Set<WebSocket>();
  const browserClients = new Set<WebSocket>();

  const opts: ServerOptions = typeof portOrServer === "number"
    ? { port: portOrServer }
    : { server: portOrServer };

  const wss = new WebSocketServer(opts);

  function isSdkPath(req: IncomingMessage): boolean {
    return req.url === "/sdk";
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (isSdkPath(req)) {
      sdkClients.add(ws);

      ws.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString());
          buffer.push(event);
          for (const browser of browserClients) {
            if (browser.readyState === WebSocket.OPEN) {
              try { browser.send(JSON.stringify(event)); } catch { /* ignore closed socket */ }
            }
          }
        } catch { /* ignore malformed */ }
      });

      ws.on("close", () => sdkClients.delete(ws));
      ws.on("error", () => sdkClients.delete(ws));
    } else {
      // Browser client — send buffer catch-up immediately
      const catchUp = buffer.all();
      if (catchUp.length > 0) {
        try { ws.send(JSON.stringify(catchUp)); } catch { /* ignore closed socket */ }
      }
      browserClients.add(ws);

      ws.on("message", (data) => {
        // Commands from browser → route to all SDK clients
        // (SDK client filters by agent_id internally)
        try {
          const cmd = JSON.parse(data.toString());
          for (const sdk of sdkClients) {
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
