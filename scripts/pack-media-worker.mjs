/**
 * 打包 workers/telegram-media 为可分发 zip（无 node_modules / 无密钥）
 * 输出：releases/ciallo-telegram-media-worker.zip
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const srcDir = join(root, "workers", "telegram-media");
const outDir = join(root, "releases");
const staging = join(outDir, "_pack_telegram_media");
const zipPath = join(outDir, "ciallo-telegram-media-worker.zip");

const include = [
  "package.json",
  "wrangler.toml",
  "tsconfig.json",
  "worker-configuration.d.ts",
  "DEPLOY.md",
  ".gitignore",
  "src/index.ts",
];

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function main() {
  if (!existsSync(srcDir)) {
    console.error("missing", srcDir);
    process.exit(1);
  }
  ensureDir(outDir);
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  ensureDir(join(staging, "src"));

  for (const rel of include) {
    const from = join(srcDir, rel);
    const to = join(staging, rel);
    if (!existsSync(from)) {
      console.warn("skip missing", rel);
      continue;
    }
    ensureDir(dirname(to));
    copyFileSync(from, to);
  }

  // 优先用系统 tar/zip；Windows 用 PowerShell Compress-Archive
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });

  const isWin = process.platform === "win32";
  if (isWin) {
    const ps = `
      $src = '${staging.replace(/'/g, "''")}'
      $dst = '${zipPath.replace(/'/g, "''")}'
      if (Test-Path $dst) { Remove-Item $dst -Force }
      Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -Force
    `;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
      process.exit(r.status || 1);
    }
  } else {
    const r = spawnSync("zip", ["-r", zipPath, "."], { cwd: staging, encoding: "utf8" });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
      process.exit(r.status || 1);
    }
  }

  rmSync(staging, { recursive: true, force: true });
  const size = statSync(zipPath).size;
  console.log("packed:", zipPath, `(${size} bytes)`);
}

main();
