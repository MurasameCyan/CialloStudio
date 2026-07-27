const STORAGE_KEY = "ciallo-studio.prompt-history.v1";
const MAX_ITEMS = 40;

export type PromptHistoryItem = {
  id: string;
  text: string;
  createdAt: number;
};

function firstLine(text: string): string {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || "(空提示词)";
}

export function promptHistoryPreview(text: string, maxLen = 72): string {
  const line = firstLine(text);
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen - 1)}…`;
}

export function loadPromptHistory(): PromptHistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is PromptHistoryItem =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as PromptHistoryItem).id === "string" &&
          typeof (item as PromptHistoryItem).text === "string",
      )
      .map((item) => ({
        id: item.id,
        text: item.text,
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      }))
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

export function savePromptHistory(items: PromptHistoryItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    /* ignore quota */
  }
}

/** 新记录插到最前；与首条相同则不重复写入 */
export function pushPromptHistory(items: PromptHistoryItem[], text: string): PromptHistoryItem[] {
  const value = String(text ?? "").trim();
  if (!value) return items;
  if (items[0]?.text.trim() === value) return items;
  const next: PromptHistoryItem = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    text: value,
    createdAt: Date.now(),
  };
  return [next, ...items.filter((item) => item.text.trim() !== value)].slice(0, MAX_ITEMS);
}
