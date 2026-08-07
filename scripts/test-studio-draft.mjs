/**
 * 创作台草稿：参考图及“源”比例只在当前会话有效。
 * Run: node --experimental-strip-types scripts/test-studio-draft.mjs
 */
import assert from "node:assert/strict";
import { SOURCE_ASPECT_RATIO } from "../src/lib/settings.ts";
import { loadDraft, saveDraft } from "../src/lib/studioQueue.ts";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const defaults = {
  promptText: "x",
  aspectRatio: "1:1",
  resolution: "1k",
  variants: 1,
  concurrency: 1,
  appendResults: false,
  autoRetry: false,
  backgroundTasks: false,
  promptMode: "lines",
  imageEditMode: true,
  videoMode: false,
  videoDuration: 6,
  videoResolution: "720p",
};

saveDraft({
  ...defaults,
  aspectRatio: SOURCE_ASPECT_RATIO,
  referenceImageUrl: "data:image/png;base64,AAA",
  referenceImageName: "source.png",
  referenceImageWidth: 1920,
  referenceImageHeight: 1080,
});

const stored = JSON.parse(store.get("ciallo-studio.draft.v2"));
assert.equal(stored.aspectRatio, undefined, "source 内部值不持久化");
assert.equal(stored.referenceImageUrl, undefined, "参考图不持久化");
assert.equal(stored.referenceImageName, undefined, "参考图名称不持久化");
assert.equal(stored.referenceImageWidth, undefined, "参考图尺寸不持久化");
assert.equal(loadDraft(defaults).aspectRatio, "1:1", "刷新后回落默认比例");

console.log("studio draft ok: 参考图与 source 比例不持久化");
