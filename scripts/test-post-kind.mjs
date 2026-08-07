/**
 * 大厅帖子类型归一化。
 * 与 src/lib/community/types.ts 的 normalizePostKind / isVideoPost 保持同步。
 */

function normalizePostKind(value) {
  return value === "video" ? "video" : "image";
}

function isVideoPost(post) {
  return normalizePostKind(post?.kind) === "video";
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// —— normalizePostKind 防御兜底 ——
assert(normalizePostKind("video") === "video", "video → video");
assert(normalizePostKind("image") === "image", "image → image");
assert(normalizePostKind(undefined) === "image", "undefined falls back");
assert(normalizePostKind(null) === "image", "null falls back");
assert(normalizePostKind("") === "image", "empty string falls back");
assert(normalizePostKind("VIDEO") === "image", "大小写不匹配 falls back");
assert(normalizePostKind({}) === "image", "object falls back");
assert(normalizePostKind(123) === "image", "number falls back");

// —— isVideoPost 布尔决策 ——
assert(isVideoPost({ kind: "video" }) === true, "{ kind: video }");
assert(isVideoPost({ kind: "image" }) === false, "{ kind: image }");
assert(isVideoPost({}) === false, "missing kind defaults false");
assert(isVideoPost(null) === false, "null post");
assert(isVideoPost(undefined) === false, "undefined post");

console.log("PASS: post kind normalization (13 cases)");
