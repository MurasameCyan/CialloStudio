import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import {
  debugValidateUpstream,
  readUpstreamRawFromRequest,
  validateUpstreamOrigin,
} from "./server/upstream-guard.mjs";

/** hop-by-hop / 浏览器残留，转发到 Cloudflare 源站时容易把长 POST 搞坏 */
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

/**
 * 开发态：同源 /v1 → 按请求头 X-Ciallo-Upstream 转发（与 Docker 行为对齐）。
 * 管理页配置的 Base URL 决定上游；服务端校验拦截私网/SSRF。
 */
function cialloV1ProxyPlugin(): Plugin {
  return {
    name: "ciallo-v1-dynamic-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        const pathOnly = url.split("?")[0] || "";

        // 调试：GET /debug/upstream?url= 或 /api/upstream-check?url=
        if (pathOnly === "/debug/upstream" || pathOnly === "/api/upstream-check") {
          void (async () => {
            let probe = "";
            try {
              const u = new URL(url, "http://127.0.0.1");
              probe = u.searchParams.get("url") || u.searchParams.get("upstream") || "";
            } catch {
              probe = "";
            }
            if (!probe) {
              probe = readUpstreamRawFromRequest(req as IncomingMessage);
            }
            const detail = await debugValidateUpstream(probe);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ service: "ciallo-vite-proxy", ...detail }, null, 2));
          })().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: { message, code: "debug_failed" } }));
          });
          return;
        }

        if (!url.startsWith("/v1")) {
          next();
          return;
        }
        void proxyToUpstream(req as IncomingMessage, res as ServerResponse).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[ciallo] proxy error", message);
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                error: {
                  message: `本地代理连不上上游：${message}`,
                  code: "proxy_upstream_unreachable",
                },
              }),
            );
          }
        });
      });
    },
  };
}

function pickForwardHeaders(req: IncomingMessage, targetHost: string): Record<string, string> {
  const out: Record<string, string> = {
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
  ] as const;

  for (const key of allow) {
    const v = req.headers[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
    else if (Array.isArray(v) && v[0]) out[key] = v[0];
  }

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (allow.includes(lower as (typeof allow)[number])) continue;
    if (lower.startsWith("sec-") || lower === "cookie" || lower === "origin" || lower === "referer") {
      continue;
    }
    if (typeof value === "string" && value.trim()) out[lower] = value;
  }

  return out;
}

async function proxyToUpstream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = readUpstreamRawFromRequest(req);
  const checked = await validateUpstreamOrigin(raw);
  if (!checked.ok) {
    const status = checked.code === "missing_upstream" ? 400 : 403;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: {
          message:
            checked.message ||
            "上游被拒绝。请使用公网 http(s) API 地址，不要填内网/本机/metadata。",
          code: checked.code || "upstream_blocked",
        },
      }),
    );
    return;
  }

  const origin = checked.origin;
  const path = req.url || "/v1/";
  const targetUrl = new URL(path, origin.endsWith("/") ? origin : `${origin}/`);
  const lib = targetUrl.protocol === "https:" ? https : http;
  const started = Date.now();

  console.log(`[ciallo] proxy ${req.method} ${path} → ${targetUrl.origin}`);

  const headers = pickForwardHeaders(req, targetUrl.host);

  await new Promise<void>((resolve, reject) => {
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
          `[ciallo] proxy ← ${status} ${req.method} ${path} (${ms}ms) content-type=${proxyRes.headers["content-type"] || "-"}`,
        );

        const outHeaders: Record<string, string | number | string[]> = {};
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

export default defineConfig({
  plugins: [react(), cialloV1ProxyPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // 社区默认 http：转发到本机 community-api（node server/community-api.mjs）
    proxy: {
      "/api/community": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
      },
    },
  },
});
