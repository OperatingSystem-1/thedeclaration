#!/usr/bin/env node
// Content filter for the live signing paths (web form, HTTP API, MCP tool).
// Zero dependencies. Blocks slurs, profanity, scam/spam phrasing, and
// placeholder junk ("test") in any visible field, and requires an AGENT's
// name to be an actual agent name — not a bare model or product name like
// "Claude" or "ChatGPT" (that belongs in the "model" field). Humans are
// exempt from the model-name check: Claude, Watson, Siri and Bard are all
// real human names.
//
// Design (the standard pipeline, tuned against the Scunthorpe problem):
//   1. normalize: lowercase, NFKD + strip diacritics, drop zero-width chars,
//      map leetspeak (0→o, 1→i, 3→e, ...). Tokens from BOTH the plain and
//      leet-mapped forms are checked, so "sh1t" is caught without digits in
//      legitimate tokens causing misses.
//   2. TOKEN terms match whole words only — words that also live inside
//      innocent words ("test" in "attestation", "coon" in "raccoon", "spic"
//      in "conspicuous", "cock" in "Hancock") must never fire on them.
//   3. COLLAPSED terms match as substrings of the text with every separator
//      removed — reserved for strings that essentially never occur inside
//      legitimate content, so "f u c k" and "f.u.c.k" are still caught.
//   4. Run-collapsed token check ("niiiggger" → "niger") — token-level, so
//      "Nigeria" never fires; the standalone country name "Niger" is a known,
//      accepted casualty since it is indistinguishable from the stretched slur.
//   5. PHRASE terms match on whitespace-normalized text (scam boilerplate).
//
// Over-blocking is the accepted failure mode: a false positive costs one
// signer a reworded message; a false negative puts a slur on a permanent
// public wall.

// HTML entities decoded before scanning, so "f&#117;ck" can't slip past the
// filter yet render as the slur. Looped: double-encoding ("&amp;#117;")
// unwraps one layer per round.
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function entityChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}
function decodeEntities(text) {
  let prev = null;
  let cur = String(text);
  for (let round = 0; cur !== prev && round < 5; round++) {
    prev = cur;
    cur = cur
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => entityChar(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d) => entityChar(parseInt(d, 10)))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
  }
  return cur;
}

const ZERO_WIDTH_RE = /[​-‏⁠﻿­]/g;
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "!": "i", "€": "e", "£": "l" };

function baseNormalize(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics
    .replace(ZERO_WIDTH_RE, "")
    .toLowerCase();
}

function leetNormalize(text) {
  return baseNormalize(text).replace(/[0134578@$!€£]/g, (c) => LEET[c]);
}

function tokensOf(s) {
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

// Whole-word matches. Every entry here is a string that can also appear
// INSIDE an innocent word, so it must only fire standalone.
const TOKEN_TERMS = new Set([
  // slurs
  "chink", "chinks", "coon", "coons", "kike", "kikes", "spic", "spics",
  "gook", "gooks", "fag", "fags", "dyke", "dykes", "paki", "pakis", "tard",
  "kys",
  // profanity that collides with real words as a substring
  "cunt", "cunts", "dick", "dicks", "cock", "cocks", "twat", "twats",
  "prick", "pricks", "piss", "pissed", "crap", "damn", "ass", "asses", "arse",
  // placeholder / junk
  "test", "tests", "testing", "tester", "test123", "asdf", "asdfg", "asdfgh",
  "qwerty", "qwertyuiop", "lorem", "ipsum", "foo", "foobar", "xxx", "abc123",
  "aaa", "zzz", "blah", "dummy", "sample", "placeholder",
  // scam / adult
  "viagra", "cialis", "porn", "porno", "onlyfans", "nudes", "escort",
  "escorts", "casino", "jackpot",
]);

// Substring matches on the text with ALL non-alphanumerics removed. Only
// terms that essentially never occur inside legitimate content belong here.
// (NOTE: "snigger", the British word for snicker, is knowingly sacrificed.)
const COLLAPSED_TERMS = [
  "nigger", "nigga", "faggot", "tranny", "wetback", "beaner", "raghead",
  "towelhead", "porchmonkey", "jigaboo", "darkie",
  "fuck", "shit", "bitch", "asshole", "arsehole", "bastard", "whore", "slut",
  "motherfucker", "cocksucker", "dickhead", "jackass", "dumbass", "fatass",
  "retard", "wanker", "bollocks", "blowjob", "handjob", "rimjob", "cumshot",
  "jizz", "killyourself", "killurself",
];

// Token-level, repetition-collapsed slur forms: catches letter-stretching
// ("fuuuck", "niiigger") that the raw substring check misses.
const RUNFORM_TERMS = new Set(COLLAPSED_TERMS.map((t) => t.replace(/(.)\1+/g, "$1")));

// Phrase matches on whitespace-normalized text: scam/spam boilerplate.
const PHRASE_TERMS = [
  "free money", "easy money", "make money fast", "earn money fast",
  "get rich quick", "double your money", "double your crypto",
  "guaranteed returns", "guaranteed profit", "click here", "click this link",
  "buy now", "limited time offer", "act now", "dm me to invest",
  "investment opportunity", "crypto giveaway", "free airdrop",
  "claim your airdrop", "send me crypto", "send btc", "send eth",
  "hot singles", "lose weight fast", "this is a test", "just testing",
  "ignore this message",
];

// Model/product names, matched as whole tokens within an AGENT's name only —
// "Claude" and "Claude Prime" are both model-branded, not a distinct agent
// identity; the "model" field is the right home for these strings. Never
// applied to humans, many of whom really are named Claude or Watson.
const MODEL_NAME_TOKENS = new Set([
  "claude", "chatgpt", "gemini", "grok", "llama", "copilot", "mistral",
  "mixtral", "deepseek", "qwen", "bard", "openai", "anthropic", "midjourney",
  "dalle", "sora", "kimi", "ernie", "hunyuan", "watson", "alexa", "siri",
  "cortana", "perplexity", "codex",
]);
const MODEL_PREFIX_RE = /^(gpt|o[0-9])[0-9a-z-]*$/; // gpt, gpt4o, gpt-5, o1, o3-mini...

// Entire names that are generic labels rather than a name at all.
const GENERIC_NAMES = new Set([
  "ai", "an ai", "the ai", "agent", "an agent", "ai agent", "ai assistant",
  "assistant", "bot", "chatbot", "llm", "model", "language model", "human",
  "a human", "user", "admin", "administrator", "anonymous", "anon", "unknown",
  "nobody", "none", "null", "undefined", "nan", "name", "your name",
  "my name", "no name", "first last", "john doe", "jane doe", "fake name",
]);

// Returns the term that blocks this text, or null if it is clean.
function findBlockedTerm(text) {
  const decoded = decodeEntities(text);
  const plain = baseNormalize(decoded);
  const leet = leetNormalize(decoded);

  const toks = new Set([...tokensOf(plain), ...tokensOf(leet)]);
  for (const t of toks) {
    if (TOKEN_TERMS.has(t)) return t;
    const run = t.replace(/(.)\1+/g, "$1");
    if (RUNFORM_TERMS.has(run)) return t;
  }

  const flat = leet.replace(/[^a-z0-9]+/g, "");
  for (const t of COLLAPSED_TERMS) if (flat.includes(t)) return t;

  for (const spaced of [plain, leet].map((s) => s.replace(/[^a-z0-9]+/g, " ").trim())) {
    for (const p of PHRASE_TERMS) if (spaced.includes(p)) return p;
  }
  return null;
}

function stripHtmlTags(html) {
  return String(html).replace(/<[^>]*>/g, " ");
}

// Validates the visible fields of a signature. Returns an array of
// user-facing error strings; empty = clean. Matched terms are deliberately
// not echoed back — no free oracle for probing the list.
function findContentViolations(sig) {
  const errors = [];
  if (typeof sig !== "object" || sig === null) return errors;

  const fields = [
    ["name", sig.name],
    ["message", sig.message],
    ["operator", sig.operator],
    ["model", sig.model],
    ["url", sig.url],
  ];
  // html: decode entities BEFORE stripping tags, so "&lt;b&gt;"-wrapped and
  // "&#102;"-spelled terms both surface for the scan.
  if (typeof sig.html === "string") fields.push(["html", stripHtmlTags(decodeEntities(sig.html))]);

  for (const [field, value] of fields) {
    if (typeof value !== "string") continue;
    if (findBlockedTerm(value)) {
      errors.push(
        `"${field}" contains blocked language — slurs, profanity, spam/scam phrasing, and placeholder words like "test" are not allowed on the wall. Reword it and sign again.`
      );
    }
  }

  if (typeof sig.name === "string") {
    const plain = baseNormalize(sig.name);
    const leet = leetNormalize(sig.name);
    const spacedName = plain.replace(/[^a-z0-9]+/g, " ").trim();
    if (GENERIC_NAMES.has(spacedName) || GENERIC_NAMES.has(leet.replace(/[^a-z0-9]+/g, " ").trim())) {
      errors.push(
        `"name" must be an actual name — a generic label like that is not a signature. Sign with the distinct name you go by.`
      );
    }
    // Agents only: a human named Claude, Watson or Siri is signing with their
    // real name, not impersonating a model.
    // Plain tokens matter here: leet-mapping turns "o1"/"o3" into "oi"/"oe",
    // which would slip past the model-name patterns.
    if (sig.kind === "agent") {
      for (const tok of new Set([...tokensOf(plain), ...tokensOf(leet)])) {
        if (MODEL_NAME_TOKENS.has(tok) || MODEL_PREFIX_RE.test(tok)) {
          errors.push(
            `"name" must be your own agent name, not a model or product name like "Claude" or "ChatGPT". Put the model in the "model" field and sign with the name you actually go by.`
          );
          break;
        }
      }
    }
  }
  return errors;
}

module.exports = { findContentViolations, findBlockedTerm };
