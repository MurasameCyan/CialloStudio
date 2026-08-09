/**
 * 创作台提示词模板库。
 *
 * 内容不内置：分类与条目由用户自己维护，存在 localStorage，可 JSON 导入导出
 * （见 scripts/convert-prompt-library.mjs，可把本地词库 HTML 转成导入用 JSON）。
 * 这里只管存储与组装，UI 只负责勾选。
 */

const STORAGE_KEY = "ciallo-studio.prompt-templates.v1";
const SEPARATOR = ", ";

/** 导入是信任边界：用户粘贴的 JSON 要限幅，否则一次大 paste 就撑爆 localStorage 配额 */
const MAX_CATEGORIES = 40;
const MAX_ITEMS = 500;
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

  source.slice(0, MAX_CATEGORIES).forEach((rawCat, catIndex) => {
    if (!rawCat || typeof rawCat !== "object") return;
    const cat = rawCat as Record<string, unknown>;
    const rawItems = Array.isArray(cat.items) ? cat.items : [];

    const items: TemplateItem[] = [];
    const itemIds = new Set<string>();
    rawItems.slice(0, MAX_ITEMS).forEach((entry, itemIndex) => {
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

export function saveTemplateLibrary(library: TemplateLibrary): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch {
    /* ignore quota */
  }
}

export function countTemplateItems(library: TemplateLibrary): number {
  return library.categories.reduce((sum, cat) => sum + cat.items.length, 0);
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
