import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { SessionBuffer } from "./buffer";

const PORT = parseInt(process.env.AGENTVIZ_PORT ?? "3333", 10);
const UI_DIST = path.resolve(__dirname, "../../ui/dist");

const buffer = new SessionBuffer();
const sdkClients = new Set<WebSocket>();
const browserClients = new Set<WebSocket>();

// HTTP server: serves built UI static files
const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const filePath = path.join(UI_DIST, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback to index.html for SPA routing
      fs.readFile(path.join(UI_DIST, "index.html"), (_e, html) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });
    } else {
      const ext = path.extname(filePath);
      const contentType = ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : "text/html";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    }
  });
});

// WebSocket server on same port
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  if (req.url === "/sdk") {
    sdkClients.add(ws);
    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        buffer.push(event);
        for (const browser of browserClients) {
          if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(event));
        }
      } catch { /* ignore */ }
    });
    ws.on("close", () => sdkClients.delete(ws));
  } else {
    const catchUp = buffer.all();
    if (catchUp.length > 0) ws.send(JSON.stringify(catchUp));
    browserClients.add(ws);
    ws.on("message", (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        for (const sdk of sdkClients) {
          if (sdk.readyState === WebSocket.OPEN) sdk.send(JSON.stringify(cmd));
        }
      } catch { /* ignore */ }
    });
    ws.on("close", () => browserClients.delete(ws));
  }
});

server.listen(PORT, () => {
  console.log(`AgentViz relay running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
