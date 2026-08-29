/**
 * 创作台提示词模板库。
 *
 * 内容不内置：分类与条目由用户自己维护，存在 localStorage，可 JSON 导入导出
 * （见 scripts/convert-prompt-library.mjs，可把本地词库 HTML 转成导入用 JSON）。
 * 站长把 JSON 挂到 /prompt-templates.json 即可提供默认词库（或用
 * CIALLO_PROMPT_TEMPLATES_URL 指到别处），用户首次打开且本地为空时自动
 * 拉取一次（见 fetchDefaultTemplateLibrary 与 getPromptTemplatesSource）。
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

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function uniqueId(base: string, seen: Set<string>): string {
  let id = base;
  let n = 2;
  while (seen.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  seen.add(id);
  return id;
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
        id: uniqueId(str(rec.id) || `i${itemIndex}`, itemIds),
        name: cut(str(rec.name) || text, MAX_NAME_LEN),
        text,
      });
    });
    if (!items.length) return;
    budget -= items.length;

    categories.push({
      id: uniqueId(str(cat.id) || `c${catIndex}`, catIds),
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
  if (text.length > MAX_FETCH_BYTES) {
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
  const current = selection[category.id] ?? [];
  const next = current.includes(itemId)
    ? current.filter((id) => id !== itemId)
    : category.multi
      ? [...current, itemId]
      : [itemId];

  const out = { ...selection };
  if (next.length) out[category.id] = next;
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
    const picked = selection[cat.id];
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
    selection[cat.id] = picked;
  }
  return selection;
}
