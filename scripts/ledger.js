// Shared ledger functions for CLI and server
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CHAIN_GENESIS = "0".repeat(64);

function canonicalJSON(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

function chainHash(prev, rec) {
  const { prev: _p, h: _h, ...rest } = rec;
  return crypto
    .createHash("sha256")
    .update("thedeclaration.ai:ledger:v1:" + prev + ":" + canonicalJSON(rest), "utf8")
    .digest("hex");
}

function loadLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { chain: [], chainHead: CHAIN_GENESIS, store: new Map(), keyIndex: new Map() };
  
  let chainHead = CHAIN_GENESIS;
  const ledgerChain = [];
  const store = new Map();
  const keyIndex = new Map();

  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const expected = chainHash(chainHead, rec);
      if (rec.h) {
        if (rec.h !== expected) {
          console.error(`LEDGER CHAIN MISMATCH: hash mismatch at ${rec.slug || rec.tombstone || "?"}`);
        }
        chainHead = rec.h;
      } else {
        chainHead = expected;
      }
      ledgerChain.push(rec);

      // Update store
      if (typeof rec.tombstone === "string") {
        store.delete(rec.tombstone);
      } else if (typeof rec.slug === "string") {
        store.set(rec.slug, rec);
        if (typeof rec.public_key === "string") {
          keyIndex.set(rec.public_key, rec.slug);
        }
      }
    } catch (e) {
      console.error(`skipping ledger line: ${e.message}`);
    }
  }

  return { chain: ledgerChain, chainHead, store, keyIndex };
}

function appendLedger(ledgerPath, obj, chainHead) {
  const rec = { ...obj, prev: chainHead };
  rec.h = chainHash(chainHead, rec);
  const line = JSON.stringify(rec);
  fs.appendFileSync(ledgerPath, line + "\n");
  return rec;
}

module.exports = {
  CHAIN_GENESIS,
  canonicalJSON,
  chainHash,
  loadLedger,
  appendLedger,
};
