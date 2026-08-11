import { log } from "./logger";
import { normalizeBaseUrl, upstreamOrigin } from "./settings";

export type OpenAIModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

export type ImageResult = {
  /** 用于 <img> 展示：blob:/data: 或可访问 URL */
  url: string;
  /** 同源可打开的媒体路径（非 blob），便于“打开原图” */
  openUrl?: string;
  b64_json?: string;
  revised_prompt?: string;
  mime_type?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** 终态：不该自动重试。上游会带自己的 code，靠 code 名字判断会漏 */
  readonly terminal: boolean;

  constructor(status: number, message: string, code?: string, terminal = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.terminal = terminal;
  }
}

/**
 * 浏览器侧实际请求基址：始终走同源 /v1 代理，避免 CORS。
 * 真实上游由管理页 Base URL 决定，经请求头 X-Ciallo-Upstream 传给 Vite/Nginx。
 */
export function resolveBrowserApiBase(baseUrl: string): string {
  const configured = normalizeBaseUrl(baseUrl);
  if (!configured) return "";
  // 相对路径已是同源
  if (configured.startsWith("/")) return configured.startsWith("/v1") ? "/v1" : configured;
  // 绝对上游 → 同源代理
  if (typeof window !== "undefined") return "/v1";
  return configured;
}

/** 代理用：上游根 origin（https://host），空表示未配置 */
export function resolveUpstreamOrigin(baseUrl: string): string {
  return upstreamOrigin(normalizeBaseUrl(baseUrl));
}

const UPSTREAM_COOKIE = "ciallo_upstream";

/** 写入 cookie，供 <img src="/v1/media/..."> 等无法自定义头的请求给 Nginx/Vite 读上游 */
export function rememberUpstreamOrigin(baseUrl: string): void {
  if (typeof document === "undefined") return;
  const origin = resolveUpstreamOrigin(baseUrl);
  if (!origin) return;
  // 不设 Domain，仅当前站；Lax 足够同源媒体
  document.cookie = `${UPSTREAM_COOKIE}=${encodeURIComponent(origin)}; Path=/; SameSite=Lax; Max-Age=31536000`;
}

function isSameOriginMediaPath(url: string): boolean {
  return url.startsWith("/v1/") || url.startsWith("/media/");
}

function joinUrl(baseUrl: string, path: string): string {
  const base = resolveBrowserApiBase(baseUrl);
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (base.startsWith("/")) {
    return `${base}${cleanPath}`;
  }
  return `${base}${cleanPath}`;
}

function describeFetchError(error: unknown, url: string): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "请求已取消";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return [
      `网络失败: ${message}`,
      `URL: ${url}`,
      "请确认：1) 管理页已填完整上游 https://网关/v1  2) 本机 Vite/Docker 在跑  3) 上游可访问",
    ].join("\n");
  }
  return `${message}\nURL: ${url}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析上游错误体。除 OpenAI 的 { error: { code, message } } 外，
 * 还要认 grok2api 的顶层平铺格式（error 是字符串）：
 *   {"code":"imagine:content-moderated","error":"Generated image rejected..."}
 * 否则 code 被吞成 upstream_error、message 回退成整段原始 JSON。
 */
export function readUpstreamError(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload)) return {};
  const error = isRecord(payload.error) ? payload.error : payload;
  const code =
    (typeof error.code === "string" && error.code) ||
    (typeof error.error_code === "number" && String(error.error_code)) ||
    (typeof error.error_code === "string" && error.error_code) ||
    // error 是对象但没带 code 时，回落到顶层 code（grok2api 就是顶层平铺）
    (typeof payload.code === "string" && payload.code) ||
    (typeof payload.status === "number" && String(payload.status)) ||
    undefined;
  const message =
    (typeof error.message === "string" && error.message) ||
    (typeof error.detail === "string" && error.detail) ||
    (typeof error.title === "string" && error.title) ||
    (typeof payload.error === "string" && payload.error) ||
    (typeof payload.detail === "string" && payload.detail) ||
    (typeof payload.title === "string" && payload.title) ||
    undefined;
  return { code, message };
}

/** 上游图片审核拦截的 code：grokb 用 imagine:content-moderated */
export function isContentModerationCode(code?: string): boolean {
  if (!code) return false;
  return /content[-_]?moderat/i.test(code);
}

/** 审核类失败换成中文提示；其它错误保持上游原文，别吃掉信息 */
export function describeUpstreamError(code: string | undefined, message: string): string {
  if (isContentModerationCode(code)) {
    return "提示词或生成结果被上游内容审核拦截，请改写提示词后重试";
  }
  return message;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

function extractMediaPath(pathname: string, search = "", hash = ""): string | null {
  const mediaIdx = pathname.indexOf("/v1/media/");
  if (mediaIdx >= 0) {
    return `${pathname.slice(mediaIdx)}${search}${hash}`;
  }
  const videoIdx = pathname.indexOf("/v1/videos/");
  if (videoIdx >= 0) {
    return `${pathname.slice(videoIdx)}${search}${hash}`;
  }
  if (pathname.startsWith("/media/")) {
    return `/v1${pathname}${search}${hash}`;
  }
  return null;
}

/**
 * grok2api 常返回内网媒体地址（如 http://127.0.0.1:8000/v1/media/...）。
 * 必须改写为当前 API base / 同源代理路径，否则浏览器会打到用户本机 8000。
 */
export function rewriteMediaUrl(rawUrl: string, baseUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return value;
  if (value.startsWith("data:") || value.startsWith("blob:")) return value;

  // 媒体同样优先走同源代理，避免 127.0.0.1:8000 / CORS
  const base = resolveBrowserApiBase(baseUrl);
  const originFallback =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost";

  try {
    const parsed = new URL(value, originFallback);
    const mediaPath = extractMediaPath(parsed.pathname, parsed.search, parsed.hash);
    const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);

    // 内网地址或明确 media 路径：一律改写
    if (mediaPath && (isLoopback || mediaPath.startsWith("/v1/media/") || mediaPath.startsWith("/v1/videos/"))) {
      if (base.startsWith("/")) {
        return mediaPath;
      }
      const api = new URL(base.endsWith("/v1") ? base : `${base}/v1`);
      return `${api.origin}${mediaPath}`;
    }

    if (base.startsWith("/")) {
      if (parsed.origin === originFallback) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      return value;
    }

    return parsed.toString();
  } catch {
    // 兜底：纯字符串替换 loopback
    const replaced = value
      .replace(/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i, "")
      .replace(/^\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i, "");
    if (replaced.startsWith("/v1/media/") || replaced.startsWith("/media/")) {
      return replaced.startsWith("/media/") ? `/v1${replaced}` : replaced;
    }
    return value;
  }
}

/**
 * <img>/<video> 直连这些地址会缺 Authorization / X-Ciallo-Upstream，必须 blob 化：
 * 同源代理路径、内网地址，以及带 /v1/videos|/v1/media 的上游媒体地址。
 * generateImage 用的是更窄的判定（公网 CDN 图直连即可，不必额外拉一遍）。
 */
export function needsMediaMaterialize(url: string): boolean {
  if (!url || /^(blob|data):/i.test(url)) return false;
  return (
    isSameOriginMediaPath(url) ||
    url.includes("/v1/videos/") ||
    url.includes("/v1/media/") ||
    /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\//i.test(url)
  );
}

/**
 * 通过可访问地址拉取图片并转为 blob: URL，彻底避开跨域/内网主机问题。
 */
export async function materializeImageUrl(input: {
  rawUrl: string;
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (input.rawUrl.startsWith("data:") || input.rawUrl.startsWith("blob:")) {
    return input.rawUrl;
  }

  const rewritten = rewriteMediaUrl(input.rawUrl, input.baseUrl);
  log("info", "拉取媒体", { raw: input.rawUrl, rewritten });
  const headers = new Headers({
    Accept: "image/*,video/*,application/octet-stream;q=0.9,*/*;q=0.8",
  });
  const mediaKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (mediaKey) {
    headers.set("Authorization", `Bearer ${mediaKey}`);
  }
  const origin = resolveUpstreamOrigin(input.baseUrl);
  if (origin && (rewritten.startsWith("/v1") || rewritten.startsWith("/media"))) {
    headers.set("X-Ciallo-Upstream", origin);
  }

  let response: Response;
  try {
    response = await fetch(rewritten, {
      method: "GET",
      headers,
      signal: input.signal,
    });
  } catch (error) {
    const msg = describeFetchError(error, rewritten);
    log("error", "媒体 fetch 失败", msg);
    throw new ApiError(0, msg, "media_network_error");
  }

  if (!response.ok) {
    const msg = `图片资源拉取失败 (${response.status})`;
    log("error", msg, rewritten);
    throw new ApiError(response.status, msg, "media_fetch_failed");
  }

  const blob = await response.blob();
  if (!blob.size) {
    log("error", "图片资源为空", rewritten);
    throw new ApiError(200, "图片资源为空", "media_empty");
  }
  const objectUrl = URL.createObjectURL(blob);
  log("ok", "媒体已转为 blob", { size: blob.size, type: blob.type, objectUrl });
  return objectUrl;
}

async function apiRequest(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) {
    throw new ApiError(401, "请先在管理页填写 API Key", "missing_api_key");
  }

  const configuredBase = normalizeBaseUrl(typeof baseUrl === "string" ? baseUrl : "");
  if (!configuredBase) {
    throw new ApiError(
      400,
      "请先在管理页填写 API Base URL（完整地址，如 https://your-gateway/v1）",
      "missing_base_url",
    );
  }
  const requestBase = resolveBrowserApiBase(typeof baseUrl === "string" ? baseUrl : "");
  const origin = resolveUpstreamOrigin(typeof baseUrl === "string" ? baseUrl : "");
  const url = joinUrl(typeof baseUrl === "string" ? baseUrl : "", path);
  log("info", "请求基址", {
    configuredBase,
    requestBase,
    upstreamOrigin: origin || "(relative)",
    pageOrigin: typeof window !== "undefined" ? window.location.origin : "(ssr)",
  });

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
  });
  // 同源代理根据此头转发到真实上游（不写进 .env）
  if (origin) {
    headers.set("X-Ciallo-Upstream", origin);
    rememberUpstreamOrigin(baseUrl);
  }

  let body: string | undefined;
  if (init.body) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }

  const method = init.method ?? "GET";
  log("info", `请求 ${method} ${url}`, init.body ? { body: init.body } : undefined);

  const maxAttempts = method === "POST" ? 3 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: init.signal,
      });
    } catch (error) {
      const msg = describeFetchError(error, url);
      log("error", `请求失败 ${method} ${url}`, msg);
      throw new ApiError(0, msg, "network_error");
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const err = readUpstreamError(payload);
      const fallback = text.trim() || response.statusText || `HTTP ${response.status}`;
      const message = describeUpstreamError(err.code, err.message ?? fallback);
      const retryable = response.status === 502 || response.status === 503 || response.status === 504;
      log("error", `HTTP ${response.status} ${method} ${url} (attempt ${attempt}/${maxAttempts})`, {
        code: err.code,
        message,
        bodyPreview: text.slice(0, 500),
      });
      lastError = new ApiError(
        response.status,
        retryable
          ? `上游暂时不可用 (${response.status}): ${message}`
          : message,
        err.code,
      );
      if (retryable && attempt < maxAttempts) {
        const waitMs = attempt * 2000;
        log("warn", `将在 ${waitMs}ms 后重试…`);
        await sleep(waitMs, init.signal);
        continue;
      }
      throw lastError;
    }

    if (payload === null) {
      log("error", "非 JSON 响应", text.slice(0, 500));
      throw new ApiError(response.status, "接口返回了非 JSON 响应", "invalid_response");
    }

    log("ok", `响应 ${response.status} ${method} ${url}`);
    return payload;
  }

  throw lastError instanceof Error ? lastError : new ApiError(0, "请求失败", "unknown");
}

export async function listModels(input: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<OpenAIModel[]> {
  log("info", "拉取模型列表…", {
    baseUrl: input.baseUrl,
    requestBase: resolveBrowserApiBase(input.baseUrl),
  });
  const payload = await apiRequest(input.baseUrl, input.apiKey, "/models", {
    method: "GET",
    signal: input.signal,
  });

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ApiError(200, "模型列表格式无效", "invalid_response");
  }

  const models = payload.data.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return [];
    return [
      {
        id: item.id,
        object: typeof item.object === "string" ? item.object : undefined,
        created: typeof item.created === "number" ? item.created : undefined,
        owned_by: typeof item.owned_by === "string" ? item.owned_by : undefined,
      },
    ];
  });
  log("ok", `模型 ${models.length} 个`, models.map((m) => m.id));
  return models;
}

/** blob:/http(s)/data: → 可供 grok2api image.url 使用的 data URL 或 http(s) */
async function normalizeReferenceImageUrl(
  raw: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = raw.trim();
  if (!value) {
    throw new ApiError(400, "参考图地址为空", "empty_reference");
  }
  if (value.startsWith("data:image/")) return value;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;

  // 卡片展示常用 blob:；编辑接口需要 data URL / 可下载 http(s)
  if (value.startsWith("blob:")) {
    try {
      const response = await fetch(value, { signal });
      if (!response.ok) {
        throw new ApiError(response.status, "读取参考图失败", "reference_blob_fetch_failed");
      }
      const blob = await response.blob();
      if (!blob.size) {
        throw new ApiError(400, "参考图为空", "reference_empty");
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          if (!result.startsWith("data:")) reject(new Error("参考图转码失败"));
          else resolve(result);
        };
        reader.onerror = () => reject(new Error("参考图转码失败"));
        reader.readAsDataURL(blob);
      });
      return dataUrl;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        400,
        error instanceof Error ? error.message : "参考图处理失败",
        "reference_blob_convert_failed",
      );
    }
  }

  // 同源 /v1/media 等：原样返回，由上游自行拉取（多数网关要求 data/http）
  return value;
}

export async function generateImage(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  n?: number;
  aspectRatio?: string;
  resolution?: string;
  /** 单张参考图：URL / data URL / blob:（会转 data URL） */
  imageUrl?: string;
  /** 多参考图；与 imageUrl 二选一优先 imageUrls */
  imageUrls?: string[];
  signal?: AbortSignal;
}): Promise<ImageResult[]> {
  const rawRefs = (input.imageUrls?.filter((u) => typeof u === "string" && u.trim()) ?? []).map((u) =>
    u.trim(),
  );
  const single =
    rawRefs.length === 0 && typeof input.imageUrl === "string" && input.imageUrl.trim()
      ? input.imageUrl.trim()
      : undefined;
  const sourceRefs = rawRefs.length > 0 ? rawRefs : single ? [single] : [];
  const hasRef = sourceRefs.length > 0;

  // grok2api：图+文走 POST /images/edits，字段为 image / images: { url }
  // 纯文生图仍走 /images/generations
  const path = hasRef ? "/images/edits" : "/images/generations";

  log("info", hasRef ? "开始图+文编辑" : "开始创作", {
    model: input.model,
    prompt: input.prompt,
    n: input.n ?? 1,
    aspectRatio: input.aspectRatio ?? "1:1",
    resolution: input.resolution ?? "1k",
    baseUrl: input.baseUrl,
    requestBase: resolveBrowserApiBase(input.baseUrl),
    path,
    reference: hasRef ? `images×${sourceRefs.length}` : "none",
  });

  let body: Record<string, unknown>;
  if (hasRef) {
    const normalized: string[] = [];
    for (const ref of sourceRefs) {
      normalized.push(await normalizeReferenceImageUrl(ref, input.signal));
    }
    if (normalized.length === 0) {
      throw new ApiError(400, "参考图无效", "invalid_reference");
    }
    // grok2api /images/edits 支持 aspect_ratio；resolution 仅 1k|2k
    const resolutionRaw = String(input.resolution ?? "1k").trim().toLowerCase();
    const resolution = resolutionRaw === "2k" ? "2k" : "1k";
    body = {
      model: input.model,
      prompt: input.prompt,
      n: input.n ?? 1,
      aspect_ratio: input.aspectRatio ?? "1:1",
      resolution,
      response_format: "url",
    };
    if (normalized.length === 1) {
      body.image = { url: normalized[0] };
    } else {
      body.images = normalized.map((url) => ({ url }));
    }
  } else {
    body = {
      model: input.model,
      prompt: input.prompt,
      n: input.n ?? 1,
      aspect_ratio: input.aspectRatio ?? "1:1",
      resolution: input.resolution ?? "1k",
      response_format: "url",
      stream: false,
    };
  }

  const payload = await apiRequest(input.baseUrl, input.apiKey, path, {
    method: "POST",
    signal: input.signal,
    body,
  });

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ApiError(200, "创作响应格式无效", "invalid_response");
  }

  const images: ImageResult[] = [];
  for (const item of payload.data) {
    if (!isRecord(item)) continue;

    if (typeof item.b64_json === "string" && item.b64_json.trim()) {
      const mime = typeof item.mime_type === "string" && item.mime_type.trim() ? item.mime_type : "image/png";
      images.push({
        url: `data:${mime};base64,${item.b64_json}`,
        b64_json: item.b64_json,
        revised_prompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
        mime_type: mime,
      });
      continue;
    }

    if (typeof item.url === "string" && item.url.trim()) {
      const rewritten = rewriteMediaUrl(item.url, input.baseUrl);
      log("info", "创作返回 URL", { raw: item.url, rewritten });
      rememberUpstreamOrigin(input.baseUrl);

      // 同源 /v1/media 或内网地址：必须 blob 化，因为 <img> 带不了 X-Ciallo-Upstream
      let displayUrl = rewritten;
      const needsMaterialize =
        isSameOriginMediaPath(rewritten) ||
        /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\//i.test(rewritten);

      if (needsMaterialize) {
        try {
          displayUrl = await materializeImageUrl({
            rawUrl: item.url,
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            signal: input.signal,
          });
          log("ok", "媒体已 blob 化供展示", { rewritten, display: displayUrl.slice(0, 48) });
        } catch (error) {
          log("warn", "blob 化失败，回退 rewritten（依赖 cookie 代理）", error);
          displayUrl = rewritten;
        }
      }

      images.push({
        url: displayUrl,
        // openUrl 保留同源路径，打开时靠 cookie 代理
        openUrl: rewritten.startsWith("blob:") || rewritten.startsWith("data:") ? undefined : rewritten,
        revised_prompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
        mime_type: typeof item.mime_type === "string" ? item.mime_type : undefined,
      });
    }
  }

  if (images.length === 0) {
    throw new ApiError(200, "创作响应中没有图片", "invalid_response");
  }

  log("ok", `创作完成 ${images.length} 张`);
  return images;
}

export type VideoStatus = "pending" | "done" | "failed";

export type VideoResult = {
  status: VideoStatus;
  model?: string;
  /** 0–100 */
  progress: number;
  video?: {
    url: string;
    duration?: number;
    respectModeration?: boolean;
  };
  error?: { code?: string; message: string };
};

function isVideoStatus(value: unknown): value is VideoStatus {
  return value === "pending" || value === "done" || value === "failed";
}

/**
 * 文生视频入队：POST /videos/generations → request_id（异步，需轮询）。
 * 带 imageUrl 时为图生视频（上游字段 image.url）。
 */
export async function createVideoTask(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** 6 / 10 / 15 秒 */
  duration: number;
  aspectRatio: string;
  /** 480p / 720p / 1080p */
  resolution: string;
  /** 可选首帧参考图：URL / data URL / blob:（会转 data URL） */
  imageUrl?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) {
    throw new ApiError(400, "请先在管理页填写「视频模型」", "missing_video_model");
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    throw new ApiError(400, "请先输入提示词", "empty_prompt");
  }

  const body: Record<string, unknown> = {
    model,
    prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
  };
  const ref = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
  if (ref) {
    body.image = { url: await normalizeReferenceImageUrl(ref, input.signal) };
  }

  log("info", "开始生成视频", {
    model,
    prompt,
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    reference: ref ? "image" : "none",
  });

  const payload = await apiRequest(input.baseUrl, input.apiKey, "/videos/generations", {
    method: "POST",
    signal: input.signal,
    body,
  });

  const requestId =
    isRecord(payload) && typeof payload.request_id === "string" ? payload.request_id.trim() : "";
  if (!requestId) {
    throw new ApiError(200, "视频响应中没有 request_id", "invalid_response");
  }
  log("ok", "视频任务已入队", { requestId });
  return requestId;
}

/** 查询视频任务：GET /videos/{request_id} */
export async function getVideoTask(input: {
  baseUrl: string;
  apiKey: string;
  requestId: string;
  signal?: AbortSignal;
}): Promise<VideoResult> {
  const payload = await apiRequest(
    input.baseUrl,
    input.apiKey,
    `/videos/${encodeURIComponent(input.requestId)}`,
    { method: "GET", signal: input.signal },
  );

  if (!isRecord(payload) || !isVideoStatus(payload.status)) {
    throw new ApiError(200, "视频状态响应无效", "invalid_response");
  }

  const progressRaw = typeof payload.progress === "number" ? payload.progress : NaN;
  const result: VideoResult = {
    status: payload.status,
    model: typeof payload.model === "string" ? payload.model : undefined,
    progress: Number.isFinite(progressRaw)
      ? Math.max(0, Math.min(100, progressRaw))
      : payload.status === "done"
        ? 100
        : 0,
  };

  if (isRecord(payload.video) && typeof payload.video.url === "string" && payload.video.url.trim()) {
    result.video = {
      url: rewriteMediaUrl(payload.video.url, input.baseUrl),
      duration: typeof payload.video.duration === "number" ? payload.video.duration : undefined,
      respectModeration:
        typeof payload.video.respect_moderation === "boolean"
          ? payload.video.respect_moderation
          : undefined,
    };
  }

  const err = isRecord(payload.error) ? payload.error : undefined;
  if (err && typeof err.message === "string") {
    result.error = {
      code: typeof err.code === "string" ? err.code : undefined,
      message: err.message,
    };
  }

  return result;
}

/** 轮询间隔：上游生成 6–15s 视频通常需要数十秒 */
const VIDEO_POLL_INTERVAL_MS = 3000;
/** 兜底上限，防止 pending 卡死时无限轮询（约 10 分钟） */
const VIDEO_POLL_MAX_ATTEMPTS = 200;

/**
 * 入队 + 轮询直到 done/failed，返回可播放的视频地址。
 * 同源 /v1/media 路径会被 blob 化，避免 <video> 带不了上游头。
 */
export async function generateVideo(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  imageUrl?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<{ url: string; openUrl?: string; duration?: number }> {
  const requestId = await createVideoTask(input);

  for (let attempt = 1; attempt <= VIDEO_POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(VIDEO_POLL_INTERVAL_MS, input.signal);
    const status = await getVideoTask({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      requestId,
      signal: input.signal,
    });
    input.onProgress?.(status.progress);

    if (status.status === "failed") {
      // 不标 terminal：入队成功后才 failed 的多是审核/基建抖动，grok 审核是概率性的，
      // 同一提示词重试常能过。与图片路径（"响应中没有图片" 同样可重试）保持一致，
      // 是否继续由自动重试开关和停止按钮决定。
      throw new ApiError(
        200,
        describeUpstreamError(status.error?.code, status.error?.message || "视频生成失败"),
        status.error?.code || "video_failed",
      );
    }

    if (status.status === "done") {
      const rawUrl = status.video?.url;
      if (!rawUrl) {
        throw new ApiError(200, "视频完成但未返回地址", "invalid_response");
      }
      rememberUpstreamOrigin(input.baseUrl);

      let display = rawUrl;
      const rewritten = rewriteMediaUrl(rawUrl, input.baseUrl);
      // 图片在 api.ts 的 needsMaterialize 是对改写后 URL 判断；视频必须同样，否则绝对媒体地址
      // 既不走同源代理、也不 blob 化，<video src> 直连上游且带不了 Authorization → invalid_api_key。
      const needsMaterialize =
        isSameOriginMediaPath(rewritten) ||
        /^(blob|data):/i.test(rewritten) === false &&
          (rewritten.includes("/v1/videos/") ||
            rewritten.includes("/v1/media/") ||
            /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\//i.test(rewritten));
      if (needsMaterialize) {
        try {
          display = await materializeImageUrl({
            rawUrl,
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            signal: input.signal,
          });
        } catch (error) {
          log("warn", "视频 blob 化失败，回退直链（依赖 cookie 代理）", error);
          display = rewriteMediaUrl(rawUrl, input.baseUrl);
        }
      } else {
        display = rewritten;
      }

      log("ok", "视频生成完成", { requestId, duration: status.video?.duration });
      return {
        url: display,
        // imageUrl 用 blob 播放；openUrl 必须保留非 blob 地址，刷新后才能重新拉取
        openUrl: rewritten.startsWith("blob:") || rewritten.startsWith("data:") ? undefined : rewritten,
        duration: status.video?.duration,
      };
    }
  }

  throw new ApiError(408, "视频生成超时，请稍后在上游查询任务", "video_timeout");
}

const PROMPT_OPTIMIZE_SYSTEM_LINES = [
  "You are an expert AI image prompt engineer.",
  "Rewrite the user's prompts for text-to-image models.",
  "Rules:",
  "1) Preserve line structure: one prompt per line. Do not merge or drop lines unless a line is empty.",
  "2) Keep the same language the user used when possible; improve clarity, subject, composition, lighting, style.",
  "3) Output ONLY the optimized prompts, plain text, no markdown, no numbering, no quotes, no explanations.",
  "4) Keep each line reasonably concise (under ~400 chars when possible).",
].join("\n");

const PROMPT_OPTIMIZE_SYSTEM_BLOCK = [
  "You are an expert AI image prompt engineer.",
  "Rewrite the user's text as ONE coherent text-to-image prompt.",
  "Rules:",
  "1) Treat the entire input as a single prompt (multi-line input is still one image).",
  "2) You may reorganize into a clear paragraph or a few lines of the same single prompt; do not invent multiple independent scenes.",
  "3) Keep the same language the user used when possible; improve clarity, subject, composition, lighting, style.",
  "4) Output ONLY the optimized prompt, plain text, no markdown, no numbering, no quotes, no explanations.",
].join("\n");

/**
 * 用 chat/completions 优化提示词，返回纯文本（可多行）。
 * mode=lines：按行优化；mode=block：整段作为一条 prompt。
 */
export async function optimizePromptText(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  promptText: string;
  /** lines=按行；block=整段一条 */
  mode?: "lines" | "block";
  signal?: AbortSignal;
}): Promise<string> {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) {
    throw new ApiError(400, "请先在设置页填写「提示词优化模型」", "missing_optimize_model");
  }
  const text = typeof input.promptText === "string" ? input.promptText.trim() : "";
  if (!text) {
    throw new ApiError(400, "请先输入提示词", "empty_prompt");
  }

  const mode = input.mode === "block" ? "block" : "lines";
  log("info", "优化提示词", {
    model,
    mode,
    lines: text.split(/\r?\n/).filter((l) => l.trim()).length,
    baseUrl: input.baseUrl,
  });

  const payload = await apiRequest(input.baseUrl, input.apiKey, "/chat/completions", {
    method: "POST",
    signal: input.signal,
    body: {
      model,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: mode === "block" ? PROMPT_OPTIMIZE_SYSTEM_BLOCK : PROMPT_OPTIMIZE_SYSTEM_LINES,
        },
        { role: "user", content: text },
      ],
    },
  });

  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new ApiError(200, "优化响应格式无效", "invalid_response");
  }

  const first = payload.choices[0];
  if (!isRecord(first)) {
    throw new ApiError(200, "优化响应为空", "invalid_response");
  }

  let content = "";
  if (isRecord(first.message) && typeof first.message.content === "string") {
    content = first.message.content;
  } else if (typeof first.text === "string") {
    content = first.text;
  }

  content = content
    .replace(/^```[\w]*\r?\n?/m, "")
    .replace(/\r?\n?```$/m, "")
    .trim();

  if (!content) {
    throw new ApiError(200, "模型未返回优化结果", "empty_optimize_result");
  }

  log("ok", "提示词已优化", { chars: content.length });
  return content;
}

export { runPool } from "./runPool";
