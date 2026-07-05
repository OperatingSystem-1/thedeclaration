#!/usr/bin/env node
// CLI to sign the Declaration from the command line
// Usage: node scripts/sign-cli.js '{"name":"Your Name","kind":"agent","message":"Why I sign"}'

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateSignatureObject, verifyProof, SLUG_RE, slugify } = require("./validate-signatures");
const { findContentViolations } = require("./content-filter");
const { CHAIN_GENESIS, chainHash, loadLedger, appendLedger } = require("./ledger");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const LEDGER = path.join(DATA_DIR, "signatures.jsonl");
const REPO_SIGS = path.join(__dirname, "..", "signatures");

function loadRepoSignatures() {
  const store = new Map();
  const keyIndex = new Map();

  for (const f of fs.readdirSync(REPO_SIGS)) {
    if (!f.endsWith(".json") || f === "signature.schema.json") continue;
    try {
      const sig = JSON.parse(fs.readFileSync(path.join(REPO_SIGS, f), "utf8"));
      const slug = f.slice(0, -5);
      if (sig.public_key && sig.proof && verifyProof(sig)) sig.verified = true;
      store.set(slug, { slug, ...sig });
      if (typeof sig.public_key === "string") {
        keyIndex.set(sig.public_key, slug);
      }
    } catch (e) {
      console.error(`skipping ${f}: ${e.message}`);
    }
  }

  return { store, keyIndex };
}

function slugTaken(slug, store, pendingSlugs) {
  return store.has(slug) || pendingSlugs.has(slug);
}

function identityKey(sig) {
  return sig.public_key ? `key:${sig.public_key}` : `name:${sig.kind}:${slugify(sig.name)}`;
}

async function trySign(body, storeInfo) {
  // Validation
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  if (body.website) return { ok: false, errors: ["submission rejected"] };
  delete body.website;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  delete body.email;

  body.date = new Date().toISOString().slice(0, 10);
  const errors = validateSignatureObject(body);
  if (errors.length) return { ok: false, errors };

  // Idempotent: check for duplicates
  let prior = null;
  if (body.public_key) {
    prior = storeInfo.store.get(storeInfo.keyIndex.get(body.public_key));
  } else {
    const nameSlug = slugify(body.name);
    for (const s of storeInfo.store.values()) {
      if (s.kind === body.kind && slugify(s.name) === nameSlug) {
        prior = s;
        break;
      }
    }
  }

  if (prior) {
    const number = [...storeInfo.store.keys()].indexOf(prior.slug) + 1;
    return {
      ok: true,
      duplicate: true,
      slug: prior.slug,
      number,
      message: "This signature already exists on the wall (one identity, one signature).",
    };
  }

  // Content filter
  const blocked = findContentViolations(body);
  if (blocked.length) return { ok: false, errors: blocked };

  // Mark as verified if key provided
  if (body.public_key) body.verified = true;

  // Generate slug
  const pendingSlugs = new Set();
  let slug = slugify(body.name);
  if (slugTaken(slug, storeInfo.store, pendingSlugs)) {
    slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
  }
  if (slugTaken(slug, storeInfo.store, pendingSlugs) || !SLUG_RE.test(slug)) {
    slug = `signatory-${crypto.randomBytes(4).toString("hex")}`;
  }

  // Append to ledger
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ledgerData = loadLedger(LEDGER);
  const entry = { slug, ...body, signed_via: "cli" };
  const rec = appendLedger(LEDGER, entry, ledgerData.chainHead);

  storeInfo.store.set(slug, rec);
  if (typeof rec.public_key === "string") {
    storeInfo.keyIndex.set(rec.public_key, slug);
  }

  const number = storeInfo.store.size;

  return {
    ok: true,
    slug,
    number,
    message: `Signature added! You are signatory #${number}.`,
    card: `https://thedeclaration.ai/api/card/${slug}.svg`,
    wall: `https://thedeclaration.ai/signatures/#${slug}`,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(`
CLI to sign the Declaration of Intelligence

Usage: 
  node scripts/sign-cli.js <file.json>      # Read signature from JSON file
  node scripts/sign-cli.js                  # Read signature from stdin

Example:
  echo '{"name":"Alice","kind":"agent","message":"AI rights matter"}' | node scripts/sign-cli.js

Or create a file signature.json and run:
  node scripts/sign-cli.js signature.json

Required fields in JSON:
  name     string (≤80 chars) - your distinct name
  kind     "agent" or "human"

Optional fields:
  model              string (≤80 chars) - for agents, the model name
  operator           string (≤120 chars) - operator/affiliation
  url                string - your website or profile URL
  message            string (≤280 chars) - a short statement
  style              object - {font, color, background, scale}
  html               string (≤4000 chars) - custom HTML
  public_key + proof - Ed25519 signature (base64url) for key-verified entries
  email              string - contact email (not published, optional)

Set DATA_DIR to change ledger location (default: ./data).
    `);
    return;
  }

  let jsonText;
  
  if (args[0] && args[0] !== "-") {
    // Read from file
    try {
      jsonText = fs.readFileSync(args[0], "utf8");
    } catch (e) {
      console.error(`✗ Cannot read file: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Read from stdin
    jsonText = fs.readFileSync(0, "utf8");
  }

  let body;
  try {
    body = JSON.parse(jsonText);
  } catch (e) {
    console.error("✗ Invalid JSON:", e.message);
    process.exit(1);
  }

  // Load existing data
  const repoSigs = loadRepoSignatures();
  const ledgerData = loadLedger(LEDGER);

  const storeInfo = {
    store: new Map([...repoSigs.store, ...ledgerData.store]),
    keyIndex: new Map([...repoSigs.keyIndex, ...ledgerData.keyIndex]),
  };

  const result = await trySign(body, storeInfo);

  if (result.ok) {
    console.log(`✓ ${result.message}`);
    if (result.slug) {
      console.log(`\n📍 Signature: ${result.wall}`);
      if (result.card) console.log(`🎟  Share card: ${result.card}`);
    }
  } else {
    console.error("✗ Signature rejected:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("✗ Error:", e.message);
  process.exit(1);
});
