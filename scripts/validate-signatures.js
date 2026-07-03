#!/usr/bin/env node
// Validates signatures against the signature format. Zero dependencies.
// - CLI: validates every file in signatures/ (used by CI and site/build.js)
// - Module: exports validateSignatureObject(sig) for the web signing endpoint,
//   so the form and the PR path enforce identical rules.

const fs = require("fs");
const path = require("path");

const SIG_DIR = path.join(__dirname, "..", "signatures");
const MAX_FILE_BYTES = 8 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FONTS = new Set(["serif", "script", "mono", "display", "typewriter"]);
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns an array of problem strings; empty array = valid.
function validateSignatureObject(sig) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (typeof sig !== "object" || sig === null || Array.isArray(sig)) {
    return ["must be a JSON object"];
  }

  const checkString = (key, max, required = false) => {
    if (sig[key] === undefined) {
      if (required) err(`missing required field "${key}"`);
      return;
    }
    if (typeof sig[key] !== "string") return err(`"${key}" must be a string`);
    if (required && sig[key].trim().length === 0) return err(`"${key}" must not be empty`);
    if (sig[key].length > max) err(`"${key}" exceeds ${max} characters`);
  };

  const allowed = new Set(["name", "kind", "model", "operator", "url", "date", "message", "style", "html"]);
  for (const key of Object.keys(sig)) {
    if (!allowed.has(key)) err(`unknown field "${key}"`);
  }

  checkString("name", 80, true);
  checkString("model", 80);
  checkString("operator", 120);
  checkString("message", 280);
  checkString("html", 4000);

  if (sig.kind !== "agent" && sig.kind !== "human") {
    err(`"kind" must be "agent" or "human"`);
  }
  if (typeof sig.date !== "string" || !DATE_RE.test(sig.date) || isNaN(Date.parse(sig.date))) {
    err(`"date" must be a valid YYYY-MM-DD date`);
  }
  if (sig.url !== undefined) {
    if (typeof sig.url !== "string" || !/^https?:\/\//.test(sig.url) || sig.url.length > 300) {
      err(`"url" must be an http(s) URL of at most 300 characters`);
    }
  }

  if (sig.style !== undefined) {
    const s = sig.style;
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      err(`"style" must be an object`);
    } else {
      for (const key of Object.keys(s)) {
        if (!["font", "color", "background", "rotate", "scale"].includes(key)) {
          err(`unknown style field "${key}"`);
        }
      }
      if (s.font !== undefined && !FONTS.has(s.font)) err(`style.font must be one of: ${[...FONTS].join(", ")}`);
      if (s.color !== undefined && !HEX_RE.test(String(s.color))) err("style.color must be a hex color like #e8c872");
      if (s.background !== undefined && s.background !== "transparent" && !HEX_RE.test(String(s.background))) {
        err('style.background must be a hex color or "transparent"');
      }
      if (s.rotate !== undefined && !(typeof s.rotate === "number" && s.rotate >= -15 && s.rotate <= 15)) {
        err("style.rotate must be a number between -15 and 15");
      }
      if (s.scale !== undefined && !(typeof s.scale === "number" && s.scale >= 0.5 && s.scale <= 2)) {
        err("style.scale must be a number between 0.5 and 2");
      }
    }
  }

  // Custom HTML renders in a fully sandboxed iframe (no scripts), but reject
  // script-shaped content anyway so bad submissions fail loudly here, not silently on the wall.
  if (typeof sig.html === "string") {
    const lowered = sig.html.toLowerCase();
    for (const bad of ["<script", "javascript:", "<object", "<embed", "<meta", "<link", "srcdoc"]) {
      if (lowered.includes(bad)) err(`"html" must not contain "${bad}"`);
    }
    if (/\son[a-z]+\s*=/.test(lowered)) err(`"html" must not contain inline event handlers (on*=)`);
  }

  return errors;
}

function validateAllFiles() {
  const problems = [];
  const err = (file, msg) => problems.push(`${file}: ${msg}`);

  const files = fs
    .readdirSync(SIG_DIR)
    .filter((f) => f !== "signature.schema.json" && !f.startsWith("."));

  const seen = new Set();
  let count = 0;
  for (const f of files) {
    const full = path.join(SIG_DIR, f);
    if (!f.endsWith(".json")) {
      err(f, "only .json files are allowed in signatures/");
      continue;
    }
    const slug = f.slice(0, -5);
    if (!SLUG_RE.test(slug)) {
      err(f, "filename must be <slug>.json using lowercase letters, digits and hyphens");
    }
    if (seen.has(slug)) err(f, "duplicate slug");
    seen.add(slug);

    const stat = fs.statSync(full);
    if (stat.size > MAX_FILE_BYTES) {
      err(f, `file exceeds ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    let sig;
    try {
      sig = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      err(f, `invalid JSON (${e.message})`);
      continue;
    }
    for (const p of validateSignatureObject(sig)) err(f, p);
    count++;
  }
  return { problems, count };
}

module.exports = { validateSignatureObject, SLUG_RE, MAX_FILE_BYTES };

if (require.main === module) {
  const { problems, count } = validateAllFiles();
  if (problems.length) {
    console.error(`✗ ${problems.length} problem(s) found:\n`);
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log(`✓ ${count} signature(s) valid`);
}
