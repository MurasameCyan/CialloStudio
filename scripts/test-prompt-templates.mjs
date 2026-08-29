/**
 * 提示词模板库：归一化、勾选、拼接、随机。
 * Run: node --experimental-strip-types --no-warnings scripts/test-prompt-templates.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildTemplatePrompt,
  countTemplateItems,
  fetchDefaultTemplateLibrary,
  hasTriedDefaultLibrary,
  loadTemplateLibrary,
  markTriedDefaultLibrary,
  normalizeTemplateLibrary,
  randomTemplateSelection,
  saveTemplateLibrary,
  toggleTemplateSelection,
} from "../src/lib/promptTemplates.ts";
import {
  DEFAULT_PROMPT_TEMPLATES_URL,
  getPromptTemplatesSource,
} from "../src/lib/runtimeConfig.ts";

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

// 限幅：文本 2000 / 名称 40 / 单类 1000
const huge = normalizeTemplateLibrary([
  {
    name: "n".repeat(80),
    items: Array.from({ length: 1200 }, (_, i) => ({ text: `t${i}`.padEnd(3000, "x") })),
  },
]);
assert.equal(huge.categories[0].name.length, 40, "名称截断到 40");
assert.equal(huge.categories[0].items.length, 1000, "条目截断到 1000");
assert.equal(huge.categories[0].items[0].text.length, 2000, "内容截断到 2000");

// 整本词库（法典 + 魔导书）是 200+ 分类 / 12000+ 条，必须能整本进来不被截。
// 这两条钉住的是「装得下真实词库」这个承诺，收紧上限会立刻在这里失败。
const realistic = normalizeTemplateLibrary(
  Array.from({ length: 291 }, (_, c) => ({
    id: `c${c}`,
    name: `分类${c}`,
    items: Array.from({ length: 42 }, (_, i) => ({ text: `c${c}i${i}` })),
  })),
);
assert.equal(realistic.categories.length, 291, "291 个分类应全部保留");
assert.equal(countTemplateItems(realistic), 291 * 42, "12000+ 条应全部保留");

// 总量护栏：单类上限 × 分类数会放得太宽，靠总量兜住 localStorage
const overBudget = normalizeTemplateLibrary(
  Array.from({ length: 40 }, (_, c) => ({
    id: `b${c}`,
    name: `超${c}`,
    items: Array.from({ length: 1000 }, (_, i) => ({ text: `b${c}i${i}` })),
  })),
);
assert.equal(countTemplateItems(overBudget), 20000, "总量应停在 20000");
assert.ok(
  overBudget.categories.length < 40,
  "撞上总量上限后应停止收录后续分类，而不是继续塞",
);
// 截断只发生在尾部，前面的分类必须完整
assert.equal(overBudget.categories[0].items.length, 1000, "首个分类不受总量截断影响");

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

// --- 默认词库拉取：definitive=别再重试，transient=下次可再试 ---
const GOOD = JSON.stringify([{ name: "姿势", items: [{ name: "后入", core: "塌腰翘臀" }] }]);

function reply(body, { status = 200, type = "application/json", length } = {}) {
  const headers = new Headers();
  if (type) headers.set("content-type", type);
  if (length !== undefined) headers.set("content-length", String(length));
  return async () => new Response(body, { status, headers });
}

const okRes = await fetchDefaultTemplateLibrary("/x.json", reply(GOOD));
assert.equal(okRes.ok, true, "合法 JSON 应成功");
assert.equal(okRes.library.categories[0].items[0].text, "塌腰翘臀", "应经过 normalize");

// 空地址不该发请求
const noUrl = await fetchDefaultTemplateLibrary("   ", () => {
  throw new Error("不该发起请求");
});
assert.equal(noUrl.ok, false);
assert.equal(noUrl.definitive, true, "未配置地址 → 终态");

// nginx 的 try_files 会把写错的相对路径回落成 index.html 且带 200，
// 只看 status 会把整个 HTML 当词库解析，必须靠 content-type 识破
const html = await fetchDefaultTemplateLibrary("/nope.json", reply("<!doctype html>", { type: "text/html" }));
assert.equal(html.ok, false);
assert.equal(html.definitive, true, "HTML 回落 → 终态");
assert.match(html.error, /不是 JSON/);

// text/plain 要放行：有些静态服务对 .json 就是这个类型
assert.equal(
  (await fetchDefaultTemplateLibrary("/x.json", reply(GOOD, { type: "text/plain" }))).ok,
  true,
  "text/plain 应放行",
);
assert.equal(
  (await fetchDefaultTemplateLibrary("/x.json", reply(GOOD, { type: "" }))).ok,
  true,
  "无 content-type 应放行",
);

// 4xx 是地址写错，5xx 可能是临时故障
const notFound = await fetchDefaultTemplateLibrary("/x.json", reply("", { status: 404 }));
assert.equal(notFound.definitive, true, "404 → 终态");
const boom = await fetchDefaultTemplateLibrary("/x.json", reply("", { status: 503 }));
assert.equal(boom.definitive, false, "503 → 可重试");

// 网络/超时/CORS：留给下次打开重试
const offline = await fetchDefaultTemplateLibrary("/x.json", async () => {
  throw new TypeError("Failed to fetch");
});
assert.equal(offline.ok, false);
assert.equal(offline.definitive, false, "网络错误 → 可重试");
assert.match(offline.error, /Failed to fetch/);

// 限幅：声明的 content-length 超限就不读 body
// 上限是 4 MB（要装得下法典 + 魔导书整本 ~2.1 MB），所以用 5 MB 来触发
const tooBig = await fetchDefaultTemplateLibrary("/x.json", reply(GOOD, { length: 5 * 1024 * 1024 }));
assert.equal(tooBig.ok, false);
assert.equal(tooBig.definitive, true, "超限 → 终态");
// 整本词库（~2.1 MB）必须放得过去，否则默认词库根本载入不了
const wholeCodex = await fetchDefaultTemplateLibrary(
  "/x.json",
  reply(GOOD, { length: 2.1 * 1024 * 1024 }),
);
assert.equal(wholeCodex.ok, true, "2.1 MB 的整本词库不该被限幅拦掉");
// 没有 content-length（分块响应）时也要拦住
const tooBigChunked = await fetchDefaultTemplateLibrary(
  "/x.json",
  reply("x".repeat(5 * 1024 * 1024)),
);
assert.equal(tooBigChunked.ok, false, "无 content-length 的超大响应也要拦");
assert.match(tooBigChunked.error, /4 MB/, "提示语应跟着上限走");

const badJson = await fetchDefaultTemplateLibrary("/x.json", reply("{ broken"));
assert.equal(badJson.definitive, true, "坏 JSON → 终态");
const emptyLib = await fetchDefaultTemplateLibrary("/x.json", reply("[]"));
assert.equal(emptyLib.ok, false);
assert.equal(emptyLib.definitive, true, "解析不出条目 → 终态");

// 拉取本身不写 localStorage，落盘由调用方决定
store.clear();
await fetchDefaultTemplateLibrary("/x.json", reply(GOOD));
assert.equal(store.size, 0, "fetch 不应自行落盘");

// --- 已尝试标记：跨刷新记住，避免清空后又被灌回来 ---
assert.equal(hasTriedDefaultLibrary(), false, "初始未尝试");
markTriedDefaultLibrary();
assert.equal(hasTriedDefaultLibrary(), true, "标记后应为已尝试");

// --- 词库来源：约定路径兜底 vs 站长显式覆盖 ---
// 这个路径是对站长的部署承诺（挂到这里即生效，见 README / docker-compose），
// 改了就得同步文档，所以钉住字面值而不是拿常量自比。
assert.equal(DEFAULT_PROMPT_TEMPLATES_URL, "/prompt-templates.json", "约定路径不可随意改名");
// explicit 决定拉不到时的态度：显式配了就报错（配错要让站长知道），
// 走约定路径则静默（这站点本来就可以不提供词库）。
globalThis.window = {};
assert.deepEqual(
  getPromptTemplatesSource(),
  { url: DEFAULT_PROMPT_TEMPLATES_URL, explicit: false },
  "未注入 runtime → 约定路径且非显式",
);

globalThis.window.__CIALLO_RUNTIME__ = {};
assert.equal(getPromptTemplatesSource().explicit, false, "runtime 无该字段 → 非显式");
globalThis.window.__CIALLO_RUNTIME__ = { promptTemplatesUrl: "" };
assert.equal(getPromptTemplatesSource().explicit, false, "空串 → 非显式");
// entrypoint 注入的值可能带空白，trim 后仍是空就不算配置
globalThis.window.__CIALLO_RUNTIME__ = { promptTemplatesUrl: "   " };
assert.deepEqual(
  getPromptTemplatesSource(),
  { url: DEFAULT_PROMPT_TEMPLATES_URL, explicit: false },
  "纯空白 → 视作未配置",
);
globalThis.window.__CIALLO_RUNTIME__ = { promptTemplatesUrl: 42 };
assert.equal(getPromptTemplatesSource().explicit, false, "非字符串 → 非显式");

globalThis.window.__CIALLO_RUNTIME__ = { promptTemplatesUrl: "https://cdn.example/lib.json" };
assert.deepEqual(
  getPromptTemplatesSource(),
  { url: "https://cdn.example/lib.json", explicit: true },
  "配了地址 → 显式覆盖",
);
// 显式配成与约定路径同值也算显式：站长写了就该收到错误提示
globalThis.window.__CIALLO_RUNTIME__ = { promptTemplatesUrl: DEFAULT_PROMPT_TEMPLATES_URL };
assert.equal(getPromptTemplatesSource().explicit, true, "显式配约定路径仍算显式");
delete globalThis.window;

// --- 顺序护栏：词库有 MB 级，落盘可能被配额拒掉 ---
// 必须「先落盘、成功了才打标记」。反过来的话：写不下 → 本地空库 + 标记拦住
// 自动拉取 → 用户下次打开只剩空词库。运行时难覆盖，用静态断言钉住调用顺序。
const dialogSrc = readFileSync(
  fileURLToPath(new URL("../src/components/PromptTemplateDialog.tsx", import.meta.url)),
  "utf8",
);
const persistAt = dialogSrc.indexOf("const persisted = saveTemplateLibrary(res.library)");
const markAt = dialogSrc.indexOf("if (persisted) markTriedDefaultLibrary()");
assert.ok(persistAt > 0, "默认词库落盘应接收 saveTemplateLibrary 的返回值");
assert.ok(markAt > 0, "已尝试标记必须以落盘成功为前提");
assert.ok(markAt > persistAt, "必须先落盘再打标记，否则写不下时会留下空词库");

console.log("prompt templates ok");
