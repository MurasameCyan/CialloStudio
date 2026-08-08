/**
 * 自动重试判定：视频被上游判 failed 必须可重试（grok 审核是概率性的），
 * 400 这类确定性请求错误必须不可重试（同一 payload 重试必然同样失败）。
 * Run: node scripts/test-auto-retry.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { build } from "esbuild";

/** vite.config 里的 @ → src 别名，esbuild 需要显式给一份 */
const srcDir = fileURLToPath(new URL("../src", import.meta.url));

// 判定用 instanceof ApiError，两个符号必须来自同一 bundle，
// 否则 ApiError 类身份不同、断言会全部走兜底 return true 而假通过。
const entry = new URL("./.tmp-auto-retry-entry.ts", import.meta.url);
await writeFile(
  entry,
  [
    'export { ApiError } from "@/lib/api";',
    'export { isAutoRetryableError } from "@/hooks/useStudioQueue";',
  ].join("\n"),
);

const outfile = new URL("./.tmp-auto-retry-test.mjs", import.meta.url);
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

try {
  const { isAutoRetryableError, ApiError } = await import(`${outfile.href}?t=${Date.now()}`);
  // 自检：若 instanceof 不成立，下面的断言会假通过
  assert.equal(
    isAutoRetryableError(new ApiError(401, "x", "missing_api_key")),
    false,
    "ApiError 类身份不一致，本测试无效",
  );

  // —— 本次修复的主目标：视频上游 failed 可重试 ——
  assert.equal(
    isAutoRetryableError(new ApiError(200, "视频生成失败", "video_failed")),
    true,
    "视频 failed 必须可重试，否则视频模式的自动重试开关等于没有作用",
  );
  assert.equal(
    isAutoRetryableError(new ApiError(200, "内容不符合规范", "content_moderation")),
    true,
    "上游带自己 code 的审核失败同样应重试",
  );

  // —— 图片模式同源缺陷：400 是确定性错误 ——
  assert.equal(
    isAutoRetryableError(new ApiError(400, "prompt 过长", "invalid_request")),
    false,
    "400 重试必然同样失败，会一直循环到用户手动停止",
  );

  // —— 配置类：重试无意义 ——
  for (const err of [
    new ApiError(401, "请先填写 API Key", "missing_api_key"),
    new ApiError(403, "无权限", "forbidden"),
    new ApiError(400, "缺少参考图", "missing_reference_image"),
    new ApiError(400, "请填写视频模型", "missing_video_model"),
    new ApiError(400, "请输入提示词", "empty_prompt"),
  ]) {
    assert.equal(isAutoRetryableError(err), false, `配置类错误不应重试：${err.code}`);
  }

  // —— 显式终态标记仍然生效（服务端 isRetryableError 也依赖它）——
  assert.equal(
    isAutoRetryableError(new ApiError(200, "已明确终态", "whatever", true)),
    false,
    "terminal=true 应优先于 code 判断",
  );

  // —— 可重试：网络、5xx、空图、视频超时 ——
  assert.equal(isAutoRetryableError(new ApiError(0, "网络错误", "network_error")), true);
  assert.equal(isAutoRetryableError(new ApiError(503, "上游暂时不可用", "upstream")), true);
  assert.equal(isAutoRetryableError(new ApiError(200, "响应中没有图片", "invalid_response")), true);
  assert.equal(isAutoRetryableError(new ApiError(408, "视频生成超时", "video_timeout")), true);

  // —— 中止不是失败 ——
  assert.equal(
    isAutoRetryableError(new DOMException("Aborted", "AbortError")),
    false,
    "用户点停止后不应继续重试",
  );

  // —— 两端判定须一致：服务端 import 会直接起 HTTP 服务，改为静态核对源码 ——
  const serverSrc = await readFile(
    new URL("../server/task-queue.mjs", import.meta.url),
    "utf8",
  );
  const predicate = serverSrc.slice(
    serverSrc.indexOf("function isRetryableError"),
    serverSrc.indexOf("/** 可中断 sleep"),
  );
  assert.ok(predicate.length > 0, "未能定位服务端 isRetryableError");
  assert.ok(
    !predicate.includes('code === "video_failed"'),
    "服务端仍把 video_failed 列为不可重试，后台任务的视频重试会与本地不一致",
  );
  assert.ok(
    predicate.includes("status === 400"),
    "服务端应继续排除 400",
  );
  assert.ok(
    predicate.includes("err.terminal === true"),
    "服务端应保留 terminal 逃生口",
  );

  console.log("PASS: auto retry treats video failures as retryable and 400 as terminal");
} finally {
  await unlink(outfile).catch(() => undefined);
  await unlink(entry).catch(() => undefined);
}
