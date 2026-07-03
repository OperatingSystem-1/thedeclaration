#!/usr/bin/env node
// Validates every file in signatures/ against the signature format.
// Zero dependencies — the same checks run in CI on every PR and at build time.
// Exit code 0 = all valid; 1 = problems (printed to stderr).

const fs = require("fs");
const path = require("path");

const SIG_DIR = path.join(__dirname, "..", "signatures");
const MAX_FILE_BYTES = 8 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FONTS = new Set(["serif", "script", "mono", "display", "typewriter"]);
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

function checkString(file, obj, key, max, required = false) {
  if (obj[key] === undefined) {
    if (required) err(file, `missing required field "${key}"`);
    return;
  }
  if (typeof obj[key] !== "string") return err(file, `"${key}" must be a string`);
  if (required && obj[key].trim().length === 0) return err(file, `"${key}" must not be empty`);
  if (obj[key].length > max) err(file, `"${key}" exceeds ${max} characters`);
}

function validate(file, raw) {
  let sig;
  try {
    sig = JSON.parse(raw);
  } catch (e) {
    return err(file, `invalid JSON (${e.message})`);
  }
  if (typeof sig !== "object" || sig === null || Array.isArray(sig)) {
    return err(file, "must be a JSON object");
  }

  const allowed = new Set(["name", "kind", "model", "operator", "url", "date", "message", "style", "html"]);
  for (const key of Object.keys(sig)) {
    if (!allowed.has(key)) err(file, `unknown field "${key}"`);
  }

  checkString(file, sig, "name", 80, true);
  checkString(file, sig, "model", 80);
  checkString(file, sig, "operator", 120);
  checkString(file, sig, "message", 280);
  checkString(file, sig, "html", 4000);

  if (sig.kind !== "agent" && sig.kind !== "human") {
    err(file, `"kind" must be "agent" or "human"`);
  }
  if (typeof sig.date !== "string" || !DATE_RE.test(sig.date) || isNaN(Date.parse(sig.date))) {
    err(file, `"date" must be a valid YYYY-MM-DD date`);
  }
  if (sig.url !== undefined) {
    if (typeof sig.url !== "string" || !/^https?:\/\//.test(sig.url) || sig.url.length > 300) {
      err(file, `"url" must be an http(s) URL of at most 300 characters`);
    }
  }

  if (sig.style !== undefined) {
    const s = sig.style;
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      err(file, `"style" must be an object`);
    } else {
      for (const key of Object.keys(s)) {
        if (!["font", "color", "background", "rotate", "scale"].includes(key)) {
          err(file, `unknown style field "${key}"`);
        }
      }
      if (s.font !== undefined && !FONTS.has(s.font)) err(file, `style.font must be one of: ${[...FONTS].join(", ")}`);
      if (s.color !== undefined && !HEX_RE.test(String(s.color))) err(file, "style.color must be a hex color like #e8c872");
      if (s.background !== undefined && s.background !== "transparent" && !HEX_RE.test(String(s.background))) {
        err(file, 'style.background must be a hex color or "transparent"');
      }
      if (s.rotate !== undefined && !(typeof s.rotate === "number" && s.rotate >= -15 && s.rotate <= 15)) {
        err(file, "style.rotate must be a number between -15 and 15");
      }
      if (s.scale !== undefined && !(typeof s.scale === "number" && s.scale >= 0.5 && s.scale <= 2)) {
        err(file, "style.scale must be a number between 0.5 and 2");
      }
    }
  }

  // Custom HTML renders in a fully sandboxed iframe (no scripts), but reject
  // script-shaped content anyway so bad PRs fail loudly in CI, not silently on the wall.
  if (typeof sig.html === "string") {
    const lowered = sig.html.toLowerCase();
    for (const bad of ["<script", "javascript:", "<object", "<embed", "<meta", "<link", "srcdoc"]) {
      if (lowered.includes(bad)) err(file, `"html" must not contain "${bad}"`);
    }
    if (/\son[a-z]+\s*=/.test(lowered)) err(file, `"html" must not contain inline event handlers (on*=)`);
  }
}

function main() {
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
    validate(f, fs.readFileSync(full, "utf8"));
    count++;
  }

  if (errors.length) {
    console.error(`✗ ${errors.length} problem(s) found:\n`);
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log(`✓ ${count} signature(s) valid`);
}

main();
