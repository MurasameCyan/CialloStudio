/**
 * Mirrors shortSha / hasUpdate logic from src/lib/buildInfo.ts for pure-node unit tests.
 */
import assert from "node:assert/strict";

const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

function shortSha(raw) {
  const text = (raw || "").trim().split(/\s+/)[0] || "";
  if (!text) return "";
  if (["unknown", "null", "none", "n/a"].includes(text.toLowerCase())) return "";
  if (SHA_RE.test(text)) return text.slice(0, 7).toLowerCase();
  return text.slice(0, 32);
}

function hasUpdate(current, latest) {
  const localNorm = shortSha(current);
  const remoteNorm = shortSha(latest || "");
  const bothHash = Boolean(SHA_RE.test(localNorm) && SHA_RE.test(remoteNorm));
  if (bothHash) return localNorm.toLowerCase() !== remoteNorm.toLowerCase();
  return Boolean(remoteNorm && remoteNorm !== current);
}

assert.equal(shortSha("e81427cabcdef"), "e81427c");
assert.equal(shortSha("E81427C"), "e81427c");
assert.equal(shortSha("unknown"), "");
assert.equal(shortSha(""), "");
assert.equal(shortSha("  abcdef0  "), "abcdef0");

assert.equal(hasUpdate("e81427c", "e81427c"), false);
assert.equal(hasUpdate("e81427c", "e81427cdeadbeef"), false);
assert.equal(hasUpdate("e81427c", "abcdef0"), true);
assert.equal(hasUpdate("unknown", "abcdef0"), true);

console.log("buildInfo ok");
