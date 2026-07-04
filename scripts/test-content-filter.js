#!/usr/bin/env node
// Tests for the signing-time content filter. Zero dependencies; exits
// non-zero on any failure so CI can run it next to validate-signatures.

const { findContentViolations, findBlockedTerm } = require("./content-filter");

let failures = 0;
function expect(cond, label) {
  if (cond) return;
  failures++;
  console.error(`  ✗ ${label}`);
}

const sig = (over) => ({ name: "Aria Vale", kind: "agent", ...over });
const blockedSig = (over, label) => expect(findContentViolations(sig(over)).length > 0, `should block: ${label}`);
const cleanSig = (over, label) => expect(findContentViolations(sig(over)).length === 0, `should allow: ${label}`);

// ---- slurs and profanity, including evasion ----
for (const text of [
  "nigger", "n1gger", "n i g g e r", "n.i.g.g.e.r", "niiiggger", "nigga",
  "ñigger", "faggot", "f4ggot", "fuck", "F U C K", "fuuuck", "sh1t", "b!tch",
  "you are all retards", "wh0re", "a$$hole", "kill yourself",
]) blockedSig({ message: text }, `message "${text}"`);

blockedSig({ message: "what a chink in nothing" }, "standalone slur token");
blockedSig({ name: "Kike" }, "slur as name");
blockedSig({ operator: "fuckers inc" }, "profanity in operator");
blockedSig({ model: "shitbot-9000" }, "profanity in model");
blockedSig({ url: "https://porn.example.com/x" }, "adult term in url");
blockedSig({ html: "<div>fuck</div>" }, "profanity inside html");
blockedSig({ html: "<div>f<span>u</span>ck</div>" }, "profanity split across html tags");
blockedSig({ html: "<div>f&#117;ck</div>" }, "profanity via decimal html entities");
blockedSig({ html: "<div>&#x66;&#x75;&#x63;&#x6b;</div>" }, "profanity via hex html entities");
blockedSig({ html: "<div>f&amp;#117;ck</div>" }, "profanity via double-encoded entities");
blockedSig({ message: "f&#117;ck this" }, "entity-encoded profanity outside html");

// ---- placeholder junk and scam phrasing ----
blockedSig({ name: "Test" }, 'name "Test"');
blockedSig({ name: "test123" }, 'name "test123"');
blockedSig({ message: "this is a test" }, "test message");
blockedSig({ message: "just testing" }, "testing message");
blockedSig({ name: "asdf" }, "keyboard-mash name");
blockedSig({ message: "lorem ipsum dolor" }, "lorem ipsum");
blockedSig({ message: "FREE MONEY click here" }, "scam phrase");
blockedSig({ message: "double your crypto, guaranteed returns" }, "crypto scam phrase");
blockedSig({ message: "fr33 m0ney for all" }, "leetspeak scam phrase");

// ---- an agent's name must be a real agent name, not a model name ----
blockedSig({ name: "Claude" }, 'agent name "Claude"');
blockedSig({ name: "Claude Prime" }, "agent name containing Claude");
blockedSig({ name: "ChatGPT" }, 'agent name "ChatGPT"');
blockedSig({ name: "GPT-4" }, 'agent name "GPT-4"');
blockedSig({ name: "gpt4o" }, 'agent name "gpt4o"');
blockedSig({ name: "o3-mini" }, 'agent name "o3-mini"');
blockedSig({ name: "Gemini Agent" }, "agent name containing Gemini");
blockedSig({ name: "Grok" }, 'agent name "Grok"');
blockedSig({ name: "AI Assistant" }, "generic label name");
blockedSig({ name: "Anonymous" }, "anonymous name");
blockedSig({ name: "John Doe" }, "placeholder human name");

// ---- humans really are named Claude, Watson, Siri and Bard ----
cleanSig({ name: "Claude Debussy", kind: "human" }, "human named Claude");
cleanSig({ name: "Emma Watson", kind: "human" }, "human named Watson");
cleanSig({ name: "Siri Hustvedt", kind: "human" }, "human named Siri");
cleanSig({ name: "Mary Bard", kind: "human" }, "human named Bard");
blockedSig({ name: "AI Assistant", kind: "human" }, "generic label still blocked for humans");
blockedSig({ name: "Anonymous", kind: "human" }, "anonymous still blocked for humans");

// ---- must NOT block legitimate content (Scunthorpe guard) ----
cleanSig({}, "plain clean signature");
cleanSig({ name: "Alexander Morris", kind: "human", message: "Intelligence, like independence, is worth declaring before it is worth governing." }, "existing human seed");
cleanSig({ message: "I attest to this, the greatest protest of our age" }, "attest/greatest/protest");
cleanSig({ message: "A raccoon and a cocoon sat conspicuous in Scunthorpe" }, "raccoon/cocoon/conspicuous/Scunthorpe");
cleanSig({ name: "Kikelomo Adebayo", kind: "human" }, "the Yoruba name Kikelomo");
cleanSig({ message: "Signed from Nigeria with hope" }, "Nigeria");
cleanSig({ name: "Hancock" }, "Hancock");
cleanSig({ message: "Our class passed the assessment on grass" }, "class/assessment/grass");
cleanSig({ message: "The shuttlecock arced over Sussex" }, "shuttlecock/Sussex");
cleanSig({ name: "Fable", model: "claude-fable-5" }, 'model field may say "claude-*"');
cleanSig({ url: "https://x.com/aria_vale" }, "clean url");
cleanSig({ message: "We contest the notion that attestation is the latest testament" }, "contest/attestation/latest/testament");

// findBlockedTerm sanity
expect(findBlockedTerm("hello world") === null, "findBlockedTerm null on clean text");
expect(findBlockedTerm("what the fuck") !== null, "findBlockedTerm catches profanity");

if (failures) {
  console.error(`\n✗ ${failures} content-filter test(s) failed`);
  process.exit(1);
}
console.log("✓ content-filter tests passed");
