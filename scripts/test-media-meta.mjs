/**
 * 实际产物参数标签：宽高比 / 分辨率 / 时长 / 分辨率档位一致性。
 * Run: node --experimental-strip-types scripts/test-media-meta.mjs
 */
import assert from "node:assert/strict";
import {
  formatAspectRatio,
  formatResolution,
  resolutionTier,
  videoTier,
  formatDuration,
  describeMediaMeta,
  resolutionMismatch,
} from "../src/lib/mediaMeta.ts";

// ——— 宽高比吸附 ———

assert.strictEqual(formatAspectRatio(1024, 1024), "1:1", "1024×1024 → 1:1");
assert.strictEqual(formatAspectRatio(1023, 1024), "1:1", "±1px 吸附 1023×1024");
assert.strictEqual(formatAspectRatio(1920, 1080), "16:9", "1920×1080 → 16:9");
assert.strictEqual(formatAspectRatio(1080, 1920), "9:16", "1080×1920 → 9:16");
assert.strictEqual(formatAspectRatio(1200, 900), "4:3", "1200×900 → 4:3");
assert.strictEqual(formatAspectRatio(900, 1200), "3:4", "900×1200 → 3:4");
assert.strictEqual(formatAspectRatio(2400, 1600), "3:2", "2400×1600 → 3:2");
assert.strictEqual(formatAspectRatio(1600, 2400), "2:3", "1600×2400 → 2:3");
// 1792×1024 / 1024×1792 是 SDXL 系常见宽屏尺寸，距精确 16:9 差 1.56%，按 16:9 显示
assert.strictEqual(formatAspectRatio(1792, 1024), "16:9", "1792×1024 → 16:9");
assert.strictEqual(formatAspectRatio(1024, 1792), "9:16", "1024×1792 → 9:16");
assert.strictEqual(formatAspectRatio(1073, 1920), "9:16", "1073×1920 ≈ 9:16");
// 超出容差就老实给最简整数比，不硬凑
assert.strictEqual(formatAspectRatio(1000, 1600), "5:8", "1000×1600 差 11%，不吸附 9:16");

// ——— 像素尺寸 ———
assert.strictEqual(formatResolution(2048, 1024), "2048×1024");
assert.strictEqual(formatResolution(0, 100), undefined, "width=0 不合法");
assert.strictEqual(formatResolution(NaN, 100), undefined, "width=NaN 不合法");

// ——— 分辨率档位 ———
assert.strictEqual(resolutionTier(1024, 1024), "1k");
assert.strictEqual(resolutionTier(2048, 2048), "2k");
assert.strictEqual(resolutionTier(1920, 1080), "2k", "1920 最长边 → 2k");
assert.strictEqual(resolutionTier(512, 1024), "1k");

// ——— 视频档位 ———
assert.strictEqual(videoTier(640, 480), "480p");
assert.strictEqual(videoTier(1280, 720), "720p");
assert.strictEqual(videoTier(1920, 1080), "1080p");

// ——— 时长 ———
assert.strictEqual(formatDuration(6), "6s");
assert.strictEqual(formatDuration(7.3), "7s");
assert.strictEqual(formatDuration(0), undefined, "≤0 不算有效时长");
assert.strictEqual(formatDuration(undefined), undefined);
assert.strictEqual(formatDuration(65), "1:05");
assert.strictEqual(formatDuration(125), "2:05");

// ——— 标签组 ———
const imgMeta = { width: 1792, height: 1024 };
assert.deepStrictEqual(describeMediaMeta(imgMeta, false), ["16:9", "1792×1024 · 2k"]);
assert.deepStrictEqual(describeMediaMeta(undefined, false), []);

const videoMeta = { width: 1280, height: 720, duration: 10.2 };
assert.deepStrictEqual(describeMediaMeta(videoMeta, true), ["16:9", "1280×720 · 720p", "10s"]);

// ——— 请求档位 vs 实际档位 ———
assert.strictEqual(resolutionMismatch("2k", { width: 1024, height: 1024 }), true);
assert.strictEqual(resolutionMismatch("2k", { width: 2048, height: 2048 }), false);
assert.strictEqual(resolutionMismatch("720p", videoMeta), false, "视频档位暂不参与图片 1k/2k 告警");
assert.strictEqual(resolutionMismatch(undefined, imgMeta), false);

console.log("PASS: mediaMeta — 宽高比 / 分辨率 / 时长 / 档位");
