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

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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

function readError(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload)) return {};
  const error = isRecord(payload.error) ? payload.error : payload;
  const code =
    typeof error.code === "string"
      ? error.code
      : typeof error.error_code === "number"
        ? String(error.error_code)
        : typeof error.error_code === "string"
          ? error.error_code
          : typeof payload.status === "number"
            ? String(payload.status)
            : undefined;
  const message =
    (typeof error.message === "string" && error.message) ||
    (typeof error.detail === "string" && error.detail) ||
    (typeof error.title === "string" && error.title) ||
    (typeof payload.detail === "string" && payload.detail) ||
    (typeof payload.title === "string" && payload.title) ||
    undefined;
  return { code, message };
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
    if (mediaPath && (isLoopback || mediaPath.startsWith("/v1/media/"))) {
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
  const headers = new Headers({ Accept: "image/*,application/octet-stream;q=0.9,*/*;q=0.8" });
  if (input.apiKey.trim()) {
    headers.set("Authorization", `Bearer ${input.apiKey.trim()}`);
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
  if (!apiKey.trim()) {
    throw new ApiError(401, "请先在管理页填写 API Key", "missing_api_key");
  }

  const configuredBase = normalizeBaseUrl(baseUrl);
  if (!configuredBase) {
    throw new ApiError(
      400,
      "请先在管理页填写 API Base URL（完整地址，如 https://your-gateway/v1）",
      "missing_base_url",
    );
  }
  const requestBase = resolveBrowserApiBase(baseUrl);
  const origin = resolveUpstreamOrigin(baseUrl);
  const url = joinUrl(baseUrl, path);
  log("info", "请求基址", {
    configuredBase,
    requestBase,
    upstreamOrigin: origin || "(relative)",
    pageOrigin: typeof window !== "undefined" ? window.location.origin : "(ssr)",
  });

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${apiKey.trim()}`,
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
      const err = readError(payload);
      const fallback = text.trim() || response.statusText || `HTTP ${response.status}`;
      const message = err.message ?? fallback;
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

export async function generateImage(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  n?: number;
  aspectRatio?: string;
  resolution?: string;
  signal?: AbortSignal;
}): Promise<ImageResult[]> {
  log("info", "开始生图", {
    model: input.model,
    prompt: input.prompt,
    n: input.n ?? 1,
    aspectRatio: input.aspectRatio ?? "1:1",
    resolution: input.resolution ?? "1k",
    baseUrl: input.baseUrl,
    requestBase: resolveBrowserApiBase(input.baseUrl),
  });

  const payload = await apiRequest(input.baseUrl, input.apiKey, "/images/generations", {
    method: "POST",
    signal: input.signal,
    body: {
      model: input.model,
      prompt: input.prompt,
      n: input.n ?? 1,
      aspect_ratio: input.aspectRatio ?? "1:1",
      resolution: input.resolution ?? "1k",
      response_format: "url",
      stream: false,
    },
  });

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ApiError(200, "生图响应格式无效", "invalid_response");
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
      log("info", "生图返回 URL", { raw: item.url, rewritten });
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
    throw new ApiError(200, "生图响应中没有图片", "invalid_response");
  }

  log("ok", `生图完成 ${images.length} 张`);
  return images;
}

export { runPool } from "./runPool";
