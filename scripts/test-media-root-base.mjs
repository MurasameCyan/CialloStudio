/** 纯 JS：根域名规范化 + Site Base 改写 loopback 媒体链 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

function normalizeRootBase(raw) {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    return new URL(s).origin;
  } catch {
    return s.replace(/\/+$/, "");
  }
}

function rewriteMediaUrlToSiteBase(rawUrl, siteBase) {
  const value = String(rawUrl || "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return value;
  const base = normalizeRootBase(siteBase);
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

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

assert(normalizeRootBase("https://img.example.com/v1") === "https://img.example.com", "strip /v1");
assert(normalizeRootBase("img.example.com") === "https://img.example.com", "add https");
assert(normalizeRootBase("https://img.example.com/") === "https://img.example.com", "trim slash");

const raw = "http://127.0.0.1:8000/v1/media/images/img_kQj6Y6e6JjWWIjAg0YUMSqSp-nhUycLm";
const site = "https://img.example.com";
assert(
  rewriteMediaUrlToSiteBase(raw, site) ===
    "https://img.example.com/v1/media/images/img_kQj6Y6e6JjWWIjAg0YUMSqSp-nhUycLm",
  "rewrite loopback media",
);
assert(rewriteMediaUrlToSiteBase("data:image/png;base64,aaa", site).startsWith("data:"), "keep data");
assert(rewriteMediaUrlToSiteBase(raw, "") === raw, "no site keeps raw");

// 视频：上游走 /videos/ 路径，漏掉会导致后台队列出的视频停在 loopback 地址播不了
assert(
  rewriteMediaUrlToSiteBase("http://127.0.0.1:8000/v1/videos/vid_abc.mp4", site) ===
    "https://img.example.com/v1/videos/vid_abc.mp4",
  "rewrite loopback video",
);
assert(
  rewriteMediaUrlToSiteBase("https://upstream.example.org/videos/vid_abc.mp4", site) ===
    "https://img.example.com/videos/vid_abc.mp4",
  "rewrite remote video path",
);

// —— 上传文件名按 MIME 推断（视频不能落成 image.png，否则 TG 存成图、<video> 播不了）——
function guessUploadFilename(contentType, fallback = "image.png") {
  const t = String(contentType || "").toLowerCase();
  if (t.includes("mp4")) return "video.mp4";
  if (t.includes("webm")) return "video.webm";
  if (t.includes("quicktime") || t.includes("mov")) return "video.mov";
  if (t.includes("jpeg") || t.includes("jpg")) return "image.jpg";
  if (t.includes("webp")) return "image.webp";
  if (t.includes("gif")) return "image.gif";
  if (t.includes("png")) return "image.png";
  return fallback;
}

assert(guessUploadFilename("video/mp4") === "video.mp4", "mp4 filename");
assert(guessUploadFilename("video/webm") === "video.webm", "webm filename");
assert(guessUploadFilename("image/jpeg") === "image.jpg", "jpeg filename");
assert(guessUploadFilename("", "video.mp4") === "video.mp4", "video fallback");
assert(guessUploadFilename("application/octet-stream") === "image.png", "image fallback");

// —— Telegram file_path → MIME（mp4 被识别成图片时 <video> 直接播不了）——
function guessMime(p0) {
  const p = String(p0 || "").toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".mp4")) return "video/mp4";
  if (p.endsWith(".webm")) return "video/webm";
  if (p.endsWith(".mov")) return "video/quicktime";
  if (/videos\//i.test(p)) return "video/mp4";
  if (/\/file_\d+$/i.test(p) || /documents\//i.test(p)) return "image/jpeg";
  return "application/octet-stream";
}

assert(guessMime("videos/file_12.mp4") === "video/mp4", "tg video ext");
// Telegram 常给 videos/file_N 无扩展名：必须仍判成视频，不能落到 documents→jpeg 分支
assert(guessMime("videos/file_12") === "video/mp4", "tg video no ext");
assert(guessMime("documents/file_9") === "image/jpeg", "tg doc defaults image");
assert(guessMime("photos/file_3.jpg") === "image/jpeg", "tg photo ext");

// —— 上游视频时长白名单（上游只接受 6/10/15）——
const pickDuration = (v) => ([6, 10, 15].includes(Number(v)) ? Number(v) : 6);
assert(pickDuration(10) === 10, "duration 10");
assert(pickDuration("15") === 15, "duration string coerced");
assert(pickDuration(7) === 6, "invalid duration falls back");
assert(pickDuration(undefined) === 6, "missing duration falls back");

console.log("media root base / site rewrite / video mime ok");
