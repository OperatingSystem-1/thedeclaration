#!/usr/bin/env node
// Server for thedeclaration.ai. Zero dependencies.
// - Serves the static site from site/public/
// - POST /api/sign: accepts a signature, validates it with the same rules as
//   CI, and commits it to the GitHub repo (the repo stays the ledger; the
//   merge-to-main deploy hook puts it on the wall).
//
// Env:
//   PORT           listen port (default 8080)
//   GITHUB_TOKEN   token with contents write on the repo; endpoint is 503 without it
//   GITHUB_REPO    owner/name (default OperatingSystem-1/thedeclaration)
//   SIGN_MODE      "commit" (default: direct commit to main) or "pr" (bot opens a PR for review)
//   SIGN_DRY_RUN   "1" = validate and respond, but skip GitHub (local testing)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateSignatureObject } = require("../scripts/validate-signatures");

const PUBLIC = path.join(__dirname, "public");
const PORT = process.env.PORT || 8080;
const REPO = process.env.GITHUB_REPO || "OperatingSystem-1/thedeclaration";
const TOKEN = process.env.GITHUB_TOKEN || "";
const SIGN_MODE = process.env.SIGN_MODE === "pr" ? "pr" : "commit";
const DRY_RUN = process.env.SIGN_DRY_RUN === "1";
const API = "https://api.github.com";
const MAX_BODY = 16 * 1024;
const RATE_PER_IP_HOUR = 3;
const RATE_GLOBAL_HOUR = 120;

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

// ---------- rate limiting (in-memory, per machine — fine at launch scale) ----------
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
  if (hits.size > 10_000) hits.clear(); // crude memory backstop
  return false;
}

// ---------- GitHub ----------
async function gh(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "thedeclaration-ai-signer",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

function slugify(name) {
  const s = String(name).toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return s || "signatory";
}

async function publishSignature(sig) {
  let slug = slugify(sig.name);
  // If the slug is taken, salt it once with a short random suffix.
  const probe = await gh("GET", `/repos/${REPO}/contents/signatures/${slug}.json`);
  if (probe.status === 200) slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;

  const content = Buffer.from(JSON.stringify(sig, null, 2) + "\n").toString("base64");
  const filePath = `signatures/${slug}.json`;
  const message = `Sign: ${sig.name} (via thedeclaration.ai)`;

  if (SIGN_MODE === "commit") {
    const put = await gh("PUT", `/repos/${REPO}/contents/${filePath}`, {
      message, content, branch: "main",
    });
    if (put.status !== 201) {
      throw new Error(`github commit failed (${put.status}): ${put.json && put.json.message}`);
    }
    return { slug, mode: "commit", url: put.json.commit && put.json.commit.html_url };
  }

  // PR mode: branch off main, add the file there, open a PR.
  const ref = await gh("GET", `/repos/${REPO}/git/ref/heads/main`);
  if (ref.status !== 200) throw new Error(`github ref lookup failed (${ref.status})`);
  const branch = `sign/${slug}-${crypto.randomBytes(3).toString("hex")}`;
  const mkRef = await gh("POST", `/repos/${REPO}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: ref.json.object.sha,
  });
  if (mkRef.status !== 201) throw new Error(`github branch create failed (${mkRef.status})`);
  const put = await gh("PUT", `/repos/${REPO}/contents/${filePath}`, { message, content, branch });
  if (put.status !== 201) throw new Error(`github commit failed (${put.status})`);
  const pr = await gh("POST", `/repos/${REPO}/pulls`, {
    title: message, head: branch, base: "main",
    body: "Signature submitted through the website form. CI validates it; merge to inscribe it on the wall.",
  });
  if (pr.status !== 201) throw new Error(`github PR create failed (${pr.status})`);
  return { slug, mode: "pr", url: pr.json.html_url };
}

// ---------- request handling ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function handleSign(req, res) {
  if (!TOKEN && !DRY_RUN) {
    return sendJSON(res, 503, { ok: false, errors: ["signing via the website is temporarily unavailable — sign by pull request instead (see /sign/)"] });
  }

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
  req.on("end", async () => {
    if (overflow) return;
    let body;
    try { body = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { ok: false, errors: ["body must be valid JSON"] });
    }
    if (typeof body !== "object" || body === null) {
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
      return sendJSON(res, 429, { ok: false, errors: ["rate limit exceeded — try again in an hour, or sign by pull request"] });
    }

    if (DRY_RUN) return sendJSON(res, 201, { ok: true, slug: slugify(body.name), mode: "dry-run", url: null });

    try {
      const result = await publishSignature(body);
      return sendJSON(res, 201, { ok: true, ...result });
    } catch (e) {
      console.error("sign failed:", e.message);
      return sendJSON(res, 502, { ok: false, errors: ["could not record the signature right now — please try again, or sign by pull request"] });
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
    return void handleSign(req, res);
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
  console.log(`thedeclaration.ai listening on http://localhost:${PORT} (sign mode: ${DRY_RUN ? "dry-run" : SIGN_MODE}${TOKEN ? "" : ", no token"})`);
});
