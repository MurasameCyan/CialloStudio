/**
 * 上游错误体解析 + 审核类失败的重试策略。
 *
 * grokb 的错误体不是 OpenAI 格式，是顶层平铺且 error 为字符串：
 *   {"code":"imagine:content-moderated","error":"Generated image rejected by content moderation."}
 * 旧解析取 json.error.code（对字符串取属性得 undefined），真实 code 被吞成 upstream_error，
 * message 则回退成整段原始 JSON 甩给用户。
 *
 * 审核发生在出图之后，同一 prompt 不同 seed 结果不同（实测 8 次 5 拦 3 过），
 * 所以属于可重试；但明确违规的 prompt 是稳定拦（6/6），必须有次数上限兜底。
 *
 * Run: node scripts/test-upstream-error-parse.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

const entry = new URL("./.tmp-upstream-error-entry.ts", import.meta.url);
await writeFile(
  entry,
  [
    'export { ApiError, readUpstreamError, describeUpstreamError, isContentModerationCode } from "@/lib/api";',
    'export { isAutoRetryableError, MODERATION_MAX_ATTEMPTS } from "@/hooks/useStudioQueue";',
  ].join("\n"),
);

const outfile = new URL("./.tmp-upstream-error-test.mjs", import.meta.url);
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
  const {
    ApiError,
    readUpstreamError,
    describeUpstreamError,
    isContentModerationCode,
    isAutoRetryableError,
    MODERATION_MAX_ATTEMPTS,
  } = await import(`${outfile.href}?t=${Date.now()}`);

  // —— grokb 实测错误体：顶层 code + error 是字符串 ——
  const moderated = {
    code: "imagine:content-moderated",
    error: "Generated image rejected by content moderation.",
  };
  const parsed = readUpstreamError(moderated);
  assert.equal(parsed.code, "imagine:content-moderated", "顶层 code 必须读出来");
  assert.equal(
    parsed.message,
    "Generated image rejected by content moderation.",
    "error 为字符串时应当作 message，否则会回退成整段 JSON",
  );

  // —— 仍要兼容 OpenAI 嵌套格式 ——
  const openai = readUpstreamError({
    error: { code: "invalid_request_error", message: "prompt too long" },
  });
  assert.equal(openai.code, "invalid_request_error");
  assert.equal(openai.message, "prompt too long");

  // error 是对象但没 message 时，不要把对象当 message
  const weird = readUpstreamError({ code: "x", error: { foo: 1 } });
  assert.equal(weird.code, "x");
  assert.equal(weird.message, undefined);

  assert.deepEqual(readUpstreamError(null), {});
  assert.deepEqual(readUpstreamError("boom"), {});

  // —— 审核 code 识别 ——
  assert.equal(isContentModerationCode("imagine:content-moderated"), true);
  assert.equal(isContentModerationCode("content_moderation"), true);
  assert.equal(isContentModerationCode("CONTENT-MODERATED"), true);
  assert.equal(isContentModerationCode("invalid_request"), false);
  assert.equal(isContentModerationCode(undefined), false);

  // —— 中文映射：审核类错误不该把英文原文/JSON 甩给用户 ——
  const zh = describeUpstreamError("imagine:content-moderated", moderated.error);
  assert.ok(/审核/.test(zh), `审核错误应映射为中文提示，实际：${zh}`);
  assert.ok(
    !/Generated image rejected/.test(zh),
    "映射后不应再包含英文原文",
  );
  // 非审核错误保持原样，不要吃掉上游信息
  assert.equal(describeUpstreamError("invalid_request", "prompt too long"), "prompt too long");
  assert.equal(describeUpstreamError(undefined, "boom"), "boom");

  // —— 审核类失败：开着自动重试就该重试，但有上限 ——
  const modErr = new ApiError(400, zh, "imagine:content-moderated");
  assert.ok(MODERATION_MAX_ATTEMPTS >= 2, "审核重试上限至少要允许重试一次");
  for (let attempt = 1; attempt < MODERATION_MAX_ATTEMPTS; attempt += 1) {
    assert.equal(
      isAutoRetryableError(modErr, attempt),
      true,
      `第 ${attempt} 次审核失败应重试：审核查的是出图结果，换 seed 常能过`,
    );
  }
  assert.equal(
    isAutoRetryableError(modErr, MODERATION_MAX_ATTEMPTS),
    false,
    "达到上限必须停：明确违规的 prompt 是稳定被拦，否则无上限循环刷上游",
  );

  // 其它 400 依旧一次都不重试
  assert.equal(
    isAutoRetryableError(new ApiError(400, "prompt 过长", "invalid_request"), 1),
    false,
    "非审核的 400 仍是确定性错误",
  );
  // terminal 逃生口优先于审核放行
  assert.equal(
    isAutoRetryableError(new ApiError(400, "x", "imagine:content-moderated", true), 1),
    false,
    "terminal=true 应优先",
  );
  // 不传 attempt 时按首次处理，保持旧调用点行为
  assert.equal(isAutoRetryableError(modErr), true);

  // —— 服务端须与浏览器端一致：import 会起 HTTP 服务，改为静态核对源码 ——
  const serverSrc = await readFile(new URL("../server/task-queue.mjs", import.meta.url), "utf8");
  assert.ok(
    serverSrc.includes("MODERATION_MAX_ATTEMPTS"),
    "服务端缺少审核重试上限，后台任务与本地行为会不一致",
  );
  assert.ok(
    new RegExp(`MODERATION_MAX_ATTEMPTS\\s*=\\s*${MODERATION_MAX_ATTEMPTS}\\b`).test(serverSrc),
    `服务端审核重试上限应与浏览器端一致（${MODERATION_MAX_ATTEMPTS}）`,
  );
  assert.ok(
    serverSrc.includes("isContentModerationCode"),
    "服务端应识别审核 code 才能放行重试",
  );
  assert.ok(
    /typeof\s+\w+\??\.?\w*\s*===\s*"string"/.test(serverSrc) &&
      serverSrc.includes("readUpstreamErrorBody"),
    "服务端应有统一的错误体解析（含 error 为字符串的情况）",
  );

  console.log("PASS: upstream error parsing + bounded moderation retry");
} finally {
  await unlink(outfile).catch(() => undefined);
  await unlink(entry).catch(() => undefined);
}
