import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
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
        target: "https://grokb.yuzu.gv.uy",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
