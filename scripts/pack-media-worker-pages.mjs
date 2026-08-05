/**
 * 打包 Cloudflare Pages 直接上传包（无构建、无 wrangler.toml）：
 *   - index.html（占位页）
 *   - _worker.js（预构建的 Telegram 媒体逻辑）
 *
 * 输出：releases/ciallo-telegram-media-pages.zip
 * 部署：Pages → Create → Direct Upload → 上传 zip
 * 配置：Pages → Settings → Environment variables（全部 CF 变量）
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const workerDir = join(root, "workers", "telegram-media");
const outDir = join(root, "releases");
const buildOut = join(outDir, "_cf_pages_build");
const staging = join(outDir, "_pack_pages");
const zipPath = join(outDir, "ciallo-telegram-media-pages.zip");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    process.exit(r.status || 1);
  }
  return r;
}

function runNpm(args, cwd) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npmCmd, args, cwd);
}

function main() {
  mkdirSync(outDir, { recursive: true });
  if (existsSync(buildOut)) rmSync(buildOut, { recursive: true, force: true });
  mkdirSync(buildOut, { recursive: true });

  const localWrangler = join(workerDir, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(localWrangler)) {
    console.log("npm install in workers/telegram-media …");
    runNpm(["install", "--no-fund", "--no-audit"], workerDir);
  }
  if (!existsSync(localWrangler)) {
    console.error("wrangler not found at", localWrangler);
    process.exit(1);
  }

  const outRel = join("..", "..", "releases", "_cf_pages_build");
  console.log("bundle worker →", outRel);
  run(process.execPath, [localWrangler, "deploy", "--dry-run", "--outdir", outRel], workerDir);

  const built = join(buildOut, "index.js");
  if (!existsSync(built)) {
    console.error("build output missing:", built);
    process.exit(1);
  }

  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Pages Advanced Mode: root _worker.js intercepts all routes
  copyFileSync(built, join(staging, "_worker.js"));

  writeFileSync(
    join(staging, "index.html"),
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ciallo Media</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #111; }
      code { background: #f2f2f7; padding: 0.1em 0.35em; border-radius: 6px; }
      a { color: #0a66c2; }
    </style>
  </head>
  <body>
    <h1>Ciallo Telegram Media</h1>
    <p>图片 / 视频存储反代已运行（Cloudflare Pages + <code>_worker.js</code>）。</p>
    <ul>
      <li><a href="/healthz"><code>GET /healthz</code></a></li>
      <li><code>POST /v1/upload</code>（multipart <code>file</code>）</li>
      <li><code>GET /v1/media/:fileId</code></li>
    </ul>
    <p>在 Pages → Settings → Environment variables 配置：
      <code>TELEGRAM_BOT_TOKEN</code>、<code>TELEGRAM_CHAT_ID</code>、<code>UPLOAD_TOKEN</code> 等。
    </p>
  </body>
</html>
`,
    "utf8",
  );

  writeFileSync(
    join(staging, "README.txt"),
    `Ciallo Telegram Media — Cloudflare Pages 直传包
================================================

内容（无构建、无 wrangler.toml）：
  index.html
  _worker.js

部署步骤：
1. https://dash.cloudflare.com/ → Workers & Pages → Create
2. 选择「Pages」→ Upload assets / Direct Upload
3. 项目名例如 ciallo-media
4. 上传本 zip（或解压后拖入文件夹）
5. Deploy site
6. Settings → Environment variables → Production 添加：

   TELEGRAM_BOT_TOKEN   (Secret)  Bot Token
   TELEGRAM_CHAT_ID     (Secret)  群 ID，如 -100...
   UPLOAD_TOKEN         (Secret)  上传口令（建议）
   ALLOWED_ORIGINS      (可选)    CORS 白名单，逗号分隔
   MAX_UPLOAD_BYTES     (可选)    默认 20971520（20 MB）

   注意上传与下载上限不对称：sendDocument 允许 50 MB，但 getFile 只能
   下载 ≤20 MB。调到 52428800 后，20–50 MB 的文件会上传成功却读不回来
   （/v1/media/:id → 404）。可播放的实际上限仍是 20 MB；1080p 长视频
   建议改用 Site 储存（直连上游图站），不要走 TG。

7. 保存后若变量是后加的，点「Retry deployment」或重新 Deploy
8. 公网地址形如：https://ciallo-media.pages.dev
   填到 Ciallo Studio「Media Base URL」
   Upload Token 填 UPLOAD_TOKEN

自检：
  https://你的项目.pages.dev/healthz

说明：
  Pages 的 _worker.js 会处理 API；静态 index.html 仅作说明页。
  图片与视频（mp4/webm/mov）都走 POST /v1/upload；上传一律用 sendDocument
  保真，Telegram 可能把 mp4 转成 video 类型消息，worker 两种都能接。
`,
    "utf8",
  );

  // _headers 可选：Pages 静态头；API 由 worker 自己设 CORS
  writeFileSync(
    join(staging, "_headers"),
    `/healthz
  Cache-Control: no-store

/v1/*
  Cache-Control: no-store
`,
    "utf8",
  );

  if (existsSync(zipPath)) rmSync(zipPath, { force: true });

  if (process.platform === "win32") {
    const ps = `
      $src = '${staging.replace(/'/g, "''")}'
      $dst = '${zipPath.replace(/'/g, "''")}'
      if (Test-Path $dst) { Remove-Item $dst -Force }
      Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -Force
    `;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
      process.exit(r.status || 1);
    }
  } else {
    run("zip", ["-r", zipPath, "."], staging);
  }

  rmSync(staging, { recursive: true, force: true });
  console.log("packed:", zipPath, `(${statSync(zipPath).size} bytes)`);
  console.log("Pages Direct Upload: index.html + _worker.js (no wrangler.toml)");
}

main();
