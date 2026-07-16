import { normalizeBaseUrl } from "./settings";

export type OpenAIModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

export type ImageResult = {
  url: string;
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

/**
 * grok2api 有时会返回内网媒体地址（如 http://127.0.0.1:8000/v1/media/...）。
 * 前端按当前配置的 baseUrl 主机重写，保证图片可访问。
 */
export function rewriteMediaUrl(rawUrl: string, baseUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return value;
  if (value.startsWith("data:") || value.startsWith("blob:")) return value;

  const base = normalizeBaseUrl(baseUrl);

  try {
    if (base.startsWith("/")) {
      const parsed = new URL(value, window.location.origin);
      if (parsed.pathname.startsWith("/v1/media/") || parsed.pathname.startsWith("/media/")) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      if (parsed.origin === window.location.origin) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      // 绝对外链但走同源代理时，尽量映射到 /v1/media
      if (parsed.pathname.includes("/v1/media/")) {
        const idx = parsed.pathname.indexOf("/v1/media/");
        return `${parsed.pathname.slice(idx)}${parsed.search}${parsed.hash}`;
      }
      return value;
    }

    const api = new URL(base.endsWith("/v1") ? base : `${base}/v1`);
    const parsed = new URL(value, api.origin);

    if (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "0.0.0.0" ||
      parsed.pathname.includes("/v1/media/") ||
      parsed.pathname.includes("/media/")
    ) {
      let mediaPath = parsed.pathname;
      const mediaIdx = mediaPath.indexOf("/v1/media/");
      if (mediaIdx >= 0) {
        mediaPath = mediaPath.slice(mediaIdx);
      } else if (mediaPath.startsWith("/media/")) {
        mediaPath = `/v1${mediaPath}`;
      }
      return `${api.origin}${mediaPath}${parsed.search}${parsed.hash}`;
    }

    return parsed.toString();
  } catch {
    return value;
  }
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

  const images = payload.data.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url =
      typeof item.url === "string" && item.url.trim()
        ? rewriteMediaUrl(item.url, input.baseUrl)
        : typeof item.b64_json === "string" && item.b64_json.trim()
          ? `data:${typeof item.mime_type === "string" ? item.mime_type : "image/png"};base64,${item.b64_json}`
          : "";
    if (!url) return [];
    return [
      {
        url,
        b64_json: typeof item.b64_json === "string" ? item.b64_json : undefined,
        revised_prompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
        mime_type: typeof item.mime_type === "string" ? item.mime_type : undefined,
      },
    ];
  });

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
