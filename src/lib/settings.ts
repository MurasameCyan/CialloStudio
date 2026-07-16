export type StudioSettings = {
  /** OpenAI 兼容 base，例如 https://host/v1 或相对路径 /v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  concurrency: number;
};

export const DEFAULT_SETTINGS: StudioSettings = {
  baseUrl: "/v1",
  apiKey: "",
  model: "grok-imagine-image",
  aspectRatio: "1:1",
  resolution: "1k",
  concurrency: 3,
};

const STORAGE_KEY = "ciallo-studio.settings.v1";

export function loadSettings(): StudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<StudioSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      baseUrl: normalizeBaseUrl(parsed.baseUrl ?? DEFAULT_SETTINGS.baseUrl),
      concurrency: clampConcurrency(parsed.concurrency ?? DEFAULT_SETTINGS.concurrency),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: StudioSettings): void {
  const next: StudioSettings = {
    ...settings,
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    concurrency: clampConcurrency(settings.concurrency),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "/v1";
  if (trimmed.startsWith("/")) return trimmed;
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "") || "";
    if (!path || path === "/") {
      url.pathname = "/v1";
    } else if (!path.endsWith("/v1")) {
      // 允许用户填根域名，自动补 /v1
      if (!path.includes("/v1")) {
        url.pathname = `${path}/v1`.replace(/\/{2,}/g, "/");
      }
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(8, Math.max(1, Math.round(value)));
}

export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const RESOLUTIONS = ["1k", "2k"] as const;
