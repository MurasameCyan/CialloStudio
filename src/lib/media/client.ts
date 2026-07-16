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

/** 规范化媒体基址：补 https、去尾斜杠、去路径后缀 /healthz /v1 */
export function normalizeMediaBase(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    // 用户若误填 .../healthz 或 .../v1，剥掉
    u.pathname = u.pathname
      .replace(/\/+$/, "")
      .replace(/\/healthz$/i, "")
      .replace(/\/v1$/i, "");
    if (u.pathname === "/") u.pathname = "";
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return s.replace(/\/+$/, "");
  }
}

export function getMediaBase(): string {
  try {
    const fromLs = localStorage.getItem(LS_BASE)?.trim() || "";
    if (fromLs) return normalizeMediaBase(fromLs);
  } catch {
    // ignore
  }
  const fromRuntime = runtimeMedia().base || "";
  return normalizeMediaBase(fromRuntime);
}

export function setMediaBase(base: string): void {
  localStorage.setItem(LS_BASE, normalizeMediaBase(base));
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
