import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";

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
 * 开发态：同源 /v1 → 按请求头 X-Ciallo-Upstream 转发（与 Docker nginx 行为对齐）。
 * 管理页配置的 Base URL 决定上游，不写死在 .env。
 */
function cialloV1ProxyPlugin(): Plugin {
  return {
    name: "ciallo-v1-dynamic-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
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

function readUpstreamFromRequest(req: IncomingMessage): string {
  const raw = req.headers["x-ciallo-upstream"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header && /^https?:\/\//i.test(header)) {
    try {
      return new URL(header).origin;
    } catch {
      // fall through
    }
  }
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)ciallo_upstream=([^;]+)/);
  if (m?.[1]) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (/^https?:\/\//i.test(decoded)) return new URL(decoded).origin;
    } catch {
      // ignore
    }
  }
  return "";
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

  // 其余自定义头（排除 hop-by-hop）
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

function proxyToUpstream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const origin = readUpstreamFromRequest(req);
    if (!origin) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: {
            message: "缺少上游。请在管理页填写 API Base URL 并测试连接一次。",
            code: "missing_upstream_header",
          },
        }),
      );
      resolve();
      return;
    }

    const path = req.url || "/v1/";
    const targetUrl = new URL(path, origin.endsWith("/") ? origin : `${origin}/`);
    const lib = targetUrl.protocol === "https:" ? https : http;
    const started = Date.now();

    console.log(`[ciallo] proxy ${req.method} ${path} → ${targetUrl.origin}`);

    const headers = pickForwardHeaders(req, targetUrl.host);

    const proxyReq = lib.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
        // 生图可能很长；与 nginx proxy_*_timeout 300s 对齐
        timeout: 300_000,
        // SNI / TLS server name（Cloudflare 需要）
        servername: targetUrl.hostname,
      },
      (proxyRes) => {
        const ms = Date.now() - started;
        const status = proxyRes.statusCode || 502;
        console.log(
          `[ciallo] proxy ← ${status} ${req.method} ${path} (${ms}ms) content-type=${proxyRes.headers["content-type"] || "-"}`,
        );

        // 若上游/CF 已压缩，Node 默认不解压；直接 pipe 时应保留 content-encoding。
        // 但 transfer-encoding / connection 等仍需剥离，避免 writeHead 报错。
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
  },
});
