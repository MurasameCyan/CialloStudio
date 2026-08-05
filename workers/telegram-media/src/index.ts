/**
 * Ciallo Studio — Telegram 媒体存储 Worker
 *
 * 浏览器/前端只访问本 Worker：
 *   POST /v1/upload      上传图片 → Telegram 超级群/频道 → 返回 mediaId + 访问 URL
 *   GET  /v1/media/:id   按 file_id 从 Telegram 拉文件并流式返回
 *   GET  /healthz        健康检查
 *
 * 密钥：TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / UPLOAD_TOKEN（wrangler secret）
 */

const TG_API = "https://api.telegram.org";

type JsonError = { error: { code: string; message: string } };

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function err(status: number, code: string, message: string, cors: HeadersInit = {}): Response {
  const body: JsonError = { error: { code, message } };
  return json(body, status, cors);
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(env: Env, request: Request): Headers {
  const h = new Headers();
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  h.set("access-control-allow-headers", "authorization, content-type, x-ciallo-upload-token");
  h.set("access-control-max-age", "86400");
  h.set("access-control-expose-headers", "content-type, content-length, cache-control");

  const origin = request.headers.get("origin") || "";
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  if (allowed.length === 0) {
    h.set("access-control-allow-origin", origin || "*");
    if (origin) h.set("vary", "Origin");
  } else if (origin && allowed.includes(origin)) {
    h.set("access-control-allow-origin", origin);
    h.set("vary", "Origin");
  } else if (!origin) {
    // non-browser clients
    h.set("access-control-allow-origin", allowed[0] || "*");
  }
  return h;
}

function withCors(res: Response, cors: Headers): Response {
  const out = new Response(res.body, res);
  cors.forEach((v, k) => out.headers.set(k, v));
  return out;
}

function maxBytes(env: Env): number {
  const n = Number(env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50 * 1024 * 1024) : 20 * 1024 * 1024;
}

function requireSecrets(env: Env): string | null {
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) return "TELEGRAM_BOT_TOKEN not configured";
  if (!env.TELEGRAM_CHAT_ID?.trim()) return "TELEGRAM_CHAT_ID not configured";
  return null;
}

function authorizeUpload(env: Env, request: Request): boolean {
  const expected = env.UPLOAD_TOKEN?.trim();
  if (!expected) return true; // 未配置则开放（仅建议内网/测试）
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() === expected;
  }
  const alt = request.headers.get("x-ciallo-upload-token") || "";
  return alt.trim() === expected;
}

type TgResponse<T> = {
  ok: boolean;
  description?: string;
  result?: T;
};

type TgFile = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

type TgMessage = {
  message_id: number;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  /** 发 mp4 时 Telegram 会把 sendDocument 转成 video 消息 */
  video?: { file_id: string; mime_type?: string; file_size?: number };
  animation?: { file_id: string; mime_type?: string; file_size?: number };
};

async function tgApi<T>(token: string, method: string, init?: RequestInit): Promise<T> {
  const url = `${TG_API}/bot${token}/${method}`;
  const res = await fetch(url, init);
  const data = (await res.json()) as TgResponse<T>;
  if (!data.ok || data.result === undefined) {
    throw new Error(data.description || `Telegram API ${method} failed (${res.status})`);
  }
  return data.result;
}

function pickFileId(
  msg: TgMessage,
): { fileId: string; kind: "document" | "photo" | "video" } | null {
  if (msg.document?.file_id) return { fileId: msg.document.file_id, kind: "document" };
  // mp4 走 sendDocument 也可能回 video/animation，漏掉会误判「未返回 file_id」
  if (msg.video?.file_id) return { fileId: msg.video.file_id, kind: "video" };
  if (msg.animation?.file_id) return { fileId: msg.animation.file_id, kind: "video" };
  if (msg.photo?.length) {
    // 取最大尺寸
    const best = [...msg.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
    if (best?.file_id) return { fileId: best.file_id, kind: "photo" };
  }
  return null;
}

async function readUploadBytes(request: Request, limit: number): Promise<{
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}> {
  const ctype = (request.headers.get("content-type") || "").toLowerCase();

  if (ctype.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") ?? form.get("image") ?? form.get("photo");
    if (!(file instanceof File)) {
      throw new Error("multipart 需字段 file / image / photo");
    }
    if (file.size > limit) throw new Error(`文件过大（上限 ${limit} 字节）`);
    const buf = new Uint8Array(await file.arrayBuffer());
    return {
      bytes: buf,
      filename: file.name || "image.bin",
      contentType: file.type || "application/octet-stream",
    };
  }

  // raw body
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("空请求体");
  if (buf.byteLength > limit) throw new Error(`文件过大（上限 ${limit} 字节）`);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const ext =
    contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("gif")
          ? "gif"
          : contentType.includes("jpeg") || contentType.includes("jpg")
            ? "jpg"
            : contentType.includes("mp4")
              ? "mp4"
              : contentType.includes("webm")
                ? "webm"
                : "bin";
  return { bytes: buf, filename: `upload.${ext}`, contentType };
}

function publicMediaUrl(request: Request, fileId: string): string {
  const u = new URL(request.url);
  return `${u.origin}/v1/media/${encodeURIComponent(fileId)}`;
}

async function handleUpload(request: Request, env: Env, cors: Headers): Promise<Response> {
  const missing = requireSecrets(env);
  if (missing) return withCors(err(500, "config", missing), cors);
  if (!authorizeUpload(env, request)) {
    return withCors(err(401, "unauthorized", "需要有效的上传凭证"), cors);
  }
  if (request.method !== "POST") {
    return withCors(err(405, "method_not_allowed", "仅支持 POST"), cors);
  }

  const limit = maxBytes(env);
  let payload: { bytes: Uint8Array; filename: string; contentType: string };
  try {
    payload = await readUploadBytes(request, limit);
  } catch (e) {
    return withCors(
      err(400, "bad_request", e instanceof Error ? e.message : "读取上传失败"),
      cors,
    );
  }

  const token = env.TELEGRAM_BOT_TOKEN.trim();
  const chatId = env.TELEGRAM_CHAT_ID.trim();

  // 用 document 保真（AI 图常被 sendPhoto 二次压缩）
  // 注意：用独立 ArrayBuffer 视图，避免 SharedArrayBuffer / 偏移问题
  const ab = payload.bytes.buffer.slice(
    payload.bytes.byteOffset,
    payload.bytes.byteOffset + payload.bytes.byteLength,
  ) as ArrayBuffer;
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set(
    "document",
    new Blob([ab], { type: payload.contentType }),
    payload.filename,
  );
  form.set("disable_notification", "true");
  form.set(
    "caption",
    `ciallo-media · ${payload.filename} · ${payload.bytes.byteLength}B · ${new Date().toISOString()}`,
  );

  let message: TgMessage;
  try {
    message = await tgApi<TgMessage>(token, "sendDocument", { method: "POST", body: form });
  } catch (e) {
    return withCors(
      err(502, "telegram_upload_failed", e instanceof Error ? e.message : "Telegram 上传失败"),
      cors,
    );
  }

  const picked = pickFileId(message);
  if (!picked) {
    return withCors(err(502, "telegram_no_file", "Telegram 未返回 file_id"), cors);
  }

  const url = publicMediaUrl(request, picked.fileId);
  return withCors(
    json({
      mediaId: picked.fileId,
      fileId: picked.fileId,
      kind: picked.kind,
      url,
      messageId: message.message_id,
      size: payload.bytes.byteLength,
      contentType: payload.contentType,
      filename: payload.filename,
    }),
    cors,
  );
}

async function handleMediaGet(
  request: Request,
  env: Env,
  cors: Headers,
  fileId: string,
): Promise<Response> {
  const missing = requireSecrets(env);
  if (missing) return withCors(err(500, "config", missing), cors);
  if (!fileId) return withCors(err(400, "bad_request", "缺少 file_id"), cors);

  const token = env.TELEGRAM_BOT_TOKEN.trim();
  let file: TgFile;
  try {
    file = await tgApi<TgFile>(token, "getFile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
  } catch (e) {
    return withCors(
      err(404, "not_found", e instanceof Error ? e.message : "文件不存在"),
      cors,
    );
  }

  if (!file.file_path) {
    return withCors(err(404, "not_found", "Telegram 未返回 file_path"), cors);
  }

  const tgUrl = `${TG_API}/file/bot${token}/${file.file_path}`;
  const upstream = await fetch(tgUrl);
  if (!upstream.ok) {
    return withCors(
      err(502, "telegram_fetch_failed", `拉取 Telegram 文件失败 HTTP ${upstream.status}`),
      cors,
    );
  }

  const headers = new Headers(cors);
  // Telegram 常给 application/octet-stream；优先按 file_path 猜图片 MIME，便于浏览器内联展示
  const guessed = guessMime(file.file_path);
  const upstreamCt = (upstream.headers.get("content-type") || "").toLowerCase();
  const ct =
    guessed !== "application/octet-stream"
      ? guessed
      : upstreamCt.startsWith("image/")
        ? upstreamCt
        : upstreamCt || "image/jpeg";
  headers.set("content-type", ct);
  // 明确 inline，避免被当成附件下载
  headers.set("content-disposition", `inline; filename="ciallo-media${extFromMime(ct)}"`);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (file.file_size) headers.set("content-length", String(file.file_size));
  headers.set("x-ciallo-media-id", fileId);

  return new Response(upstream.body, { status: 200, headers });
}

function guessMime(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".mp4")) return "video/mp4";
  if (p.endsWith(".webm")) return "video/webm";
  if (p.endsWith(".mov")) return "video/quicktime";
  // Telegram 把视频放 videos/ 下，无扩展名时按 mp4 服务，否则 <video> 播不了
  if (/videos\//i.test(p)) return "video/mp4";
  // documents/file_N 无扩展名时，默认按 JPEG 图片服务（Studio 上传多为图）
  if (/\/file_\d+$/i.test(p) || /documents\//i.test(p)) return "image/jpeg";
  return "application/octet-stream";
}

function extFromMime(ct: string): string {
  const t = ct.toLowerCase();
  if (t.includes("png")) return ".png";
  if (t.includes("webp")) return ".webp";
  if (t.includes("gif")) return ".gif";
  if (t.includes("jpeg") || t.includes("jpg")) return ".jpg";
  if (t.includes("mp4")) return ".mp4";
  if (t.includes("webm")) return ".webm";
  if (t.includes("quicktime")) return ".mov";
  return ".bin";
}

function route(pathname: string): { name: "health" | "upload" | "media" | "root"; fileId?: string } | null {
  if (pathname === "/" || pathname === "") return { name: "root" };
  if (pathname === "/healthz" || pathname === "/v1/healthz") return { name: "health" };
  if (pathname === "/v1/upload" || pathname === "/upload") return { name: "upload" };
  const m =
    pathname.match(/^\/v1\/media\/(.+)$/) ||
    pathname.match(/^\/media\/(.+)$/) ||
    pathname.match(/^\/m\/(.+)$/);
  if (m?.[1]) {
    try {
      return { name: "media", fileId: decodeURIComponent(m[1]) };
    } catch {
      return { name: "media", fileId: m[1] };
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const matched = route(url.pathname);
    if (!matched) {
      return withCors(err(404, "not_found", "未知路径"), cors);
    }

    if (matched.name === "root") {
      return withCors(
        json({
          service: "ciallo-telegram-media",
          endpoints: ["GET /healthz", "POST /v1/upload", "GET /v1/media/:fileId"],
        }),
        cors,
      );
    }

    if (matched.name === "health") {
      const configured = !requireSecrets(env);
      return withCors(
        json({
          ok: true,
          telegramConfigured: configured,
          uploadAuth: Boolean(env.UPLOAD_TOKEN?.trim()),
        }),
        cors,
      );
    }

    if (matched.name === "upload") {
      return handleUpload(request, env, cors);
    }

    if (matched.name === "media" && matched.fileId) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return withCors(err(405, "method_not_allowed", "仅支持 GET"), cors);
      }
      return handleMediaGet(request, env, cors, matched.fileId);
    }

    return withCors(err(404, "not_found", "未知路径"), cors);
  },
};
