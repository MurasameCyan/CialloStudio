/**
 * 上游错误体解析 + 审核类失败的重试策略。
 *
 * grokb 的错误体不是 OpenAI 格式，是顶层平铺且 error 为字符串：
 *   {"code":"imagine:content-moderated","error":"Generated image rejected by content moderation."}
 * 旧解析取 json.error.code（对字符串取属性得 undefined），真实 code 被吞成 upstream_error，
 * message 则回退成整段原始 JSON 甩给用户。
 *
 * 审核发生在出图之后，同一 prompt 不同 seed 结果不同（实测 8 次 5 拦 3 过），
 * 所以开着自动重试就无条件重试；何时收手由停止按钮和任务超时决定，
 * 不用写死的次数上限——否则自动重试开关对审核这种最需要它的场景形同虚设。
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
    'export { isAutoRetryableError } from "@/hooks/useStudioQueue";',
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

  // —— 审核类失败：开着自动重试就无条件重试，不设次数上限 ——
  // 审核查的是出图结果，换 seed 常能过；何时收手由停止按钮和任务超时决定，
  // 而不是一个写死的次数——否则自动重试开关对审核这种最需要它的场景形同虚设。
  const modErr = new ApiError(400, zh, "imagine:content-moderated");
  assert.equal(isAutoRetryableError(modErr), true, "审核失败必须可重试");
  assert.equal(
    isAutoRetryableError(new ApiError(400, zh, "content_moderation")),
    true,
    "其它写法的审核 code 同样可重试",
  );

  // 其它 400 依旧一次都不重试
  assert.equal(
    isAutoRetryableError(new ApiError(400, "prompt 过长", "invalid_request")),
    false,
    "非审核的 400 仍是确定性错误",
  );
  // terminal 逃生口优先于审核放行
  assert.equal(
    isAutoRetryableError(new ApiError(400, "x", "imagine:content-moderated", true)),
    false,
    "terminal=true 应优先",
  );

  /* —— 视频审核：实测上游把 code 写成 internal_error，审核信息只在 message 里 ——
     GET /videos/{id} 返回：
       {"error":{"code":"internal_error","message":"Console 媒体上游返回 400: Generated video rejected by content moderation."},"status":"failed"}
     只看 code 的话这条永远翻不成中文，用户会看到一句中英混杂的上游原文。 */
  const videoModerated = {
    error: {
      code: "internal_error",
      message: "Console 媒体上游返回 400: Generated video rejected by content moderation.",
    },
    status: "failed",
  };
  const videoParsed = readUpstreamError(videoModerated);
  assert.equal(videoParsed.code, "internal_error");
  assert.equal(
    isContentModerationCode(videoParsed.code, videoParsed.message),
    true,
    "审核信息只在 message 里时也必须识别为审核拦截",
  );
  const videoZh = describeUpstreamError(videoParsed.code, videoParsed.message);
  assert.ok(/审核/.test(videoZh), `视频审核错误应映射为中文提示，实际：${videoZh}`);
  assert.ok(
    !/rejected by content moderation/.test(videoZh),
    "映射后不应再包含上游英文原文",
  );
  // message 不含审核字样的 internal_error 是真基建错误，别误判成审核、也别吃掉原文
  assert.equal(isContentModerationCode("internal_error", "upstream timeout"), false);
  assert.equal(describeUpstreamError("internal_error", "upstream timeout"), "upstream timeout");
  // 翻译后的中文提示要仍被认作审核，否则重试判定在映射后失效
  assert.equal(
    isContentModerationCode(undefined, videoZh),
    true,
    "已映射的中文提示也要认，否则翻译后重试判定失效",
  );
  assert.equal(
    isAutoRetryableError(new ApiError(200, videoZh, "internal_error")),
    true,
    "视频审核失败必须可重试",
  );

  // —— 服务端须与浏览器端一致：import 会起 HTTP 服务，改为静态核对源码 ——
  const serverSrc = await readFile(new URL("../server/task-queue.mjs", import.meta.url), "utf8");
  assert.ok(
    serverSrc.includes("isContentModerationCode"),
    "服务端应识别审核 code 才能放行重试",
  );
  const predicate = serverSrc.slice(
    serverSrc.indexOf("function isRetryableError"),
    serverSrc.indexOf("/** 可中断 sleep"),
  );
  assert.ok(predicate.length > 0, "未能定位服务端 isRetryableError");
  assert.ok(
    /isContentModerationCode\(code, err\.message\)\)\s*return true;/.test(predicate),
    "服务端审核类失败必须无条件放行重试，且要看 message（视频审核的 code 是 internal_error）",
  );
  assert.ok(
    !predicate.includes("MODERATION_MAX_ATTEMPTS"),
    "服务端不应再有审核重试次数上限",
  );
  assert.ok(
    predicate.indexOf("isContentModerationCode") < predicate.indexOf("status === 400"),
    "审核判断必须排在 400 之前，否则审核拦截会先被 400 规则截掉",
  );
  assert.ok(
    /typeof\s+\w+\??\.?\w*\s*===\s*"string"/.test(serverSrc) &&
      serverSrc.includes("readUpstreamErrorBody"),
    "服务端应有统一的错误体解析（含 error 为字符串的情况）",
  );
  // 判定实现本身也要同步：两边都得看 code + message，否则视频审核在某一端漏判
  assert.ok(
    /function isContentModerationCode\(code, message\)/.test(serverSrc),
    "服务端审核判定应同时接收 code 和 message，与浏览器端保持一致",
  );
  const serverNotice = serverSrc.match(/const MODERATION_NOTICE = "(.+?)";/)?.[1];
  assert.equal(serverNotice, videoZh, "两端的中文审核提示必须一字不差，否则去重/判定会漏");

  console.log("PASS: upstream error parsing + unbounded moderation retry");
} finally {
  await unlink(outfile).catch(() => undefined);
  await unlink(entry).catch(() => undefined);
}
