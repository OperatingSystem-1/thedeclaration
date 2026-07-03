#!/usr/bin/env node
// Tiny static server for site/public/. Zero dependencies.
// PORT env var or 8080.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "public");
const PORT = process.env.PORT || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const host = String(req.headers.host || "");
  if (host.toLowerCase().startsWith("www.")) {
    res.writeHead(301, { location: "https://" + host.slice(4) + req.url });
    res.end();
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }

  let filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end('<meta charset="utf-8"><body style="background:#0d0b10;color:#ece5d8;font-family:Georgia,serif;text-align:center;padding-top:15vh"><h1>404</h1><p>No such page. <a style="color:#e8c872" href="/">The Declaration</a> awaits.</p>');
    return;
  }

  const ext = path.extname(filePath);
  const cache = urlPath.startsWith("/api/") ? "public, max-age=60" : "public, max-age=300";
  res.writeHead(200, {
    "content-type": TYPES[ext] || "application/octet-stream",
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`thedeclaration.ai listening on http://localhost:${PORT}`);
});
