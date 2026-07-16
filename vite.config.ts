import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";

/**
 * 开发态：同源 /v1 → 按请求头 X-Ciallo-Upstream 转发（与 Docker nginx 行为一致）。
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
            res.end(JSON.stringify({ error: { message, code: "proxy_upstream_unreachable" } }));
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

    console.log(`[ciallo] proxy ${req.method} ${path} → ${targetUrl.origin}`);

    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers.host;
    delete headers["x-ciallo-upstream"];
    headers.host = targetUrl.host;

    const proxyReq = lib.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("end", () => resolve());
      },
    );

    proxyReq.on("error", reject);
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
