/**
 * 大厅帖子媒体元数据归一化。
 * Run: node --experimental-strip-types --no-warnings scripts/test-post-meta.mjs
 */
import assert from "node:assert/strict";
import { normalizeVideoDuration } from "../src/lib/community/types.ts";

assert.strictEqual(normalizeVideoDuration("video", 10.2), 10.2, "视频保留实际时长");
assert.strictEqual(normalizeVideoDuration("video", "15"), 15, "数字字符串可归一化");
assert.strictEqual(normalizeVideoDuration("image", 10), undefined, "图片不保存视频时长");
assert.strictEqual(normalizeVideoDuration("video", 0), undefined, "零时长无效");
assert.strictEqual(normalizeVideoDuration("video", "bad"), undefined, "非法时长无效");

console.log("PASS: post video duration normalization (5 cases)");
