import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRelay } from "./relay";
import { RunRecorder } from "./recorder";

const PREFERRED_PORT = parseInt(process.env.AGENTVIZ_PORT ?? "3333", 10);
const UI_DIST = path.resolve(__dirname, "../../ui/dist");
const PORT_FILE_DIR = path.join(os.homedir(), ".agentviz");
const PORT_FILE = path.join(PORT_FILE_DIR, "relay.json");
const RUNS_DIR = path.join(PORT_FILE_DIR, "runs");   // durable per-run event logs

const MIME: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

const server = http.createServer((req, res) => {
  // Strip query string and decode
  const rawPath = (req.url ?? "/").split("?")[0];
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";
  const resolved = path.resolve(path.join(UI_DIST, urlPath));

  // Prevent path traversal
  if (!resolved.startsWith(UI_DIST + path.sep) && resolved !== UI_DIST) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(resolved);
  const contentType = MIME[ext] ?? "application/octet-stream";

  fs.readFile(resolved, (err, data) => {
    if (!err) {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
      return;
    }
    // Only fall back to SPA index.html for extensionless paths (not missing .js/.css assets)
    if (!ext || ext === ".html") {
      fs.readFile(path.join(UI_DIST, "index.html"), (e2, html) => {
        if (e2) {
          res.writeHead(503);
          res.end("UI not built — run: cd ui && npm run build");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
});

createRelay(server, new RunRecorder(RUNS_DIR));

function writePortFile(port: number): void {
  try {
    fs.mkdirSync(PORT_FILE_DIR, { recursive: true });
    fs.writeFileSync(PORT_FILE, JSON.stringify({ port, pid: process.pid, started_at: Date.now() }));
  } catch (e) {
    console.error("Could not write port file:", e);
  }
}

let announced = false;
function onListening(): void {
  if (announced) return;
  announced = true;
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : PREFERRED_PORT;
  writePortFile(port);
  console.log(`AgentViz relay running on http://localhost:${port}`);
  console.log(`Open http://localhost:${port} in your browser`);
}

// Preferred port taken? Fall back to an ephemeral one — hardcoding 3333 is a bug.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Port ${PREFERRED_PORT} in use, selecting a free port...`);
    server.listen(0, onListening);
  } else {
    throw err;
  }
});

function cleanup(): void {
  try {
    const info = JSON.parse(fs.readFileSync(PORT_FILE, "utf8"));
    if (info.pid === process.pid) fs.unlinkSync(PORT_FILE);
  } catch { /* nothing to clean */ }
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

server.listen(PREFERRED_PORT, onListening);
