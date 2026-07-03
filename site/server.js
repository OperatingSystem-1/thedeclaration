#!/usr/bin/env node
// Server for thedeclaration.ai. Zero dependencies.
// - Serves the static site from site/public/
// - GET  /api/signatures.json: all signatures (repo-seeded + web-signed), live
// - POST /api/sign: validates with the same rules as CI, appends to the
//   ledger, and the signature is on the wall immediately.
//
// Storage: append-only JSONL at $DATA_DIR/signatures.jsonl (a Fly volume in
// prod). Signatures committed to the repo (the PR path) are baked into the
// image and merged in at boot, so both signing paths land on one wall.
//
// Env:
//   PORT       listen port (default 8080)
//   DATA_DIR   ledger directory (default /data)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateSignatureObject, SLUG_RE } = require("../scripts/validate-signatures");

const PUBLIC = path.join(__dirname, "public");
const REPO_SIGS = path.join(__dirname, "..", "signatures");
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const LEDGER = path.join(DATA_DIR, "signatures.jsonl");
const MAX_BODY = 16 * 1024;
const RATE_PER_IP_HOUR = 3;
const RATE_GLOBAL_HOUR = 600;

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

// ---------- signature store ----------
const store = new Map(); // slug -> signature (with slug field)

function loadStore() {
  // 1) signatures merged into the repo (PR path), baked into the image
  for (const f of fs.readdirSync(REPO_SIGS)) {
    if (!f.endsWith(".json") || f === "signature.schema.json") continue;
    try {
      const sig = JSON.parse(fs.readFileSync(path.join(REPO_SIGS, f), "utf8"));
      const slug = f.slice(0, -5);
      store.set(slug, { slug, ...sig });
    } catch (e) {
      console.error(`skipping ${f}: ${e.message}`);
    }
  }
  // 2) the web-signed ledger on the volume
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const sig = JSON.parse(line);
        if (sig && typeof sig.slug === "string") store.set(sig.slug, sig);
      } catch (e) {
        console.error(`skipping ledger line: ${e.message}`);
      }
    }
  }
  console.log(`loaded ${store.size} signature(s)`);
}

function slugify(name) {
  const s = String(name).toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return s || "signatory";
}

function addSignature(sig) {
  let slug = slugify(sig.name);
  if (store.has(slug)) slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
  if (store.has(slug) || !SLUG_RE.test(slug)) slug = `signatory-${crypto.randomBytes(4).toString("hex")}`;
  const entry = { slug, ...sig, signed_via: "web" };
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  store.set(slug, entry);
  return entry;
}

function allSignatures() {
  return [...store.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.slug).localeCompare(String(b.slug))
  );
}

// ---------- rate limiting (in-memory) ----------
const hits = new Map(); // ip -> [timestamps]
let globalHits = [];
function rateLimited(ip) {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  globalHits = globalHits.filter((t) => t > hourAgo);
  if (globalHits.length >= RATE_GLOBAL_HOUR) return true;
  const mine = (hits.get(ip) || []).filter((t) => t > hourAgo);
  if (mine.length >= RATE_PER_IP_HOUR) return true;
  mine.push(now);
  hits.set(ip, mine);
  globalHits.push(now);
  if (hits.size > 50_000) hits.clear(); // crude memory backstop
  return false;
}

// ---------- request handling ----------
function sendJSON(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function handleSign(req, res) {
  // Same-origin guard for browser submissions; server-to-server posts have no Origin.
  const origin = req.headers.origin;
  if (origin) {
    const host = String(req.headers.host || "").replace(/^www\./, "");
    let originHost = "";
    try { originHost = new URL(origin).host.replace(/^www\./, ""); } catch {}
    if (originHost !== host) return sendJSON(res, 403, { ok: false, errors: ["cross-origin submissions are not accepted"] });
  }

  let raw = "";
  let overflow = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > MAX_BODY) { overflow = true; req.destroy(); }
  });
  req.on("end", () => {
    if (overflow) return;
    let body;
    try { body = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { ok: false, errors: ["body must be valid JSON"] });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(res, 400, { ok: false, errors: ["body must be a JSON object"] });
    }
    if (body.website) return sendJSON(res, 400, { ok: false, errors: ["submission rejected"] }); // honeypot
    delete body.website;

    body.date = new Date().toISOString().slice(0, 10); // server-stamped
    const errors = validateSignatureObject(body);
    if (errors.length) return sendJSON(res, 400, { ok: false, errors });

    // Only valid submissions consume rate-limit quota, so a typo doesn't lock anyone out.
    const ip = String(req.headers["fly-client-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown");
    if (rateLimited(ip)) {
      return sendJSON(res, 429, { ok: false, errors: ["rate limit exceeded — try again in an hour"] });
    }

    try {
      const entry = addSignature(body);
      return sendJSON(res, 201, { ok: true, slug: entry.slug, count: store.size, url: `/signatures/#${entry.slug}` });
    } catch (e) {
      console.error("sign failed:", e.message);
      return sendJSON(res, 500, { ok: false, errors: ["could not record the signature right now — please try again"] });
    }
  });
}

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

  if (urlPath === "/api/sign") {
    if (req.method !== "POST") return sendJSON(res, 405, { ok: false, errors: ["use POST"] });
    return handleSign(req, res);
  }
  if (urlPath === "/api/signatures.json") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=10",
      "access-control-allow-origin": "*",
    });
    return res.end(JSON.stringify(allSignatures()));
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
  res.writeHead(200, {
    "content-type": TYPES[ext] || "application/octet-stream",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(res);
});

loadStore();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`thedeclaration.ai listening on http://localhost:${PORT} (ledger: ${LEDGER})`);
});
