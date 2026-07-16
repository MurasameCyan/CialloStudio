/**
 * CF Worker 媒体客户端：上传到 Telegram（经 Worker），得到可公开访问的 /v1/media/:id URL。
 * 配置：window.__CIALLO_RUNTIME__.mediaBase / mediaUploadToken
 * 或 localStorage：ciallo-studio.media.base / ciallo-studio.media.uploadToken
 */

const LS_BASE = "ciallo-studio.media.base";
const LS_TOKEN = "ciallo-studio.media.uploadToken";

export type MediaUploadResult = {
  mediaId: string;
  fileId: string;
  url: string;
  size?: number;
  contentType?: string;
  filename?: string;
};

function runtimeMedia(): { base?: string; uploadToken?: string } {
  if (typeof window === "undefined") return {};
  const raw = window.__CIALLO_RUNTIME__ as
    | { mediaBase?: string; mediaUploadToken?: string }
    | undefined;
  return {
    base: typeof raw?.mediaBase === "string" ? raw.mediaBase.trim() : "",
    uploadToken: typeof raw?.mediaUploadToken === "string" ? raw.mediaUploadToken.trim() : "",
  };
}

export function getMediaBase(): string {
  try {
    const fromLs = localStorage.getItem(LS_BASE)?.trim() || "";
    if (fromLs) return fromLs.replace(/\/+$/, "");
  } catch {
    // ignore
  }
  const fromRuntime = runtimeMedia().base || "";
  return fromRuntime.replace(/\/+$/, "");
}

export function setMediaBase(base: string): void {
  localStorage.setItem(LS_BASE, base.trim().replace(/\/+$/, ""));
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

/** 探测 Worker 是否在线 */
export async function pingMediaWorker(): Promise<{ ok: boolean; detail: string }> {
  const base = getMediaBase();
  if (!base) return { ok: false, detail: "未配置 Media Base" };
  try {
    const res = await fetch(`${base}/healthz`, { method: "GET" });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: text || `HTTP ${res.status}` };
    return { ok: true, detail: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
