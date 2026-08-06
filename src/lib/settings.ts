export type StudioSettings = {
  /** OpenAI 兼容 base，例如 https://host/v1 或相对路径 /v1 */
  baseUrl: string;
  apiKey: string;
  /** 文生图模型 */
  model: string;
  /**
   * 图生图模型（走 /images/edits）。
   * 空 = 未启用：创作台不显示「参考图」上传区。
   * 填了就等于开启图生图，带参考图时用这个模型而不是文生图模型。
   */
  imageEditModel: string;
  /** 文生视频模型（/videos/generations）。空 = 创作台没有「视频」模式 */
  videoModel: string;
  /** 提示词优化专用 chat 模型 ID */
  promptOptimizeModel: string;
  /** true = 优化走独立 Base/Key；false = 复用生图上游 */
  promptOptimizeCustomUpstream: boolean;
  promptOptimizeBaseUrl: string;
  promptOptimizeApiKey: string;
  /** 图片默认：宽高比 / 分辨率 */
  aspectRatio: string;
  resolution: string;
  /** 视频默认：宽高比 / 分辨率 / 时长 */
  videoAspectRatio: string;
  videoResolution: string;
  videoDuration: number;
};

export const DEFAULT_SETTINGS: StudioSettings = {
  // 管理页填写完整上游，如 https://your-gateway/v1
  // 浏览器实际请求走同源 /v1 + 头 X-Ciallo-Upstream（免 CORS，不写 .env）
  baseUrl: "",
  apiKey: "",
  model: "grok-imagine-image",
  // 图生图 / 视频默认留空：选了模型才在创作台出现对应入口
  imageEditModel: "",
  videoModel: "",
  promptOptimizeModel: "",
  promptOptimizeCustomUpstream: false,
  promptOptimizeBaseUrl: "",
  promptOptimizeApiKey: "",
  aspectRatio: "1:1",
  resolution: "1k",
  videoAspectRatio: "16:9",
  videoResolution: "720p",
  videoDuration: 6,
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
    return normalizeSettings(migrateLegacyToggles(JSON.parse(raw)));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 迁移旧版「功能开关 + 模型」两段式配置到现在的「模型槽即开关」。
 * 旧版 saveSettings 无论开关状态都会写死 videoModel="grok-imagine-video"，
 * 所以直接读取会让所有老用户的视频模式凭空打开——按旧开关把槽清掉。
 * 新版不再写 videoEnabled，因此存一次之后这段就不会再命中。
 */
function migrateLegacyToggles(raw: unknown): Partial<StudioSettings> {
  const parsed = (raw ?? {}) as Partial<StudioSettings> & {
    videoEnabled?: unknown;
    imageToImageEnabled?: unknown;
  };
  const next: Partial<StudioSettings> = { ...parsed };
  if ("videoEnabled" in parsed && parsed.videoEnabled !== true) next.videoModel = "";
  if ("imageToImageEnabled" in parsed && parsed.imageToImageEnabled !== true) next.imageEditModel = "";
  return next;
}

/**
 * 单一归一化入口：loadSettings / saveSettings / 设置页 persist 共用，
 * 避免三处各写一份钳制逻辑而漂移。
 */
export function normalizeSettings(input: Partial<StudioSettings>): StudioSettings {
  const resolutionRaw = asString(input.resolution, DEFAULT_SETTINGS.resolution).toLowerCase();
  const customUpstream = input.promptOptimizeCustomUpstream === true;
  return {
    baseUrl: normalizeBaseUrl(asString(input.baseUrl, DEFAULT_SETTINGS.baseUrl)),
    apiKey: asString(input.apiKey, DEFAULT_SETTINGS.apiKey),
    model: asString(input.model, DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    // 图生图 / 视频模型可以为空（= 该功能未启用），所以不套默认值
    imageEditModel: asString(input.imageEditModel, "").trim(),
    videoModel: asString(input.videoModel, "").trim(),
    promptOptimizeModel: asString(input.promptOptimizeModel, "").trim(),
    promptOptimizeCustomUpstream: customUpstream,
    // 复用生图上游时不留残值，避免关掉独立上游后仍带着旧 Key
    promptOptimizeBaseUrl: customUpstream
      ? normalizeBaseUrl(asString(input.promptOptimizeBaseUrl, ""))
      : "",
    promptOptimizeApiKey: customUpstream ? asString(input.promptOptimizeApiKey, "") : "",
    aspectRatio: asString(input.aspectRatio, DEFAULT_SETTINGS.aspectRatio) || DEFAULT_SETTINGS.aspectRatio,
    resolution: resolutionRaw === "2k" ? "2k" : "1k",
    videoAspectRatio:
      asString(input.videoAspectRatio, DEFAULT_SETTINGS.videoAspectRatio) ||
      DEFAULT_SETTINGS.videoAspectRatio,
    videoResolution: normalizeVideoResolution(input.videoResolution),
    videoDuration: normalizeVideoDuration(input.videoDuration),
  };
}

export function saveSettings(settings: StudioSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
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
 * 创作台并发数值钳制（草稿字段，不再是设置页的全局项）。
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
