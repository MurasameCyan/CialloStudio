/**
 * 提示词模板库：归一化、勾选、拼接、随机。
 * Run: node --experimental-strip-types --no-warnings scripts/test-prompt-templates.mjs
 */
import assert from "node:assert/strict";
import {
  buildTemplatePrompt,
  countTemplateItems,
  loadTemplateLibrary,
  normalizeTemplateLibrary,
  randomTemplateSelection,
  saveTemplateLibrary,
  toggleTemplateSelection,
} from "../src/lib/promptTemplates.ts";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

// --- 归一化：容错与限幅 ---
assert.deepEqual(normalizeTemplateLibrary(null), { categories: [] }, "null → 空库");
assert.deepEqual(normalizeTemplateLibrary("nope"), { categories: [] }, "字符串 → 空库");
assert.deepEqual(
  normalizeTemplateLibrary({ categories: [{ name: "空", items: [] }] }),
  { categories: [] },
  "无有效条目的分类应被丢弃",
);

// 兼容 core 字段与字符串条目（本地词库 HTML 的原始形状）
const compat = normalizeTemplateLibrary([
  { name: "姿势", items: [{ name: "后入", core: "塌腰翘臀" }] },
  { name: "氛围", multi: true, items: ["暖光", { text: "薄汗" }] },
]);
assert.equal(compat.categories.length, 2);
assert.equal(compat.categories[0].items[0].text, "塌腰翘臀", "core 应作为内容");
assert.equal(compat.categories[0].multi, false, "multi 缺省为单选");
assert.equal(compat.categories[1].multi, true);
assert.equal(compat.categories[1].items[0].name, "暖光", "字符串条目自身既是名也是内容");
assert.equal(compat.categories[1].items[1].name, "薄汗", "缺 name 时回落到 text");

// 同名 id 必须去重，否则勾选会串到另一条
const dup = normalizeTemplateLibrary([
  { id: "c", name: "A", items: [{ id: "x", text: "a" }, { id: "x", text: "b" }] },
  { id: "c", name: "B", items: [{ text: "c" }] },
]);
assert.deepEqual(dup.categories.map((c) => c.id), ["c", "c-2"], "分类 id 去重");
assert.deepEqual(dup.categories[0].items.map((i) => i.id), ["x", "x-2"], "条目 id 去重");

// 限幅：文本 2000 / 名称 40 / 条目 500
const huge = normalizeTemplateLibrary([
  {
    name: "n".repeat(80),
    items: Array.from({ length: 600 }, (_, i) => ({ text: `t${i}`.padEnd(3000, "x") })),
  },
]);
assert.equal(huge.categories[0].name.length, 40, "名称截断到 40");
assert.equal(huge.categories[0].items.length, 500, "条目截断到 500");
assert.equal(huge.categories[0].items[0].text.length, 2000, "内容截断到 2000");

// --- 存取往返 ---
const lib = normalizeTemplateLibrary([
  { id: "pose", name: "姿势", items: [{ id: "a", text: "塌腰" }, { id: "b", text: "跪坐" }] },
  {
    id: "mood",
    name: "氛围",
    multi: true,
    items: [{ id: "m1", text: "暖光" }, { id: "m2", text: "薄汗" }],
  },
]);
saveTemplateLibrary(lib);
assert.deepEqual(loadTemplateLibrary(), lib, "存取往返应一致");
assert.equal(countTemplateItems(lib), 4);

store.set("ciallo-studio.prompt-templates.v1", "{ broken");
assert.deepEqual(loadTemplateLibrary(), { categories: [] }, "坏 JSON 不应抛错");

// --- 勾选：单选互斥、多选累加 ---
const [pose, mood] = lib.categories;
let sel = toggleTemplateSelection({}, pose, "a");
assert.deepEqual(sel, { pose: ["a"] });
sel = toggleTemplateSelection(sel, pose, "b");
assert.deepEqual(sel, { pose: ["b"] }, "单选分类应替换而非累加");
sel = toggleTemplateSelection(sel, mood, "m1");
sel = toggleTemplateSelection(sel, mood, "m2");
assert.deepEqual(sel.mood, ["m1", "m2"], "多选分类应累加");
sel = toggleTemplateSelection(sel, mood, "m1");
assert.deepEqual(sel.mood, ["m2"], "再点应取消");
const cleared = toggleTemplateSelection(toggleTemplateSelection(sel, mood, "m2"), pose, "b");
assert.deepEqual(cleared, {}, "全部取消后不应留空数组");

// --- 拼接：按库顺序、去重 ---
assert.equal(
  buildTemplatePrompt(lib, { mood: ["m2", "m1"], pose: ["a"] }),
  "塌腰, 暖光, 薄汗",
  "顺序应跟随库定义，与勾选先后无关",
);
assert.equal(buildTemplatePrompt(lib, {}), "", "无勾选 → 空串");
assert.equal(buildTemplatePrompt(lib, { pose: ["ghost"] }), "", "不存在的 id 应被忽略");

const dupText = normalizeTemplateLibrary([
  { id: "x", name: "X", multi: true, items: [{ id: "1", text: "同" }, { id: "2", text: "同" }] },
]);
assert.equal(buildTemplatePrompt(dupText, { x: ["1", "2"] }), "同", "相同内容应去重");

// --- 随机：不越界、不重复、单选恰好 1 条 ---
for (const value of [0, 0.5, 0.999, 1]) {
  const picked = randomTemplateSelection(lib, () => value);
  assert.equal(picked.pose.length, 1, `rand=${value} 单选应恰好 1 条`);
  assert.ok(picked.mood.length >= 1 && picked.mood.length <= 2, `rand=${value} 多选应 1-2 条`);
  for (const [catId, ids] of Object.entries(picked)) {
    const known = lib.categories.find((c) => c.id === catId).items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `rand=${value} 同一条目不应重复抽到`);
    for (const id of ids) assert.ok(known.includes(id), `rand=${value} 抽到了不存在的 id: ${id}`);
  }
  // 越界索引会产出 undefined，拼接结果必然含 "undefined" 或抛错
  assert.doesNotThrow(() => buildTemplatePrompt(lib, picked));
}
assert.deepEqual(randomTemplateSelection({ categories: [] }), {}, "空库随机 → 空勾选");

console.log("prompt templates ok");
