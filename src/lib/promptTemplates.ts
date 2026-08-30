/**
 * 创作台提示词模板库。
 *
 * 默认词库不随公开镜像发布；站长可挂载 /prompt-templates.json，
 * 或用 CIALLO_PROMPT_TEMPLATES_URL 指到受控地址。用户首次打开且本地为空时自动
 * 拉取一次；之后词库存在 localStorage，可 JSON 导入导出并由用户自己维护
 * （见 scripts/convert-prompt-library.mjs，可把本地词库 HTML 转成导入用 JSON）。
 * 这里只管存储与组装，UI 只负责勾选。
 */

const STORAGE_KEY = "ciallo-studio.prompt-templates.v1";
/** 记录「已尝试过自动拉取默认词库」，避免用户主动清空后又被灌回来 */
const FETCHED_KEY = "ciallo-studio.prompt-templates.fetched.v1";
const SEPARATOR = ", ";

/**
 * 导入是信任边界：用户粘贴的 JSON 要限幅，否则一次大 paste 就撑爆 localStorage 配额。
 * 上限按「整本词库」而不是「凭感觉的小数字」定：法典 + 魔导书这类完整词库是
 * 200+ 分类 / 12000+ 条，旧的 40/500 会把大半内容静默截掉。
 * 真正的护栏是 MAX_TOTAL_ITEMS（总量）和 saveTemplateLibrary 的配额兜底。
 */
const MAX_CATEGORIES = 400;
const MAX_ITEMS = 1000;
/** 总条目上限：分类数 × 单类上限会放得太宽，用总量兜住 localStorage */
const MAX_TOTAL_ITEMS = 20000;
const MAX_TEXT_LEN = 2000;
const MAX_NAME_LEN = 40;
const MAX_ID_LEN = 128;

export type TemplateItem = { id: string; name: string; text: string };

export type TemplateCategory = {
  id: string;
  name: string;
  /** true=可多选（细节、氛围这类可叠加项）；false=单选（姿势、服装这类互斥项） */
  multi: boolean;
  items: TemplateItem[];
};

export type TemplateLibrary = { categories: TemplateCategory[] };

/** 勾选状态：分类 id -> 条目 id[] */
export type TemplateSelection = Record<string, string[]>;

export const EMPTY_TEMPLATE_LIBRARY: TemplateLibrary = { categories: [] };

/** 普通对象上的原型属性不能直接作为词库 id，否则会污染选择状态。 */
const UNSAFE_RECORD_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function uniqueId(base: string, seen: Set<string>, maxLength = Infinity): string {
  let id = base;
  let n = 2;
  while (seen.has(id)) {
    const suffix = `-${n}`;
    id = maxLength === Infinity ? `${base}${suffix}` : `${base.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
    n += 1;
  }
  seen.add(id);
  return id;
}

function safeRecordId(raw: unknown, fallback: string, seen: Set<string>): string {
  let base = cut(str(raw), MAX_ID_LEN) || fallback;
  if (UNSAFE_RECORD_KEYS.has(base)) base = `id-${base}`;
  return uniqueId(base, seen, MAX_ID_LEN);
}

function readSelectionIds(selection: TemplateSelection, key: string): string[] {
  const value = Object.prototype.hasOwnProperty.call(selection, key) ? selection[key] : undefined;
  return Array.isArray(value) ? value : [];
}

function writeSelectionIds(selection: TemplateSelection, key: string, ids: string[]): void {
  Object.defineProperty(selection, key, {
    configurable: true,
    enumerable: true,
    value: ids,
    writable: true,
  });
}

/**
 * 把任意来源的 JSON 收敛成合法词库。
 * 兼容两种简写：条目直接写字符串、内容字段叫 core（本地词库 HTML 的原始形状）。
 */
export function normalizeTemplateLibrary(raw: unknown): TemplateLibrary {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { categories?: unknown }).categories
      : raw;
  if (!Array.isArray(source)) return EMPTY_TEMPLATE_LIBRARY;

  const categories: TemplateCategory[] = [];
  const catIds = new Set<string>();
  /** 总量护栏：撞上后停止收录，避免超大词库把 localStorage 顶爆 */
  let budget = MAX_TOTAL_ITEMS;

  source.slice(0, MAX_CATEGORIES).forEach((rawCat, catIndex) => {
    if (!rawCat || typeof rawCat !== "object") return;
    if (budget <= 0) return;
    const cat = rawCat as Record<string, unknown>;
    const rawItems = Array.isArray(cat.items) ? cat.items : [];

    const items: TemplateItem[] = [];
    const itemIds = new Set<string>();
    rawItems.slice(0, Math.min(MAX_ITEMS, budget)).forEach((entry, itemIndex) => {
      const rec: Record<string, unknown> =
        typeof entry === "string"
          ? { name: entry, text: entry }
          : entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)
            : {};
      const text = cut(str(rec.text) || str(rec.core), MAX_TEXT_LEN);
      if (!text) return;
      items.push({
        id: safeRecordId(rec.id, `i${itemIndex}`, itemIds),
        name: cut(str(rec.name) || text, MAX_NAME_LEN),
        text,
      });
    });
    if (!items.length) return;
    budget -= items.length;

    categories.push({
      id: safeRecordId(cat.id, `c${catIndex}`, catIds),
      name: cut(str(cat.name) || `分类 ${catIndex + 1}`, MAX_NAME_LEN),
      multi: cat.multi === true,
      items,
    });
  });

  return { categories };
}

export function loadTemplateLibrary(): TemplateLibrary {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_TEMPLATE_LIBRARY;
    return normalizeTemplateLibrary(JSON.parse(raw));
  } catch {
    return EMPTY_TEMPLATE_LIBRARY;
  }
}

/**
 * 落盘词库。返回 false 表示配额写不下——调用方要把这事告诉用户，
 * 否则下次打开又是空库，而用户以为已经导入成功了。
 */
export function saveTemplateLibrary(library: TemplateLibrary): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
    return true;
  } catch {
    return false;
  }
}

export function countTemplateItems(library: TemplateLibrary): number {
  return library.categories.reduce((sum, cat) => sum + cat.items.length, 0);
}

/** 默认响应只有在请求仍属当前代际且自动路径下词库仍为空时才能应用。 */
export function canApplyDefaultTemplate(
  manual: boolean,
  requestToken: number,
  currentToken: number,
  currentLibrary: TemplateLibrary,
): boolean {
  return requestToken === currentToken && (manual || currentLibrary.categories.length === 0);
}

export type TemplateCategoryLeaf = {
  category: TemplateCategory;
  /** 导航里显示的短名称，不重复来源/主题前缀 */
  label: string;
  /** 右侧标题与移动端选单使用的完整路径 */
  path: string[];
};

export type TemplateCategorySubgroup = {
  key: string;
  label: string;
  categories: TemplateCategoryLeaf[];
};

export type TemplateCategorySourceGroup = {
  key: "base" | "codex" | "grimoire" | "loli" | "other";
  label: string;
  categories: TemplateCategoryLeaf[];
  subgroups: TemplateCategorySubgroup[];
};

const BASE_CATEGORY_IDS = new Set([
  "poses",
  "clothings",
  "motions",
  "cameras",
  "expressions",
  "characters",
  "bodyHot",
  "tightHot",
  "atmosphere",
  "erotic",
]);

const TEMPLATE_SOURCE_GROUPS: Array<Pick<TemplateCategorySourceGroup, "key" | "label">> = [
  { key: "base", label: "基础" },
  { key: "codex", label: "法典" },
  { key: "grimoire", label: "魔导书" },
  { key: "loli", label: "Loli画风" },
  { key: "other", label: "其他" },
];

function baseCategoryId(id: string, knownIds: ReadonlySet<string>): string {
  let base = id;
  while (/-\d+$/.test(base)) {
    const suffix = Number(base.match(/-(\d+)$/)?.[1] ?? NaN);
    // uniqueId 只会从 -2 递增；更大的数字通常是用户自己的业务后缀。
    if (!Number.isInteger(suffix) || suffix < 2 || suffix > MAX_CATEGORIES) break;
    const candidate = base.replace(/-\d+$/, "");
    if (!knownIds.has(candidate)) break;
    base = candidate;
  }
  return base;
}

function hasSourcePrefix(name: string, source: "法典" | "魔导书" | "L画风" | "Loli画风"): boolean {
  return name === source || name.startsWith(`${source}·`);
}

function templateSourceKey(
  category: TemplateCategory,
  knownIds: ReadonlySet<string>,
): TemplateCategorySourceGroup["key"] {
  const baseId = baseCategoryId(category.id, knownIds);
  const canonicalId = baseId === category.id || knownIds.has(baseId);
  const name = category.name.trim();
  if (BASE_CATEGORY_IDS.has(baseId) && canonicalId) return "base";
  if (/^dx\d+$/.test(baseId) && (canonicalId || hasSourcePrefix(name, "法典"))) return "codex";
  if (/^mx\d+$/.test(baseId) && (canonicalId || hasSourcePrefix(name, "魔导书"))) return "grimoire";
  if (/^lx\d+$/.test(baseId) && (canonicalId || hasSourcePrefix(name, "L画风") || hasSourcePrefix(name, "Loli画风"))) {
    return "loli";
  }
  if (hasSourcePrefix(name, "法典")) return "codex";
  if (hasSourcePrefix(name, "魔导书")) return "grimoire";
  if (hasSourcePrefix(name, "L画风") || hasSourcePrefix(name, "Loli画风")) return "loli";
  return "other";
}

function categoryNameSegments(
  category: TemplateCategory,
  source: TemplateCategorySourceGroup["key"],
): string[] {
  if (source === "base" || source === "other") return [category.name];

  const parts = category.name.split("·").map((part) => part.trim()).filter(Boolean);
  const expected =
    source === "codex"
      ? new Set(["法典"])
      : source === "grimoire"
        ? new Set(["魔导书"])
        : new Set(["L画风", "Loli画风"]);
  if (!expected.has(parts[0] ?? "")) return [category.name];
  return parts.slice(1).length ? parts.slice(1) : [category.name];
}

/**
 * 由现有 id/name 推导「来源 → 同名主题 → 叶分类」，不改变词库 schema。
 * 直接分类与同名主题并存时，直接分类显示为「综合」。
 */
export function groupTemplateCategories(
  library: TemplateLibrary,
): TemplateCategorySourceGroup[] {
  const buckets = new Map<
    TemplateCategorySourceGroup["key"],
    Array<{ category: TemplateCategory; segments: string[] }>
  >();
  const knownIds = new Set(library.categories.map((category) => category.id));
  for (const category of library.categories) {
    const source = templateSourceKey(category, knownIds);
    const entries = buckets.get(source) ?? [];
    entries.push({ category, segments: categoryNameSegments(category, source) });
    buckets.set(source, entries);
  }

  const groups: TemplateCategorySourceGroup[] = [];
  for (const source of TEMPLATE_SOURCE_GROUPS) {
    const entries = buckets.get(source.key);
    if (!entries?.length) continue;

    const nestedTopics = new Set(
      entries.filter(({ segments }) => segments.length > 1).map(({ segments }) => segments[0]!),
    );
    const direct: TemplateCategoryLeaf[] = [];
    const subgroupMap = new Map<string, TemplateCategorySubgroup>();

    for (const { category, segments } of entries) {
      const topic = segments[0] ?? category.name;
      const nested = segments.length > 1 || nestedTopics.has(topic);
      if (!nested) {
        direct.push({ category, label: topic, path: [source.label, topic] });
        continue;
      }

      let subgroup = subgroupMap.get(topic);
      if (!subgroup) {
        subgroup = { key: `${source.key}:${topic}`, label: topic, categories: [] };
        subgroupMap.set(topic, subgroup);
      }
      const label = segments.length > 1 ? segments.slice(1).join("·") : "综合";
      subgroup.categories.push({
        category,
        label,
        path: [source.label, topic, label],
      });
    }

    // 主题本身与显式「…·综合」同时存在时，给自动归入的总览项加后缀，
    // 保留原分类名的可辨识性。
    for (const subgroup of subgroupMap.values()) {
      const hasExplicitGeneral = subgroup.categories.some(
        (leaf) => leaf.label === "综合" && categoryNameSegments(leaf.category, source.key).length > 1,
      );
      if (!hasExplicitGeneral) continue;
      for (const leaf of subgroup.categories) {
        if (leaf.label !== "综合" || categoryNameSegments(leaf.category, source.key).length > 1) continue;
        leaf.label = "综合（总览）";
        leaf.path = [source.label, subgroup.label, leaf.label];
      }
    }

    groups.push({
      ...source,
      categories: direct,
      subgroups: [...subgroupMap.values()],
    });
  }
  return groups;
}

export function hasTriedDefaultLibrary(): boolean {
  try {
    return localStorage.getItem(FETCHED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTriedDefaultLibrary(): void {
  try {
    localStorage.setItem(FETCHED_KEY, "1");
  } catch {
    /* ignore quota */
  }
}

/** 拉取失败的分类：definitive=配置/内容问题，重试无意义；transient=网络问题，下次可再试 */
export type DefaultLibraryResult =
  | { ok: true; library: TemplateLibrary }
  | { ok: false; error: string; definitive: boolean };

/**
 * 站长提供的默认词库是外部输入，限幅后再交给 normalize。
 * 4 MB 是为了装得下整本词库（法典 + 魔导书 合计 ~2.1 MB），
 * 同时仍拦住明显异常的响应。
 */
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
/** 提示语跟着上限走，改上限不用改文案，也不会和测试里的字面值对不上 */
const MAX_FETCH_LABEL = `${(MAX_FETCH_BYTES / 1024 / 1024).toFixed(0)} MB`;
/** 词库有 MB 级，8s 在慢网下不够；放宽到 20s */
const FETCH_TIMEOUT_MS = 20000;

/**
 * 从站长配置的 URL 拉取默认词库。
 * 不写 localStorage，也不打标记——调用方决定要不要落盘（见 PromptTemplateDialog）。
 */
export async function fetchDefaultTemplateLibrary(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DefaultLibraryResult> {
  const target = url.trim();
  if (!target) return { ok: false, error: "未配置默认词库地址", definitive: true };

  let resp: Response;
  try {
    resp = await fetchImpl(target, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (exc) {
    // 网络/超时/CORS：可能是临时的，留给下次打开重试
    return {
      ok: false,
      error: exc instanceof Error ? exc.message : String(exc),
      definitive: false,
    };
  }

  if (!resp.ok) {
    // 4xx 是地址写错，5xx 可能是服务端临时故障
    return { ok: false, error: `HTTP ${resp.status}`, definitive: resp.status < 500 };
  }

  // 相对路径写错时 nginx 的 try_files 会回 index.html 且带 200，必须靠类型识破
  const type = resp.headers.get("content-type") || "";
  if (type && !/json|text\/plain/i.test(type)) {
    return { ok: false, error: `返回的不是 JSON（${type.split(";")[0]}）`, definitive: true };
  }

  const declared = Number(resp.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    return { ok: false, error: `默认词库超过 ${MAX_FETCH_LABEL}`, definitive: true };
  }

  let text: string;
  try {
    text = await resp.text();
  } catch (exc) {
    return {
      ok: false,
      error: exc instanceof Error ? exc.message : String(exc),
      definitive: false,
    };
  }
  // ponytail: 分块响应没有 content-length，只能读完再判；上限内网小文件足够，
  //   真要防超大响应得改用 ReadableStream 边读边计数。
  if (new TextEncoder().encode(text).byteLength > MAX_FETCH_BYTES) {
    return { ok: false, error: `默认词库超过 ${MAX_FETCH_LABEL}`, definitive: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "默认词库不是合法 JSON", definitive: true };
  }

  const library = normalizeTemplateLibrary(parsed);
  if (!library.categories.length) {
    return { ok: false, error: "默认词库没有有效条目", definitive: true };
  }
  return { ok: true, library };
}

/** 单选分类替换旧值，多选分类累加；取消后清掉空数组，保持勾选状态干净 */
export function toggleTemplateSelection(
  selection: TemplateSelection,
  category: TemplateCategory,
  itemId: string,
): TemplateSelection {
  const current = readSelectionIds(selection, category.id);
  const next = current.includes(itemId)
    ? current.filter((id) => id !== itemId)
    : category.multi
      ? [...current, itemId]
      : [itemId];

  const out = { ...selection };
  if (next.length) writeSelectionIds(out, category.id, next);
  else delete out[category.id];
  return out;
}

/** 按分类顺序、分类内条目顺序拼接，勾选先后不影响结果；重复片段去重 */
export function buildTemplatePrompt(
  library: TemplateLibrary,
  selection: TemplateSelection,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const cat of library.categories) {
    const picked = readSelectionIds(selection, cat.id);
    if (!picked?.length) continue;
    for (const item of cat.items) {
      if (!picked.includes(item.id)) continue;
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      parts.push(item.text);
    }
  }
  return parts.join(SEPARATOR);
}

function pickIndex(length: number, rand: () => number): number {
  // rand() 允许返回 1（注入的实现不保证半开区间），必须夹住上界
  return Math.min(length - 1, Math.max(0, Math.floor(rand() * length)));
}

/** 单选分类抽 1 条，多选分类抽 1-2 条；rand 可注入以便测试 */
export function randomTemplateSelection(
  library: TemplateLibrary,
  rand: () => number = Math.random,
): TemplateSelection {
  const selection: TemplateSelection = {};
  for (const cat of library.categories) {
    if (!cat.items.length) continue;
    const pool = cat.items.map((item) => item.id);
    const take = cat.multi ? Math.min(pool.length, 1 + pickIndex(2, rand)) : 1;
    const picked: string[] = [];
    while (picked.length < take && pool.length) {
      picked.push(pool.splice(pickIndex(pool.length, rand), 1)[0]!);
    }
    writeSelectionIds(selection, cat.id, picked);
  }
  return selection;
}
