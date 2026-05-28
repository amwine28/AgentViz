import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { SessionBuffer } from "./buffer";

export function createRelay(port: number) {
  const buffer = new SessionBuffer();
  const sdkClients = new Set<WebSocket>();
  const browserClients = new Set<WebSocket>();

  const wss = new WebSocketServer({ port });

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
              browser.send(JSON.stringify(event));
            }
          }
        } catch { /* ignore malformed */ }
      });

      ws.on("close", () => sdkClients.delete(ws));
    } else {
      // Browser client — send buffer catch-up immediately
      const catchUp = buffer.all();
      if (catchUp.length > 0) {
        ws.send(JSON.stringify(catchUp));
      }
      browserClients.add(ws);

      ws.on("message", (data) => {
        // Commands from browser → route to all SDK clients
        // (SDK client filters by agent_id internally)
        try {
          const cmd = JSON.parse(data.toString());
          for (const sdk of sdkClients) {
            if (sdk.readyState === WebSocket.OPEN) {
              sdk.send(JSON.stringify(cmd));
            }
          }
        } catch { /* ignore */ }
      });

      ws.on("close", () => browserClients.delete(ws));
    }
  });

  return {
    close: (cb?: () => void) => wss.close(cb),
  };
}
