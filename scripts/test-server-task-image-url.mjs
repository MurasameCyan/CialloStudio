/**
 * 后台任务 imageUrl 的前端兜底改写。
 *
 * 服务端 finalizeTaskImageUrl 已按 storageMode 固化好可访问地址：
 * Media 模式返回 Worker 公网链（如 https://imgapi.example/v1/media/<tgFileId>）。
 * 前端只该给「仍是 loopback」的地址兜底换成 Site Base——
 * 但 rewriteMediaUrlToSiteBase 的条件是 isLoopback || isMediaPath，
 * 于是已经固化好的 Worker 链也被换成 Site Base 域名，图片全 404。
 *
 * Run: node scripts/test-server-task-image-url.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

const entry = new URL("./.tmp-task-image-url-entry.ts", import.meta.url);
await writeFile(
  entry,
  'export { resolveServerTaskImageUrl } from "@/hooks/useStudioQueue";\n',
);

const outfile = new URL("./.tmp-task-image-url-test.mjs", import.meta.url);
await build({
  entryPoints: [fileURLToPath(entry)],
  outfile: fileURLToPath(outfile),
  bundle: true,
  platform: "browser",
  format: "esm",
  logLevel: "silent",
  alias: { "@": srcDir },
  external: ["react", "react-dom"],
});

const SITE = "https://img.example";
const WORKER = "https://imgapi.example";

try {
  // 管理页存的 Site Base 走 localStorage；给 esbuild 产物一个最小 stub
  globalThis.localStorage = {
    _v: new Map([["ciallo-studio.media.siteBase", SITE]]),
    getItem(k) {
      return this._v.has(k) ? this._v.get(k) : null;
    },
    setItem(k, v) {
      this._v.set(k, String(v));
    },
    removeItem(k) {
      this._v.delete(k);
    },
  };

  const { resolveServerTaskImageUrl } = await import(`${outfile.href}?t=${Date.now()}`);

  // 自检：Site Base 必须真的生效，否则下面的断言会因「读不到配置直接原样返回」而假通过
  const loopback = resolveServerTaskImageUrl(`http://127.0.0.1:8000/v1/media/abc`);
  assert.equal(
    loopback,
    `${SITE}/v1/media/abc`,
    `Site Base 未生效，本测试无效（实际：${loopback}）。需确认 stub 的存储键与 getSiteBase 一致`,
  );

  // —— 主目标：Media 模式固化的 Worker 公网链不能被换域名 ——
  const tgFileId = "BQACAgEAAyEGAAMBBiYzTQADcmp7akMThGeUHNjkxx808pL5CJx6";
  const workerUrl = `${WORKER}/v1/media/${tgFileId}`;
  assert.equal(
    resolveServerTaskImageUrl(workerUrl),
    workerUrl,
    "Worker 公网链必须原样保留：换成 Site Base 域名后 TG file_id 会被拿去问图片站，必然 404",
  );

  // 视频同理
  const workerVideo = `${WORKER}/v1/media/${tgFileId}?kind=video`;
  assert.equal(resolveServerTaskImageUrl(workerVideo), workerVideo, "Worker 视频链同样保留");

  // —— 仍要保留的兜底：loopback 换成 Site Base ——
  for (const host of ["127.0.0.1:8000", "localhost:8000", "0.0.0.0:8000"]) {
    assert.equal(
      resolveServerTaskImageUrl(`http://${host}/v1/media/xyz`),
      `${SITE}/v1/media/xyz`,
      `${host} 这类内网地址浏览器打不开，必须换成 Site Base`,
    );
  }
  assert.equal(
    resolveServerTaskImageUrl("http://127.0.0.1:8000/images/gen_1.png"),
    `${SITE}/images/gen_1.png`,
    "loopback 的非 media 路径也该兜底",
  );

  // —— 其它公网域名一律不动（Site Base 自己的链、上游直链）——
  assert.equal(
    resolveServerTaskImageUrl(`${SITE}/v1/media/abc`),
    `${SITE}/v1/media/abc`,
    "已是 Site Base 的链不该被改动",
  );
  assert.equal(
    resolveServerTaskImageUrl("https://grokb.example/v1/media/img_abc"),
    "https://grokb.example/v1/media/img_abc",
    "上游公网直链不该被改写成 Site Base，否则同样取不到",
  );

  // —— data / blob / 空值 ——
  assert.equal(resolveServerTaskImageUrl("data:image/png;base64,AAA"), "data:image/png;base64,AAA");
  assert.equal(resolveServerTaskImageUrl("blob:http://x/y"), "blob:http://x/y");
  assert.equal(resolveServerTaskImageUrl(""), undefined);
  assert.equal(resolveServerTaskImageUrl("   "), undefined);
  assert.equal(resolveServerTaskImageUrl(undefined), undefined);

  // —— 后台任务面板（站长「打开」链接）必须同源处理 ——
  const panelSrc = await readFile(
    new URL("../src/components/AdminTaskQueuePanel.tsx", import.meta.url),
    "utf8",
  );
  const resolveImageFn = panelSrc.slice(
    panelSrc.indexOf("function resolveImage"),
    panelSrc.indexOf("function promptPreview"),
  );
  assert.ok(resolveImageFn.length > 0, "未能定位 AdminTaskQueuePanel 的 resolveImage");
  assert.ok(
    resolveImageFn.includes("isLoopbackUrl"),
    "后台任务面板的 resolveImage 也必须只给 loopback 兜底，否则站长「打开」拿到的还是坏链",
  );

  // —— 服务端 site 模式仍应使用 Site Base（media 模式已提前 return，不受影响）——
  const serverSrc = await readFile(new URL("../server/task-queue.mjs", import.meta.url), "utf8");
  const finalize = serverSrc.slice(
    serverSrc.indexOf("async function finalizeTaskImageUrl"),
    serverSrc.indexOf("function httpRequestJson"),
  );
  assert.ok(finalize.length > 0, "未能定位 finalizeTaskImageUrl");
  assert.ok(
    finalize.indexOf('mode === "media"') < finalize.indexOf("rewriteMediaUrlToSiteBase"),
    "media 模式必须在 Site Base 改写之前 return，否则服务端就会把 Worker 链改坏",
  );

  console.log("PASS: server task imageUrl keeps worker links, only rewrites loopback");
} finally {
  await unlink(outfile).catch(() => undefined);
  await unlink(entry).catch(() => undefined);
}
