/**
 * 生产态 /v1 动态上游代理（带 SSRF 防护）。
 * 监听 127.0.0.1:CIALLO_V1_PROXY_PORT（默认 8091），由 Nginx 反代。
 * 上游仍由请求头 X-Ciallo-Upstream 或 cookie ciallo_upstream 指定。
 * 内网上游需 CIALLO_UPSTREAM_ALLOWLIST；调试：GET /debug/upstream?url=
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import {
  debugValidateUpstream,
  parseUpstreamAllowlist,
  readUpstreamRawFromRequest,
  validateUpstreamOrigin,
} from "./upstream-guard.mjs";

const PORT = Number(process.env.CIALLO_V1_PROXY_PORT || 8091);
const HOST = process.env.CIALLO_V1_PROXY_HOST || "127.0.0.1";
const DEBUG_UPSTREAM =
  String(process.env.CIALLO_DEBUG_UPSTREAM || "1").trim() !== "0";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "x-ciallo-upstream",
]);

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function pickForwardHeaders(req, targetHost) {
  const out = {
    host: targetHost,
    connection: "close",
  };
  const allow = [
    "authorization",
    "content-type",
    "accept",
    "accept-language",
    "user-agent",
    "x-request-id",
  ];
  for (const key of allow) {
    const v = req.headers[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
    else if (Array.isArray(v) && v[0]) out[key] = v[0];
  }
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (allow.includes(lower)) continue;
    if (lower.startsWith("sec-") || lower === "cookie" || lower === "origin" || lower === "referer") {
      continue;
    }
    if (typeof value === "string" && value.trim()) out[lower] = value;
  }
  return out;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} origin
 */
function proxyToUpstream(req, res, origin) {
  return new Promise((resolve, reject) => {
    const path = req.url || "/v1/";
    const targetUrl = new URL(path, origin.endsWith("/") ? origin : `${origin}/`);
    const lib = targetUrl.protocol === "https:" ? https : http;
    const started = Date.now();

    console.log(`[v1-proxy] ${req.method} ${path} → ${targetUrl.origin}`);

    const headers = pickForwardHeaders(req, targetUrl.host);
    const proxyReq = lib.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
        timeout: 300_000,
        servername: targetUrl.hostname,
      },
      (proxyRes) => {
        const ms = Date.now() - started;
        const status = proxyRes.statusCode || 502;
        console.log(
          `[v1-proxy] ← ${status} ${req.method} ${path} (${ms}ms) content-type=${proxyRes.headers["content-type"] || "-"}`,
        );

        const outHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value == null) continue;
          const lower = key.toLowerCase();
          if (
            lower === "connection" ||
            lower === "keep-alive" ||
            lower === "transfer-encoding" ||
            lower === "proxy-authenticate" ||
            lower === "proxy-authorization" ||
            lower === "te" ||
            lower === "trailers" ||
            lower === "upgrade"
          ) {
            continue;
          }
          outHeaders[key] = value;
        }

        res.writeHead(status, outHeaders);
        proxyRes.pipe(res);
        proxyRes.on("end", () => resolve());
        proxyRes.on("error", reject);
      },
    );

    proxyReq.on("timeout", () => {
      proxyReq.destroy(new Error("upstream timeout (300s)"));
    });
    proxyReq.on("error", reject);
    req.on("error", (err) => {
      proxyReq.destroy();
      reject(err);
    });
    req.pipe(proxyReq);
  });
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Ciallo-Upstream, Accept",
    });
    res.end();
    return;
  }

  const url = req.url || "/";
  const pathOnly = url.split("?")[0] || "/";

  if (pathOnly === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "ciallo-v1-proxy",
      allowlistCount: parseUpstreamAllowlist().length,
      debugUpstream: DEBUG_UPSTREAM,
    });
    return;
  }

  // 调试：校验某个上游是否会被放行（不发起代理请求）
  if (pathOnly === "/debug/upstream" || pathOnly === "/api/upstream-check") {
    if (!DEBUG_UPSTREAM) {
      sendJson(res, 404, {
        error: { code: "not_found", message: "上游调试已关闭（CIALLO_DEBUG_UPSTREAM=0）" },
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, {
        error: { code: "method_not_allowed", message: "仅支持 GET" },
      });
      return;
    }
    let probe = "";
    try {
      const u = new URL(url, "http://127.0.0.1");
      probe = u.searchParams.get("url") || u.searchParams.get("upstream") || "";
    } catch {
      probe = "";
    }
    if (!probe) {
      probe = readUpstreamRawFromRequest(req);
    }
    const detail = await debugValidateUpstream(probe);
    sendJson(res, 200, {
      service: "ciallo-v1-proxy",
      ...detail,
    });
    return;
  }

  if (!url.startsWith("/v1")) {
    sendJson(res, 404, {
      error: { code: "not_found", message: "仅代理 /v1/*；调试见 GET /debug/upstream?url=" },
    });
    return;
  }

  const raw = readUpstreamRawFromRequest(req);
  const checked = await validateUpstreamOrigin(raw);
  if (!checked.ok) {
    const status = checked.code === "missing_upstream" ? 400 : 403;
    sendJson(res, status, {
      error: {
        code: checked.code || "upstream_blocked",
        message:
          checked.message ||
          "上游被拒绝。请使用公网 http(s) API，或把内网地址写入 CIALLO_UPSTREAM_ALLOWLIST。",
      },
    });
    return;
  }

  try {
    await proxyToUpstream(req, res, checked.origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[v1-proxy] error", message);
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: {
          message: `代理连不上上游：${message}`,
          code: "proxy_upstream_unreachable",
        },
      });
    }
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, HOST, () => {
  const allow = parseUpstreamAllowlist();
  console.log(
    `[v1-proxy] listening ${HOST}:${PORT} allowlist=${allow.length} debug=${DEBUG_UPSTREAM ? "on" : "off"}`,
  );
  if (allow.length) {
    console.log(`[v1-proxy] CIALLO_UPSTREAM_ALLOWLIST: ${allow.join(", ")}`);
  }
});
