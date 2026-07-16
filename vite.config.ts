import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  // 读取 .env / .env.local / 系统环境变量（不入库）
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = (
    env.VITE_DEV_PROXY_TARGET ||
    process.env.VITE_DEV_PROXY_TARGET ||
    "https://your-grok2api.example.com"
  )
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");

  const isPlaceholder = /your-grok2api\.example\.com|your-host/i.test(proxyTarget);
  if (isPlaceholder) {
    console.warn(
      `[ciallo] 开发代理仍指向占位上游: ${proxyTarget}\n` +
        `  请先设置真实 grok2api 地址后再 npm run dev，例如 PowerShell:\n` +
        `  $env:VITE_DEV_PROXY_TARGET="https://你的网关"\n` +
        `  或写入 .env.local: VITE_DEV_PROXY_TARGET=https://你的网关`,
    );
  } else {
    console.log(`[ciallo] 开发代理 /v1 → ${proxyTarget}`);
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        // 本地开发：同源代理，绕过浏览器 CORS
        "/v1": {
          target: proxyTarget,
          changeOrigin: true,
          secure: true,
          configure: (proxy) => {
            proxy.on("error", (err, _req, res) => {
              const message =
                `[ciallo] 代理上游失败: ${err.message}\n` +
                `target=${proxyTarget}\n` +
                (isPlaceholder
                  ? "当前是占位域名。请设置 VITE_DEV_PROXY_TARGET 为真实 grok2api 根地址后重启 npm run dev。"
                  : "请检查上游是否在线、DNS/证书/防火墙是否正常。");
              console.error(message);
              if (res && "writeHead" in res && typeof res.writeHead === "function" && !res.headersSent) {
                res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                  JSON.stringify({
                    error: {
                      message,
                      code: "proxy_upstream_unreachable",
                      target: proxyTarget,
                    },
                  }),
                );
              }
            });
          },
        },
      },
    },
  };
});
