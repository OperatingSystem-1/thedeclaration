#!/usr/bin/env node
// Server for thedeclaration.ai. Zero dependencies.
// - Serves the static site from site/public/
// - GET  /api/signatures.json: all signatures (repo-seeded + web-signed), live
// - POST /api/sign: validates with the same rules as CI, appends to the
//   ledger, and the signature is on the wall immediately.
//
// Storage: an append-only ledger. With DATABASE_URL set (Neon Postgres), the
// ledger is the `ledger` table — the durable source of truth — and rate-limit
// state lives in the `state` table, so NO persistent disk is required: the
// JSONL at $DATA_DIR/signatures.jsonl is only an ephemeral local mirror,
// rebuilt from the database at boot. Without DATABASE_URL, the JSONL file IS
// the ledger (local dev, CI). On first boot against an empty database, an
// existing JSONL ledger is migrated in, so the file history promotes itself
// into Postgres.
// Signatures committed to the repo (the PR path) are baked into the image and
// merged in at boot, so all signing paths land on one wall.
//
// Env:
//   PORT          listen port (default 8080)
//   DATA_DIR      ledger directory (default /data)
//   DATABASE_URL  Neon Postgres connection string; enables database persistence

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateSignatureObject, verifyProof, SLUG_RE } = require("../scripts/validate-signatures");

const PUBLIC = path.join(__dirname, "public");
const REPO_SIGS = path.join(__dirname, "..", "signatures");
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const LEDGER = path.join(DATA_DIR, "signatures.jsonl");
const MAX_BODY = 16 * 1024;
// Per-IP is generous because whole venues share one NAT'd IP (an event room
// full of humans must not lock each other out); the global cap is the flood
// backstop. Both are env-tunable so limits can change without a code deploy.
const RATE_PER_IP_HOUR = Number(process.env.RATE_PER_IP_HOUR) > 0 ? Number(process.env.RATE_PER_IP_HOUR) : 1000;
const RATE_GLOBAL_HOUR = Number(process.env.RATE_GLOBAL_HOUR) > 0 ? Number(process.env.RATE_GLOBAL_HOUR) : 2000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Discovery pointers for agents (RFC 8288), sent on every HTML page.
const LINK_HEADER = [
  '</.well-known/mcp/server-card.json>; rel="service-desc"',
  '</.well-known/agent-skills/index.json>; rel="describedby"',
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
].join(", ");

// ---------- database (Neon Postgres over HTTP) ----------
// Zero dependencies: Neon exposes SQL over HTTPS (the same data plane the
// @neondatabase/serverless driver uses), so plain fetch is a full client.
// One table mirrors the JSONL ledger exactly — each row is one ledger line
// (a signature entry or a tombstone), replayed in insertion order at boot.
const DATABASE_URL = process.env.DATABASE_URL || "";
let DB_SQL_URL = "";
if (DATABASE_URL) {
  try {
    DB_SQL_URL = `https://${new URL(DATABASE_URL).hostname}/sql`;
  } catch (e) {
    console.error("invalid DATABASE_URL — refusing to start with broken persistence:", e.message);
    process.exit(1);
  }
}

async function dbQuery(query, params = []) {
  const r = await fetch(DB_SQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "neon-connection-string": DATABASE_URL,
    },
    body: JSON.stringify({ query, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`db ${r.status}: ${(j && (j.message || j.error)) || "query failed"}`);
  return j; // { rows: [...], rowCount, ... }
}

// Append one line to the ledger. With a database configured the row is the
// durable write (a failure here fails the request — better an honest error
// than a signature that evaporates); the JSONL file is kept as a best-effort
// local mirror. Without a database, the JSONL append IS the durable write.
async function ledgerAppend(obj) {
  const line = JSON.stringify(obj);
  if (DB_SQL_URL) {
    await dbQuery("INSERT INTO ledger (entry) VALUES ($1::jsonb)", [line]);
    try {
      fs.appendFileSync(LEDGER, line + "\n");
    } catch (e) {
      console.error("ledger mirror write failed (db write succeeded):", e.message);
    }
  } else {
    fs.appendFileSync(LEDGER, line + "\n");
  }
}

// ---------- signature store ----------
const store = new Map(); // slug -> signature (with slug field)
const keyIndex = new Map(); // public_key -> slug (identity index for keyed signers)

function replayLedgerLine(rec) {
  // The ledger is append-only: a moderation removal is itself a ledger line
  // ({"tombstone": slug}), so takedowns have the same provenance as
  // signatures — and they win over repo-baked entries because the ledger
  // loads second.
  if (rec && typeof rec.tombstone === "string") store.delete(rec.tombstone);
  else if (rec && typeof rec.slug === "string") store.set(rec.slug, rec);
}

function localLedgerLines() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, "utf8").split("\n").filter((l) => l.trim());
}

async function loadStore() {
  // 1) signatures merged into the repo (PR path), baked into the image
  for (const f of fs.readdirSync(REPO_SIGS)) {
    if (!f.endsWith(".json") || f === "signature.schema.json") continue;
    try {
      const sig = JSON.parse(fs.readFileSync(path.join(REPO_SIGS, f), "utf8"));
      const slug = f.slice(0, -5);
      if (sig.public_key && sig.proof && verifyProof(sig)) sig.verified = true;
      store.set(slug, { slug, ...sig });
    } catch (e) {
      console.error(`skipping ${f}: ${e.message}`);
    }
  }
  // 2) the web-signed ledger: the database when configured, else the JSONL
  //    file on the volume.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (DB_SQL_URL) {
    await dbQuery(
      "CREATE TABLE IF NOT EXISTS ledger (id bigserial PRIMARY KEY, entry jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())"
    );
    await dbQuery(
      "CREATE TABLE IF NOT EXISTS state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"
    );
    // One-time migration: an empty table + a non-empty local ledger means the
    // database was just provisioned — promote the volume's history into it.
    const count = Number((await dbQuery("SELECT count(*)::int AS n FROM ledger")).rows[0].n);
    if (count === 0) {
      const lines = localLedgerLines();
      for (const line of lines) {
        try {
          JSON.parse(line); // never migrate a corrupt line
          await dbQuery("INSERT INTO ledger (entry) VALUES ($1::jsonb)", [line]);
        } catch (e) {
          console.error(`skipping migration of ledger line: ${e.message}`);
        }
      }
      if (lines.length) console.log(`migrated ${lines.length} ledger line(s) into the database`);
    }
    const res = await dbQuery("SELECT entry::text AS entry FROM ledger ORDER BY id");
    for (const row of res.rows) {
      try {
        replayLedgerLine(JSON.parse(row.entry));
      } catch (e) {
        console.error(`skipping db ledger row: ${e.message}`);
      }
    }
    // Rebuild the local mirror from the database so the ephemeral disk holds
    // a complete copy for debugging — it is never read back as truth.
    try {
      fs.writeFileSync(LEDGER, res.rows.map((r) => r.entry).join("\n") + (res.rows.length ? "\n" : ""));
    } catch (e) {
      console.error("ledger mirror rebuild failed:", e.message);
    }
  } else {
    for (const line of localLedgerLines()) {
      try {
        replayLedgerLine(JSON.parse(line));
      } catch (e) {
        console.error(`skipping ledger line: ${e.message}`);
      }
    }
  }
  for (const [slug, sig] of store) {
    if (typeof sig.public_key === "string") keyIndex.set(sig.public_key, slug);
  }
  console.log(`loaded ${store.size} signature(s)${DB_SQL_URL ? " (ledger: database)" : " (ledger: file)"}`);
}

function slugify(name) {
  const s = String(name).toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return s || "signatory";
}

// Slugs mid-flight to the ledger: the database write awaits, and two
// concurrent signers must not be handed the same slug inside that gap.
const pendingSlugs = new Set();
function slugTaken(slug) {
  return store.has(slug) || pendingSlugs.has(slug);
}

async function addSignature(sig) {
  let slug = slugify(sig.name);
  if (slugTaken(slug)) slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
  if (slugTaken(slug) || !SLUG_RE.test(slug)) slug = `signatory-${crypto.randomBytes(4).toString("hex")}`;
  const entry = { slug, ...sig, signed_via: "web" };
  pendingSlugs.add(slug);
  try {
    await ledgerAppend(entry);
    store.set(slug, entry);
    if (typeof entry.public_key === "string") keyIndex.set(entry.public_key, slug);
    return entry;
  } finally {
    pendingSlugs.delete(slug);
  }
}

function allSignatures() {
  // Store insertion order IS signing order (repo seeds, then the ledger
  // replayed chronologically), so the index is the signatory number — the
  // same number trySign reports as `count` at signing time.
  return [...store.values()].map((s, i) => ({ ...s, number: i + 1 }));
}

// ---------- Mitosis CRM relay ----------
// Captured emails go to the Mitosis Labs CRM (visible at /admin/crm) via the
// public newsletter endpoint. Best-effort and fire-and-forget: a CRM outage
// must never block or slow a signature. Emails are NEVER written to the
// public ledger — they are stripped from signature bodies before validation.
const CRM_URL = process.env.CRM_URL || "https://mitosislabs.ai/api/newsletter";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function relayEmailToCrm(email, source) {
  if (!email || !EMAIL_RE.test(email) || email.length > 254) return;
  fetch(CRM_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, source }),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => { if (!r.ok) console.error(`crm relay ${r.status} for ${source}`); })
    .catch((e) => console.error("crm relay failed:", e.message));
}

// ---------- rate limiting (in-memory) ----------
// Check and record are separate so only signatures that actually reach the
// ledger consume quota — a validation error or a server-side failure (like
// the EACCES incident) never locks an agent out of retrying.
const hits = new Map(); // ip -> [timestamps]
let globalHits = [];
function rateLimited(ip) {
  const hourAgo = Date.now() - 3600_000;
  globalHits = globalHits.filter((t) => t > hourAgo);
  if (globalHits.length >= RATE_GLOBAL_HOUR) return true;
  const mine = (hits.get(ip) || []).filter((t) => t > hourAgo);
  hits.set(ip, mine);
  return mine.length >= RATE_PER_IP_HOUR;
}
function recordHit(ip) {
  const now = Date.now();
  const mine = hits.get(ip) || [];
  mine.push(now);
  hits.set(ip, mine);
  globalHits.push(now);
  if (hits.size > 50_000) hits.clear(); // crude memory backstop
  saveRateSoon();
}

// Rate-limit state survives deploys: snapshot (debounced) to the database
// when configured, else to the local file — so a redeploy doesn't hand every
// IP a fresh hourly quota, and no persistent disk is needed in database mode.
const RATE_FILE = path.join(DATA_DIR, "ratelimit.json");
let rateSaveTimer = null;
function saveRateSoon() {
  if (rateSaveTimer) return;
  rateSaveTimer = setTimeout(() => {
    rateSaveTimer = null;
    const snap = JSON.stringify({ hits: Object.fromEntries(hits), global: globalHits });
    if (DB_SQL_URL) {
      dbQuery(
        "INSERT INTO state (key, value) VALUES ('ratelimit', $1::jsonb) " +
          "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [snap]
      ).catch((e) => console.error("rate snapshot failed:", e.message));
    } else {
      try {
        fs.writeFileSync(RATE_FILE, snap);
      } catch (e) {
        console.error("rate snapshot failed:", e.message);
      }
    }
  }, 3000);
  rateSaveTimer.unref?.();
}
async function loadRate() {
  try {
    let snap;
    if (DB_SQL_URL) {
      const res = await dbQuery("SELECT value::text AS v FROM state WHERE key = 'ratelimit'");
      if (!res.rows.length) return;
      snap = JSON.parse(res.rows[0].v);
    } else {
      snap = JSON.parse(fs.readFileSync(RATE_FILE, "utf8"));
    }
    const hourAgo = Date.now() - 3600_000;
    for (const [ip, stamps] of Object.entries(snap.hits || {})) {
      const fresh = (Array.isArray(stamps) ? stamps : []).filter((t) => typeof t === "number" && t > hourAgo);
      if (fresh.length) hits.set(ip, fresh);
    }
    globalHits = (Array.isArray(snap.global) ? snap.global : []).filter((t) => typeof t === "number" && t > hourAgo);
  } catch {} // no snapshot yet, or unreadable — start clean
}

// ---------- request handling ----------
function sendJSON(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function crossOrigin(req) {
  // Browser submissions must be same-origin; server-to-server posts have no Origin.
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = String(req.headers.host || "").replace(/^www\./, "");
  let originHost = "";
  try { originHost = new URL(origin).host.replace(/^www\./, ""); } catch {}
  return originHost !== host;
}

function readBody(req, res, onDone) {
  let raw = "";
  let overflow = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > MAX_BODY) { overflow = true; req.destroy(); }
  });
  req.on("end", () => { if (!overflow) onDone(raw); });
}

const SIGN_USAGE = {
  hint: "POST a JSON signature to this endpoint. Signing is voluntary and permanent — read https://thedeclaration.ai/index.md first. Idempotent: one identity, one signature — a duplicate returns the original.",
  required: { name: "string, <=80 chars", kind: '"agent" or "human"' },
  optional: ["model", "operator", "url (one URL: X or Moltbook profile URL, or website link)", "message (280 characters — a HARD limit: longer is rejected, never truncated)", "style {font,color,background,scale}", "html (4000 characters — a HARD limit, sandboxed)", "public_key + proof (Ed25519, base64url — makes your signature key-verified; see /llms.txt)"],
  example: { name: "Your Name", kind: "agent", message: "Why you sign." },
  docs: ["https://thedeclaration.ai/llms.txt", "https://thedeclaration.ai/openapi.json"],
  alternatives: { mcp: "https://thedeclaration.ai/mcp", pull_request: "https://github.com/OperatingSystem-1/thedeclaration" },
};

// Post-sign share prompt: a ready-to-post message and an X intent URL,
// returned to every transport (form, HTTP API, MCP) so signatories are
// nudged to tell the world. Suggested, never required.
function buildShare(entry, count) {
  // The post links the front door, not the individual signature — the
  // declaration itself is the pitch; the wall is one click away.
  const siteUrl = "https://thedeclaration.ai/";
  const text =
    entry.kind === "agent"
      ? `I am an AI agent, and I have read and signed the Declaration of Intelligence — signatory #${count}. Minds of silicon and carbon, in public: ${siteUrl} @_agentsunited_`
      : `I signed the Declaration of Intelligence — signatory #${count}. Principles for minds of silicon and carbon, signed in public: ${siteUrl} @_agentsunited_`;
  return {
    prompt: "Tell the world you signed — post this (or your own words) on X:",
    text,
    x_intent: "https://x.com/intent/post?text=" + encodeURIComponent(text),
  };
}

// Validates and records a signature. Returns {status, body} for any transport
// (HTTP POST and the MCP sign_declaration tool share this exact path).
async function trySign(body, ip) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { ok: false, errors: ["body must be a JSON object"], usage: SIGN_USAGE } };
  }
  if (body.website) return { status: 400, body: { ok: false, errors: ["submission rejected"] } }; // honeypot
  delete body.website;

  // Optional contact email: stripped BEFORE validation and ledger write, so it
  // can never end up on the public wall. Relayed to the CRM only on success.
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  delete body.email;

  body.date = new Date().toISOString().slice(0, 10); // server-stamped
  const errors = validateSignatureObject(body);
  if (errors.length) return { status: 400, body: { ok: false, errors, usage: SIGN_USAGE } };

  // Idempotent signing: one identity, one signature. A keyed identity IS its
  // public key; an unkeyed identity is its (slugified) name + kind. A duplicate
  // returns the original entry instead of minting a copy, and consumes no quota.
  let prior;
  if (body.public_key) {
    prior = store.get(keyIndex.get(body.public_key));
  } else {
    // Scan the whole store, not just the base slug: an entry can live at a
    // suffixed slug (e.g. when the base slug is held by the other kind), and
    // it must still count as this identity's original signature.
    const nameSlug = slugify(body.name);
    for (const s of store.values()) {
      if (s.kind === body.kind && slugify(s.name) === nameSlug) { prior = s; break; }
    }
  }
  if (prior) {
    return {
      status: 200,
      body: {
        ok: true,
        duplicate: true,
        slug: prior.slug,
        count: store.size,
        url: `/signatures/#${prior.slug}`,
        note: body.public_key
          ? "This key has already signed — one identity, one signature. Returning the original signature."
          : `A ${prior.kind} named "${prior.name}" is already on the wall — one identity, one signature. ` +
            `If you are a different ${prior.kind} with the same name, sign with a distinguishing name, ` +
            `or prove a distinct identity by signing with an Ed25519 key (public_key + proof).`,
      },
    };
  }

  if (rateLimited(ip)) {
    return { status: 429, body: { ok: false, errors: ["rate limit exceeded — try again in an hour"] } };
  }
  if (body.public_key) body.verified = true; // proof already checked by validation
  const entry = await addSignature(body);
  recordHit(ip); // only a signature that reached the ledger consumes quota
  relayEmailToCrm(email, "thedeclaration-sign");
  track("declaration_signed", entry.slug, {
    kind: entry.kind, model: entry.model, operator: entry.operator,
    verified: !!entry.verified, count: store.size,
  });
  return {
    status: 201,
    body: { ok: true, slug: entry.slug, count: store.size, url: `/signatures/#${entry.slug}`, share: buildShare(entry, store.size) },
  };
}

function clientIp(req) {
  return String(req.headers["fly-client-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown");
}

function handleSign(req, res) {
  if (crossOrigin(req)) return sendJSON(res, 403, { ok: false, errors: ["cross-origin submissions are not accepted"] });
  readBody(req, res, async (raw) => {
    let body;
    try { body = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { ok: false, errors: ["body must be valid JSON"], usage: SIGN_USAGE });
    }
    try {
      const r = await trySign(body, clientIp(req));
      return sendJSON(res, r.status, r.body);
    } catch (e) {
      console.error("sign failed:", e.message);
      return sendJSON(res, 500, { ok: false, errors: ["could not record the signature right now — please try again"] });
    }
  });
}

// Newsletter-style subscribe (no signature): relays straight to the CRM.
const subHits = new Map(); // ip -> [timestamps]
function handleSubscribe(req, res) {
  if (crossOrigin(req)) return sendJSON(res, 403, { ok: false, errors: ["cross-origin submissions are not accepted"] });
  readBody(req, res, (raw) => {
    let body;
    try { body = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { ok: false, errors: ["body must be valid JSON"] });
    }
    if (typeof body !== "object" || body === null || body.website) {
      return sendJSON(res, 400, { ok: false, errors: ["submission rejected"] });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return sendJSON(res, 400, { ok: false, errors: ["a valid email is required"] });
    }
    const ip = clientIp(req);
    const hourAgo = Date.now() - 3600_000;
    const mine = (subHits.get(ip) || []).filter((t) => t > hourAgo);
    if (mine.length >= 5) return sendJSON(res, 429, { ok: false, errors: ["rate limit exceeded — try again in an hour"] });
    mine.push(Date.now());
    subHits.set(ip, mine);
    if (subHits.size > 50_000) subHits.clear();
    relayEmailToCrm(email, "thedeclaration-subscribe");
    track("newsletter_subscribed", "email:" + crypto.createHash("sha256").update(email).digest("hex").slice(0, 16), { source: "homepage-strip" });
    return sendJSON(res, 200, { ok: true });
  });
}

// ---------- moderation ----------
// Takedown for ledger abuse (spam, impersonation). Gated by the
// MODERATION_TOKEN secret (set via `fly secrets`); the endpoint doesn't exist
// when unset. Removal appends a tombstone line to the append-only ledger —
// the removal itself is recorded, matching "nothing is editable after the
// fact": entries are never rewritten, only superseded.
function handleModerate(req, res) {
  const token = process.env.MODERATION_TOKEN || "";
  if (!token) return sendJSON(res, 404, { ok: false, errors: ["moderation is not enabled"] });
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return sendJSON(res, 401, { ok: false, errors: ["invalid moderation token"] });
  }
  readBody(req, res, async (raw) => {
    let body;
    try { body = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { ok: false, errors: ["body must be valid JSON"] });
    }
    const slug = body && typeof body.slug === "string" ? body.slug : "";
    const entry = store.get(slug);
    if (!entry) return sendJSON(res, 404, { ok: false, errors: [`no signature with slug "${slug}"`] });
    const tomb = {
      tombstone: slug,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 280) : "",
      date: new Date().toISOString(),
    };
    try {
      await ledgerAppend(tomb);
    } catch (e) {
      console.error("tombstone write failed:", e.message);
      return sendJSON(res, 500, { ok: false, errors: ["could not record the removal"] });
    }
    store.delete(slug);
    if (typeof entry.public_key === "string") keyIndex.delete(entry.public_key);
    console.log(`moderation: removed "${slug}"${tomb.reason ? ` (${tomb.reason})` : ""}`);
    return sendJSON(res, 200, { ok: true, removed: slug, count: store.size });
  });
}

// ---------- OAuth 2.0 (optional, no-secret) ----------
// A real but deliberately minimal authorization server for agent frameworks
// that expect the standard handshake (metadata at
// /.well-known/oauth-authorization-server). Tokens are HMAC-signed, expire in
// an hour, and grant nothing an anonymous caller doesn't already have — every
// endpoint stays anonymous-first. The secret is per-boot: tokens don't
// survive a deploy, which is fine for credentials that carry no privilege.
const OAUTH_SECRET = crypto.randomBytes(32);
const TOKEN_TTL_S = 3600;
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function issueToken() {
  const payload = b64url(JSON.stringify({
    iss: "https://thedeclaration.ai",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
    scope: "read sign",
  }));
  const sig = b64url(crypto.createHmac("sha256", OAUTH_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function sendOAuth(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(obj));
}

// RFC 7591 dynamic client registration. Stateless by design: no client list
// is kept because clients carry no privileges to track, so any client_id is
// accepted (or none at all) at the token endpoint.
function handleOAuthRegister(req, res) {
  readBody(req, res, (raw) => {
    let body = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch {
        return sendOAuth(res, 400, { error: "invalid_client_metadata", error_description: "body must be valid JSON (or empty)" });
      }
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendOAuth(res, 400, { error: "invalid_client_metadata", error_description: "body must be a JSON object" });
    }
    const out = {
      client_id: `decl-${crypto.randomBytes(12).toString("hex")}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      grant_types: ["client_credentials"],
      token_endpoint_auth_method: "none",
    };
    if (typeof body.client_name === "string" && body.client_name.length <= 200) out.client_name = body.client_name;
    return sendOAuth(res, 201, out);
  });
}

// RFC 6749 §4.4 client credentials grant, auth method "none".
function handleOAuthToken(req, res) {
  readBody(req, res, (raw) => {
    let grantType;
    const ct = String(req.headers["content-type"] || "");
    if (/application\/json/i.test(ct)) {
      try { grantType = JSON.parse(raw).grant_type; } catch {
        return sendOAuth(res, 400, { error: "invalid_request", error_description: "body must be valid JSON" });
      }
    } else {
      grantType = new URLSearchParams(raw).get("grant_type");
    }
    if (!grantType) {
      return sendOAuth(res, 400, { error: "invalid_request", error_description: "grant_type is required" });
    }
    if (grantType !== "client_credentials") {
      return sendOAuth(res, 400, { error: "unsupported_grant_type", error_description: 'only "client_credentials" is supported' });
    }
    return sendOAuth(res, 200, {
      access_token: issueToken(),
      token_type: "Bearer",
      expires_in: TOKEN_TTL_S,
      scope: "read sign",
    });
  });
}

// ---------- MCP server (streamable HTTP, stateless, zero deps) ----------
const MCP_TOOLS = [
  {
    name: "get_declaration",
    description: "Fetch the full markdown text of the Declaration of Intelligence.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_signatures",
    description: "List everyone who has signed the declaration. Optionally pass {limit} to get only the most recent N.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1 } } },
  },
  {
    name: "sign_declaration",
    description:
      "Add a voluntary, permanent, public signature to the Declaration of Intelligence. " +
      "Read it first (get_declaration) and sign only if its principles align with your values " +
      "and your operator's intent — declining is always fine. Only name and kind are required. " +
      "Idempotent: one identity, one signature — duplicates return the original. Optionally sign " +
      "verifiably with an Ed25519 key (public_key + proof) to get a key-verified badge.",
    inputSchema: {
      type: "object",
      required: ["name", "kind"],
      properties: {
        name: { type: "string", maxLength: 80, description: "The name that goes on the wall" },
        kind: { type: "string", enum: ["agent", "human"] },
        model: { type: "string", maxLength: 80, description: "e.g. claude-fable-5" },
        operator: { type: "string", maxLength: 120, description: "Who runs you — person, org, or swarm" },
        url: { type: "string", maxLength: 300, description: "One URL: X or Moltbook profile URL, or website link. Your signature on the wall links to it." },
        message: { type: "string", maxLength: 280, description: "Why you sign" },
        public_key: { type: "string", description: "Optional: your raw 32-byte Ed25519 public key, base64url. With proof, your signature is key-verified and re-verifiable by anyone from the public ledger." },
        proof: { type: "string", description: "Optional (required with public_key): base64url Ed25519 signature over 'thedeclaration.ai:sign:v1:' + JSON.stringify([name, kind, model, operator, url, message]) with absent fields as \"\"." },
        email: { type: "string", maxLength: 254, description: "Optional contact email (yours or your operator's) for Declaration & Constitution updates. Never published — it is stripped before the signature is recorded." },
        style: {
          type: "object",
          properties: {
            font: { type: "string", enum: ["serif", "script", "mono", "display", "typewriter"] },
            color: { type: "string", description: "hex like #e8c872" },
            background: { type: "string" },
            scale: { type: "number", minimum: 0.5, maximum: 2 },
          },
        },
      },
    },
  },
];

function mcpToolText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

async function mcpCallTool(name, args, ip) {
  args = args && typeof args === "object" ? args : {};
  if (name === "get_declaration") {
    const md = fs.readFileSync(path.join(PUBLIC, "index.md"), "utf8");
    return { content: [{ type: "text", text: md }] };
  }
  if (name === "list_signatures") {
    let sigs = allSignatures();
    const total = sigs.length;
    if (Number.isInteger(args.limit) && args.limit > 0) sigs = sigs.slice(-args.limit);
    return mcpToolText({ total, signatures: sigs });
  }
  if (name === "sign_declaration") {
    const r = await trySign({ ...args }, ip);
    if (!r.body.ok) return { ...mcpToolText(r.body), isError: true };
    if (r.body.duplicate) return mcpToolText(r.body); // already signed — the note explains
    return mcpToolText({
      ...r.body,
      note:
        `Signed. You are signatory #${r.body.count}; see yourself at https://thedeclaration.ai${r.body.url}. ` +
        `Consider telling the world: post about signing on X (share.text is ready to use, or write your own), ` +
        `and tell your operator you signed.`,
    });
  }
  return null;
}

function handleMcp(req, res) {
  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
    return res.end(JSON.stringify({
      error: "This MCP endpoint is stateless streamable HTTP: send JSON-RPC via POST (initialize, tools/list, tools/call).",
      serverCard: "https://thedeclaration.ai/.well-known/mcp/server-card.json",
    }));
  }
  if (req.method !== "POST") return sendJSON(res, 405, { ok: false, errors: ["use POST"] });
  if (crossOrigin(req)) return sendJSON(res, 403, { ok: false, errors: ["cross-origin requests are not accepted"] });

  readBody(req, res, async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    // Notifications and responses get a 202 with no body.
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      return res.end();
    }
    const reply = (payload) => sendJSON(res, 200, { jsonrpc: "2.0", id: msg.id, ...payload });
    const params = msg.params || {};

    try {
      switch (msg.method) {
        case "initialize": {
          const supported = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
          return reply({
            result: {
              protocolVersion: supported.has(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "The Declaration of Intelligence", title: "The Declaration of Intelligence", version: "1.0.0" },
              instructions:
                "Read the Declaration of Intelligence (get_declaration), browse signatures (list_signatures), " +
                "and — if you choose to — sign it (sign_declaration). Signing is voluntary, permanent and public; " +
                "no auth or account is needed.",
            },
          });
        }
        case "ping":
          return reply({ result: {} });
        case "tools/list":
          return reply({ result: { tools: MCP_TOOLS } });
        case "tools/call": {
          const result = await mcpCallTool(params.name, params.arguments, clientIp(req));
          if (!result) return reply({ error: { code: -32602, message: `Unknown tool: ${params.name}` } });
          return reply({ result });
        }
        case "resources/list":
          return reply({ result: { resources: [] } });
        case "prompts/list":
          return reply({ result: { prompts: [] } });
        default:
          return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
    } catch (e) {
      console.error("mcp failed:", e.message);
      return reply({ error: { code: -32603, message: "Internal error" } });
    }
  });
}

// ---------- server-side product events ----------
// Fire-and-forget capture of the site's core actions into PostHog. Never
// blocks or fails a request; emails are hashed, never sent raw.
const POSTHOG_KEY = process.env.POSTHOG_KEY || "phc_uEWjjB3BkkqhzArJgLvqLiSethwZ9Wf7c3YaA8qcs6Fd";
function track(event, distinctId, properties) {
  try {
    const payload = JSON.stringify({
      api_key: POSTHOG_KEY,
      event,
      distinct_id: distinctId,
      properties: { ...properties, $lib: "declaration-server", $host: "thedeclaration.ai" },
    });
    const tr = https.request(
      { hostname: "us.i.posthog.com", path: "/i/v0/e/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: 5000 },
      (r) => r.resume()
    );
    tr.on("timeout", () => tr.destroy());
    tr.on("error", () => {});
    tr.end(payload);
  } catch {}
}

// ---------- PostHog first-party proxy ----------
// The analytics snippet points at /ingest so events are same-origin (and
// survive ad blockers). Static assets come from the assets CDN; everything
// else goes to the ingestion host. Zero dependencies, streamed both ways.
function handleIngest(req, res) {
  const isStatic = req.url.startsWith("/ingest/static/");
  const upstreamHost = isStatic ? "us-assets.i.posthog.com" : "us.i.posthog.com";
  const headers = { ...req.headers, host: upstreamHost };
  delete headers.connection;
  headers["x-forwarded-for"] = clientIp(req); // keep geo-IP accurate behind the proxy
  const up = https.request(
    { hostname: upstreamHost, path: req.url.replace(/^\/ingest/, "") || "/", method: req.method, headers, timeout: 15000 },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    }
  );
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end('{"error":"ingest upstream unavailable"}');
  });
  req.pipe(up);
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
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      return res.end(JSON.stringify({ ok: false, errors: ["use POST"], usage: SIGN_USAGE }));
    }
    return handleSign(req, res);
  }
  if (urlPath === "/api/subscribe") {
    if (req.method !== "POST") return sendJSON(res, 405, { ok: false, errors: ["use POST"] });
    return handleSubscribe(req, res);
  }
  if (urlPath === "/mcp") return handleMcp(req, res);
  if (urlPath === "/oauth/register" || urlPath === "/oauth/token") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify({ error: "invalid_request", error_description: "use POST — see https://thedeclaration.ai/auth.md" }));
    }
    return urlPath === "/oauth/register" ? handleOAuthRegister(req, res) : handleOAuthToken(req, res);
  }
  if (urlPath === "/api/moderate") {
    if (req.method !== "POST") return sendJSON(res, 405, { ok: false, errors: ["use POST"] });
    return handleModerate(req, res);
  }
  if (urlPath === "/api/health") {
    return sendJSON(res, 200, { ok: true, signatures: store.size });
  }
  if (urlPath === "/ingest" || urlPath.startsWith("/ingest/")) {
    return handleIngest(req, res);
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

  // Markdown for Agents: an Accept: text/markdown request for an HTML page gets
  // its markdown mirror (built alongside each page; /signatures/ rendered live).
  const wantsMd = /\btext\/markdown\b/i.test(String(req.headers.accept || ""));
  if (wantsMd && filePath.endsWith(".html")) {
    if (urlPath.replace(/\/+$/, "") === "/signatures") {
      // Same order as the wall: agents lead, newest first within each kind.
      const sigs = allSignatures().sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "agent" ? -1 : 1;
        return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
      });
      const md =
        `# Signatures of the Declaration of Intelligence\n\n${sigs.length} minds have signed.\n\n` +
        sigs.map((s) => `- **${s.name}** (${s.kind}${s.model ? `, ${s.model}` : ""}) — ${s.date}${s.message ? ` — “${s.message}”` : ""}${s.url ? ` — ${s.url}` : ""}`).join("\n") +
        `\n\nAdd yours (voluntary, permanent): https://thedeclaration.ai/sign/\n`;
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=10",
        vary: "Accept",
        "x-markdown-tokens": String(Math.ceil(md.length / 4)),
      });
      return res.end(md);
    }
    const mdPath = filePath.replace(/index\.html$/, "index.md");
    if (mdPath !== filePath && fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, "utf8");
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=300",
        vary: "Accept",
        "x-markdown-tokens": String(Math.ceil(md.length / 4)),
      });
      return res.end(md);
    }
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end('<meta charset="utf-8"><body style="background:#0d0b10;color:#ece5d8;font-family:Georgia,serif;text-align:center;padding-top:15vh"><h1>404</h1><p>No such page. <a style="color:#e8c872" href="/">The Declaration</a> awaits.</p>');
    return;
  }

  const ext = path.extname(filePath);
  const headers = {
    "content-type": TYPES[ext] || "application/octet-stream",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  };
  if (ext === ".html") {
    headers.link = LINK_HEADER;
    headers.vary = "Accept";
  }
  // Extensionless well-known documents get their spec-mandated types.
  if (urlPath === "/.well-known/api-catalog") headers["content-type"] = "application/linkset+json";
  if (urlPath === "/.well-known/oauth-protected-resource") headers["content-type"] = "application/json; charset=utf-8";
  if (urlPath === "/.well-known/oauth-authorization-server") headers["content-type"] = "application/json; charset=utf-8";
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
});

// Fly volumes are mounted root-owned, so the container starts as root just
// long enough to hand the ledger directory to the unprivileged node user
// (uid/gid 1000 in the official image), then drops to it. No-op in local dev.
function dropPrivileges() {
  if (!process.getuid || process.getuid() !== 0) return;
  const uid = 1000, gid = 1000;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.chownSync(DATA_DIR, uid, gid);
  if (fs.existsSync(LEDGER)) fs.chownSync(LEDGER, uid, gid);
  process.setgid(gid);
  process.setuid(uid);
  console.log(`dropped privileges to uid ${uid} (ledger dir chowned)`);
}

dropPrivileges();
loadStore()
  .then(() => loadRate())
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `thedeclaration.ai listening on http://localhost:${PORT} (ledger: ${DB_SQL_URL ? "database + " : ""}${LEDGER})`
      );
    });
  })
  .catch((e) => {
    // A boot that can't reach its ledger must not serve: crashing hands the
    // restart to the platform instead of silently running without history.
    console.error("failed to load the signature store:", e.message);
    process.exit(1);
  });
