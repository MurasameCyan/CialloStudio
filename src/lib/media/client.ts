/**
 * 媒体 / 站点基址客户端。
 * - Media Base：CF Worker → Telegram，分享/持久化用公网 /v1/media/:id
 * - Site Base：上游图片站点根域名（如 https://img.example.com），用于改写 127.0.0.1 媒体链
 * 两个 Base 都只填根域名（无路径）。
 *
 * 配置：window.__CIALLO_RUNTIME__ 或 localStorage
 */

const LS_BASE = "ciallo-studio.media.base";
const LS_TOKEN = "ciallo-studio.media.uploadToken";
const LS_SITE = "ciallo-studio.media.siteBase";
const LS_QUEUE_STORAGE = "ciallo-studio.media.queueStorage";

/** 后台队列出图储存位置 */
export type QueueStorageMode = "media" | "site";

export type MediaUploadResult = {
  mediaId: string;
  fileId: string;
  url: string;
  size?: number;
  contentType?: string;
  filename?: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

function runtimeMedia(): {
  base?: string;
  uploadToken?: string;
  siteBase?: string;
  queueStorageMode?: string;
} {
  if (typeof window === "undefined") return {};
  const raw = window.__CIALLO_RUNTIME__ as
    | {
        mediaBase?: string;
        mediaUploadToken?: string;
        siteBase?: string;
        queueStorageMode?: string;
      }
    | undefined;
  return {
    base: typeof raw?.mediaBase === "string" ? raw.mediaBase.trim() : "",
    uploadToken: typeof raw?.mediaUploadToken === "string" ? raw.mediaUploadToken.trim() : "",
    siteBase: typeof raw?.siteBase === "string" ? raw.siteBase.trim() : "",
    queueStorageMode:
      typeof raw?.queueStorageMode === "string" ? raw.queueStorageMode.trim() : "",
  };
}

/**
 * 规范化根域名基址：补 https、只保留 origin（去掉路径）。
 * Media Base / Site Base 都只填到根域名。
 */
export function normalizeRootBase(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return s.replace(/\/+$/, "");
  }
}

/** @deprecated 使用 normalizeRootBase；保留别名兼容旧调用 */
export function normalizeMediaBase(raw: string): string {
  return normalizeRootBase(raw);
}

export function getMediaBase(): string {
  try {
    const fromLs = localStorage.getItem(LS_BASE)?.trim() || "";
    if (fromLs) return normalizeRootBase(fromLs);
  } catch {
    // ignore
  }
  const fromRuntime = runtimeMedia().base || "";
  return normalizeRootBase(fromRuntime);
}

export function setMediaBase(base: string): void {
  const next = normalizeRootBase(base);
  if (!next) localStorage.removeItem(LS_BASE);
  else localStorage.setItem(LS_BASE, next);
}

export function getSiteBase(): string {
  try {
    const fromLs = localStorage.getItem(LS_SITE)?.trim() || "";
    if (fromLs) return normalizeRootBase(fromLs);
  } catch {
    // ignore
  }
  return normalizeRootBase(runtimeMedia().siteBase || "");
}

export function setSiteBase(base: string): void {
  const next = normalizeRootBase(base);
  if (!next) localStorage.removeItem(LS_SITE);
  else localStorage.setItem(LS_SITE, next);
}

export function normalizeQueueStorageMode(value: unknown): QueueStorageMode {
  return value === "media" ? "media" : "site";
}

export function getQueueStorageMode(): QueueStorageMode {
  try {
    const fromLs = localStorage.getItem(LS_QUEUE_STORAGE);
    if (fromLs === "media" || fromLs === "site") return fromLs;
  } catch {
    // ignore
  }
  const fromRuntime = runtimeMedia().queueStorageMode;
  if (fromRuntime === "media" || fromRuntime === "site") return fromRuntime;
  // 有 Media 无 Site 时默认走 TG；否则默认 Site 改写
  if (getMediaBase() && !getSiteBase()) return "media";
  return "site";
}

export function setQueueStorageMode(mode: QueueStorageMode): void {
  localStorage.setItem(LS_QUEUE_STORAGE, normalizeQueueStorageMode(mode));
}

export function getMediaUploadToken(): string {
  try {
    const fromLs = localStorage.getItem(LS_TOKEN)?.trim() || "";
    if (fromLs) return fromLs;
  } catch {
    // ignore
  }
  return runtimeMedia().uploadToken || "";
}

export function setMediaUploadToken(token: string): void {
  if (!token.trim()) localStorage.removeItem(LS_TOKEN);
  else localStorage.setItem(LS_TOKEN, token.trim());
}

export function isMediaConfigured(): boolean {
  return Boolean(getMediaBase());
}

/**
 * 把上游内网媒体 URL 改写成 Site Base 公网地址。
 * 例：http://127.0.0.1:8000/v1/media/images/img_xxx
 *   → https://img.example.com/v1/media/images/img_xxx
 */
export function rewriteMediaUrlToSiteBase(rawUrl: string, siteBase?: string): string {
  const value = String(rawUrl || "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return value;
  const base = normalizeRootBase(siteBase || getSiteBase());
  if (!base) return value;

  try {
    const parsed = new URL(value, base);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
    const isMediaPath =
      path.includes("/v1/media/") ||
      path.startsWith("/media/") ||
      path.includes("/images/") ||
      path.includes("/videos/");
    if (isLoopback || isMediaPath) {
      return `${base}${path.startsWith("/") ? path : `/${path}`}`;
    }
    return value;
  } catch {
    const replaced = value
      .replace(/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i, "")
      .replace(/^\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i, "");
    if (replaced.startsWith("/")) return `${base}${replaced}`;
    return value;
  }
}

/** 后台队列任务创建时附带的储存配置 */
export function getQueueStorageConfig(): {
  storageMode: QueueStorageMode;
  siteBase: string;
  mediaBase: string;
  mediaUploadToken: string;
} {
  return {
    storageMode: getQueueStorageMode(),
    siteBase: getSiteBase(),
    mediaBase: getMediaBase(),
    mediaUploadToken: getMediaUploadToken(),
  };
}

async function blobFromSource(source: string | Blob): Promise<Blob> {
  if (typeof source !== "string") return source;
  if (source.startsWith("blob:") || source.startsWith("data:") || source.startsWith("http")) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`读取图片失败 HTTP ${res.status}`);
    return res.blob();
  }
  // 同源相对路径
  const res = await fetch(source);
  if (!res.ok) throw new Error(`读取图片失败 HTTP ${res.status}`);
  return res.blob();
}

function guessName(blob: Blob): string {
  const t = blob.type || "";
  if (t.includes("png")) return "image.png";
  if (t.includes("webp")) return "image.webp";
  if (t.includes("gif")) return "image.gif";
  return "image.jpg";
}

/** 上传到 CF Worker → Telegram，返回可访问 URL + mediaId */
export async function uploadMedia(
  source: string | Blob,
  options?: { filename?: string; signal?: AbortSignal },
): Promise<MediaUploadResult> {
  const base = getMediaBase();
  if (!base) {
    throw new Error("未配置媒体 Worker 地址（管理页 Media Base 或 runtime mediaBase）");
  }

  const blob = await blobFromSource(source);
  const form = new FormData();
  form.set("file", blob, options?.filename || guessName(blob));

  const headers = new Headers();
  const token = getMediaUploadToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${base}/v1/upload`, {
    method: "POST",
    headers,
    body: form,
    signal: options?.signal,
  });

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const msg =
      payload &&
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof (payload as { error?: { message?: string } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : text || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const data = payload as Partial<MediaUploadResult>;
  if (!data?.mediaId && !data?.fileId) {
    throw new Error("Worker 未返回 mediaId");
  }
  const mediaId = String(data.mediaId || data.fileId);
  const url = data.url || `${base}/v1/media/${encodeURIComponent(mediaId)}`;
  return {
    mediaId,
    fileId: String(data.fileId || mediaId),
    url,
    size: data.size,
    contentType: data.contentType,
    filename: data.filename,
  };
}

/** 探测 Worker / Pages 是否在线 */
export async function pingMediaWorker(): Promise<{ ok: boolean; detail: string }> {
  const base = getMediaBase();
  if (!base) return { ok: false, detail: "未配置 Media Base" };

  const paths = [`${base}/healthz`, `${base}/v1/healthz`];
  let lastErr = "";

  for (const url of paths) {
    try {
      const res = await fetch(url, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = text || `HTTP ${res.status}`;
        // 404 可能是静态站没有 _worker，继续试另一路径
        if (res.status === 404) continue;
        return { ok: false, detail: lastErr.slice(0, 280) };
      }
      // 期望 JSON 含 ok/telegramConfigured
      try {
        const j = JSON.parse(text) as { ok?: boolean; telegramConfigured?: boolean };
        if (j && typeof j === "object") {
          const tg =
            j.telegramConfigured === true
              ? "Telegram 已配置"
              : j.telegramConfigured === false
                ? "Telegram 未配置密钥"
                : "已响应";
          return { ok: true, detail: `${tg} · ${text.slice(0, 160)}` };
        }
      } catch {
        // 返回了 HTML（常见：Pages 只传了静态页、_worker 未生效）
        if (/<!doctype html>|<html/i.test(text)) {
          return {
            ok: false,
            detail:
              "返回了 HTML 而非 API。Pages 请确认上传了 _worker.js，且项目是 Direct Upload；变量在 Settings → Environment variables",
          };
        }
      }
      return { ok: true, detail: text.slice(0, 200) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;
      // Failed to fetch：DNS / 断网 / 混合内容 / CORS 预检失败
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        return {
          ok: false,
          detail: [
            "Failed to fetch（浏览器连不上该地址）",
            `当前 Base: ${base}`,
            "排查：",
            "1) 浏览器新标签打开 Base+/healthz，是否 200 JSON？",
            "2) Pages 项目名是否对应真实 *.pages.dev（DNS 失败=未部署/名错）",
            "3) 必须 https:// 开头；不要填 workers 上传失败的错误域名",
            "4) 本机代理/防火墙是否拦截 Cloudflare",
          ].join("\n"),
        };
      }
    }
  }

  return { ok: false, detail: lastErr || "探测失败" };
}
