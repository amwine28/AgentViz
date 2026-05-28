import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { createRelay } from "./relay";

const PORT = parseInt(process.env.AGENTVIZ_PORT ?? "3333", 10);
const UI_DIST = path.resolve(__dirname, "../../ui/dist");

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

createRelay(server);

server.listen(PORT, () => {
  console.log(`AgentViz relay running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
