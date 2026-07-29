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
      path.includes("/v1/media/") || path.startsWith("/media/") || path.includes("/images/");
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

console.log("media root base / site rewrite ok");
