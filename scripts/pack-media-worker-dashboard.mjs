/**
 * 打包「Cloudflare Dashboard 可直接上传」的 Worker zip：
 * - 仅含预构建 worker.js（无 wrangler.toml，避免 CF 报「需构建/请用 wrangler deploy」）
 * - 配置全部在 CF Variables / Secrets
 *
 * 输出：releases/ciallo-telegram-media-dashboard.zip
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const workerDir = join(root, "workers", "telegram-media");
const outDir = join(root, "releases");
const buildOut = join(outDir, "_cf_dashboard_worker");
const staging = join(outDir, "_pack_dashboard");
const zipPath = join(outDir, "ciallo-telegram-media-dashboard.zip");

function run(cmd, args, cwd) {
  // Windows + 路径含空格：不要 shell:true，避免参数被空格拆开
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

  // 确保 wrangler 可用
  const localWrangler = join(
    workerDir,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  if (!existsSync(localWrangler)) {
    console.log("npm install in workers/telegram-media …");
    runNpm(["install", "--no-fund", "--no-audit"], workerDir);
  }
  if (!existsSync(localWrangler)) {
    console.error("wrangler not found at", localWrangler);
    process.exit(1);
  }

  // 相对 worker 目录的 outdir，避免绝对路径空格问题
  const outRel = join("..", "..", "releases", "_cf_dashboard_worker");
  console.log("node wrangler deploy --dry-run --outdir", outRel);
  run(process.execPath, [localWrangler, "deploy", "--dry-run", "--outdir", outRel], workerDir);

  const built = join(buildOut, "index.js");
  if (!existsSync(built)) {
    console.error("build output missing:", built);
    process.exit(1);
  }

  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // CF Dashboard 上传期望常见入口名：worker.js
  copyFileSync(built, join(staging, "worker.js"));

  writeFileSync(
    join(staging, "README.txt"),
    `Ciallo Telegram Media Worker — Dashboard 上传包
================================================

本 zip 仅含预构建 worker.js，无 wrangler.toml，适合 Cloudflare 网页「上传」。

上传步骤：
1. Cloudflare Dashboard → Workers & Pages → Create → Create Worker
2. 进入 Worker → 右上角 Edit code / 或 Settings → 用「Upload」上传本 zip
   （若界面是「Deploy from repository」请改用本包的「Upload assets / Upload Worker」）
3. Settings → Variables and Secrets 添加：

   Secret（加密）:
     TELEGRAM_BOT_TOKEN   = BotFather Token
     TELEGRAM_CHAT_ID     = 群/频道 ID（如 -100...）
     UPLOAD_TOKEN         = 自设上传口令（建议）
     ALLOWED_ORIGINS      = 可选，CORS 白名单逗号分隔

   Variable（明文）:
     MAX_UPLOAD_BYTES     = 20971520

4. Save and Deploy
5. 复制 Worker 公网 URL 到 Ciallo 管理页「Media Base URL」
   Upload Token 填 UPLOAD_TOKEN

接口：
  GET  /healthz
  POST /v1/upload   (multipart field: file)
  GET  /v1/media/:fileId

注意：若 Dashboard 仍提示不支持 zip，请改用 wrangler：
  见 workers/telegram-media/DEPLOY.md
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
  // 保留 buildOut 便于调试；可删
  // rmSync(buildOut, { recursive: true, force: true });

  console.log("packed:", zipPath, `(${statSync(zipPath).size} bytes)`);
  console.log("contains: worker.js + README.txt only (no wrangler.toml)");
}

main();
