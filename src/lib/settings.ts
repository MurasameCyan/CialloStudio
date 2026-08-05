export type StudioSettings = {
  /** OpenAI 兼容 base，例如 https://host/v1 或相对路径 /v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  concurrency: number;
  /** 提示词优化专用 chat 模型 ID（设置页配置） */
  promptOptimizeModel: string;
  /** true = 优化走独立 Base/Key；false = 复用生图上游 */
  promptOptimizeCustomUpstream: boolean;
  promptOptimizeBaseUrl: string;
  promptOptimizeApiKey: string;
  /**
   * 图生图开关：开启后创作台显示「参考图」上传区，
   * 任何生图模型都可带参考图走 /images/edits。
   * 编辑类模型（grok-imagine-image-edit）无论开关都必须带参考图。
   */
  imageToImageEnabled: boolean;
  /** 文生视频开关：开启后创作台可切到视频模式（/videos/generations） */
  videoEnabled: boolean;
  /** 文生视频模型 ID */
  videoModel: string;
};

export const DEFAULT_SETTINGS: StudioSettings = {
  // 管理页填写完整上游，如 https://your-gateway/v1
  // 浏览器实际请求走同源 /v1 + 头 X-Ciallo-Upstream（免 CORS，不写 .env）
  baseUrl: "",
  apiKey: "",
  model: "grok-imagine-image",
  aspectRatio: "1:1",
  resolution: "1k",
  concurrency: 2,
  promptOptimizeModel: "",
  promptOptimizeCustomUpstream: false,
  promptOptimizeBaseUrl: "",
  promptOptimizeApiKey: "",
  imageToImageEnabled: false,
  videoEnabled: false,
  videoModel: "grok-imagine-video",
};

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

/** 从 Base URL 得到上游根 origin（https://host），用于代理头 X-Ciallo-Upstream */
export function upstreamOrigin(baseUrl: string): string {
  const trimmed = asString(baseUrl, "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.startsWith("/")) return "";
  try {
    const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).origin;
  } catch {
    return trimmed.replace(/\/v1$/i, "").replace(/\/+$/, "");
  }
}

const STORAGE_KEY = "ciallo-studio.settings.v1";

export function loadSettings(): StudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<StudioSettings>;
    const resolutionRaw = asString(parsed.resolution, DEFAULT_SETTINGS.resolution).toLowerCase();
    const resolution = resolutionRaw === "2k" ? "2k" : "1k";
    return {
      baseUrl: normalizeBaseUrl(asString(parsed.baseUrl, DEFAULT_SETTINGS.baseUrl)),
      apiKey: asString(parsed.apiKey, DEFAULT_SETTINGS.apiKey),
      model: asString(parsed.model, DEFAULT_SETTINGS.model) || DEFAULT_SETTINGS.model,
      aspectRatio: asString(parsed.aspectRatio, DEFAULT_SETTINGS.aspectRatio) || DEFAULT_SETTINGS.aspectRatio,
      resolution,
      concurrency: clampConcurrency(parsed.concurrency ?? DEFAULT_SETTINGS.concurrency),
      promptOptimizeModel: asString(parsed.promptOptimizeModel, DEFAULT_SETTINGS.promptOptimizeModel),
      promptOptimizeCustomUpstream: parsed.promptOptimizeCustomUpstream === true,
      promptOptimizeBaseUrl: normalizeBaseUrl(
        asString(parsed.promptOptimizeBaseUrl, DEFAULT_SETTINGS.promptOptimizeBaseUrl),
      ),
      promptOptimizeApiKey: asString(parsed.promptOptimizeApiKey, DEFAULT_SETTINGS.promptOptimizeApiKey),
      imageToImageEnabled: parsed.imageToImageEnabled === true,
      videoEnabled: parsed.videoEnabled === true,
      videoModel: asString(parsed.videoModel, DEFAULT_SETTINGS.videoModel) || DEFAULT_SETTINGS.videoModel,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: StudioSettings): void {
  const next: StudioSettings = {
    baseUrl: normalizeBaseUrl(asString(settings.baseUrl, "")),
    apiKey: asString(settings.apiKey, ""),
    model: asString(settings.model, DEFAULT_SETTINGS.model) || DEFAULT_SETTINGS.model,
    aspectRatio: asString(settings.aspectRatio, DEFAULT_SETTINGS.aspectRatio),
    resolution: settings.resolution === "2k" ? "2k" : "1k",
    concurrency: clampConcurrency(settings.concurrency),
    promptOptimizeModel: asString(settings.promptOptimizeModel, "").trim(),
    promptOptimizeCustomUpstream: settings.promptOptimizeCustomUpstream === true,
    promptOptimizeBaseUrl: normalizeBaseUrl(asString(settings.promptOptimizeBaseUrl, "")),
    promptOptimizeApiKey: asString(settings.promptOptimizeApiKey, ""),
    imageToImageEnabled: settings.imageToImageEnabled === true,
    videoEnabled: settings.videoEnabled === true,
    videoModel: asString(settings.videoModel, DEFAULT_SETTINGS.videoModel).trim() || DEFAULT_SETTINGS.videoModel,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = asString(value, "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  // 仅本地 dev 允许相对 /v1
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

/**
 * 创作台 / 全局并发数值钳制。
 * maxCap 默认 8（策略层再按用户组收紧可选按钮）。
 */
export function clampConcurrency(value: unknown, maxCap = 8): number {
  const n = typeof value === "number" ? value : Number(value);
  const cap = Math.min(8, Math.max(1, Math.round(Number(maxCap)) || 8));
  if (!Number.isFinite(n)) return 1;
  return Math.min(cap, Math.max(1, Math.round(n)));
}

/** 解析提示词优化实际使用的上游 + 模型 */
export function resolvePromptOptimizeEndpoint(settings: StudioSettings): {
  baseUrl: string;
  apiKey: string;
  model: string;
  usingCustomUpstream: boolean;
} {
  const model = asString(settings.promptOptimizeModel, "").trim();
  if (settings.promptOptimizeCustomUpstream) {
    return {
      baseUrl: normalizeBaseUrl(asString(settings.promptOptimizeBaseUrl, "")),
      apiKey: asString(settings.promptOptimizeApiKey, "").trim(),
      model,
      usingCustomUpstream: true,
    };
  }
  return {
    baseUrl: normalizeBaseUrl(asString(settings.baseUrl, "")),
    apiKey: asString(settings.apiKey, "").trim(),
    model,
    usingCustomUpstream: false,
  };
}

export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
/** grok2api 图片接口实际只认 1k / 2k；4k 会被拒绝或被 lite 模型忽略 */
export const RESOLUTIONS = ["1k", "2k"] as const;

/** grok2api /videos/generations 支持的分辨率 */
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
/** grok2api /videos/generations 支持的时长（秒） */
export const VIDEO_DURATIONS = [6, 10, 15] as const;

export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export function normalizeVideoResolution(value: unknown): VideoResolution {
  const raw = asString(value, "").trim().toLowerCase();
  return (VIDEO_RESOLUTIONS as readonly string[]).includes(raw) ? (raw as VideoResolution) : "720p";
}

/** 时长只认 6 / 10 / 15，其余就近取值 */
export function normalizeVideoDuration(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 6;
  return VIDEO_DURATIONS.reduce((best, item) =>
    Math.abs(item - n) < Math.abs(best - n) ? item : best,
  );
}
