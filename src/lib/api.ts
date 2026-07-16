import { normalizeBaseUrl } from "./settings";

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

function joinUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (base.startsWith("/")) {
    return `${base}${cleanPath}`;
  }
  return `${base}${cleanPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload)) return {};
  const error = isRecord(payload.error) ? payload.error : payload;
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
  };
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

  const base = normalizeBaseUrl(baseUrl);
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
  const headers = new Headers({ Accept: "image/*,application/octet-stream;q=0.9,*/*;q=0.8" });
  if (input.apiKey.trim()) {
    headers.set("Authorization", `Bearer ${input.apiKey.trim()}`);
  }

  const response = await fetch(rewritten, {
    method: "GET",
    headers,
    signal: input.signal,
  });
  if (!response.ok) {
    throw new ApiError(response.status, `图片资源拉取失败 (${response.status})`, "media_fetch_failed");
  }

  const blob = await response.blob();
  if (!blob.size) {
    throw new ApiError(200, "图片资源为空", "media_empty");
  }
  return URL.createObjectURL(blob);
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

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${apiKey.trim()}`,
  });

  let body: string | undefined;
  if (init.body) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }

  const response = await fetch(joinUrl(baseUrl, path), {
    method: init.method ?? "GET",
    headers,
    body,
    signal: init.signal,
  });

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
    throw new ApiError(response.status, err.message ?? fallback, err.code);
  }

  if (payload === null) {
    throw new ApiError(response.status, "接口返回了非 JSON 响应", "invalid_response");
  }

  return payload;
}

export async function listModels(input: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<OpenAIModel[]> {
  const payload = await apiRequest(input.baseUrl, input.apiKey, "/models", {
    method: "GET",
    signal: input.signal,
  });

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ApiError(200, "模型列表格式无效", "invalid_response");
  }

  return payload.data.flatMap((item) => {
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
      // 优先物化为 blob，避免 <img> 直接请求内网/跨域地址
      let displayUrl = rewritten;
      try {
        displayUrl = await materializeImageUrl({
          rawUrl: item.url,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          signal: input.signal,
        });
      } catch {
        displayUrl = rewritten;
      }
      images.push({
        url: displayUrl,
        openUrl: rewritten,
        revised_prompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
        mime_type: typeof item.mime_type === "string" ? item.mime_type : undefined,
      });
    }
  }

  if (images.length === 0) {
    throw new ApiError(200, "生图响应中没有图片", "invalid_response");
  }

  return images;
}

export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onItemSettled?: (index: number, result: PromiseSettledResult<R>) => void,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      try {
        const value = await worker(items[current], current);
        results[current] = { status: "fulfilled", value };
        onItemSettled?.(current, results[current]);
      } catch (error) {
        results[current] = { status: "rejected", reason: error };
        onItemSettled?.(current, results[current]);
      }
    }
  }

  const size = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: size }, () => runOne()));
  return results;
}
