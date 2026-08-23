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
  // 规则没命中、也没给 status 的错误保持原样，不要吃掉上游信息
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
  // message 不含审核字样的 internal_error 是真基建错误，别误判成审核
  assert.equal(isContentModerationCode("internal_error", "upstream timeout"), false);
  assert.ok(
    !/审核/.test(describeUpstreamError("internal_error", "upstream timeout")),
    "超时不该被当成审核拦截",
  );
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

  /* —— 线上真实错误体的中文映射 ——
     取自容器 10 天日志的去重统计（次数见 server/upstream-errors.mjs 头注释）。
     这些原文要么全英文、要么长到能把面板顶变形，映射后不该再残留原文。 */
  const cases = [
    {
      name: "Cloudflare 纯文本 502（本次排查的那条）",
      code: undefined,
      message: "error code: 502",
      status: 502,
      want: [/502/, /Cloudflare/, /网关/],
      deny: [/error code/i, /审核/],
    },
    {
      name: "Cloudflare 520",
      code: undefined,
      message: "error code: 520",
      status: 502,
      want: [/520/, /Cloudflare/],
      deny: [/error code/i],
    },
    {
      name: "x.ai 免费额度用尽",
      code: undefined,
      message:
        "Free usage quota exceeded. Purchase credits or provision an API key at https://console.x.ai",
      status: 400,
      want: [/额度/, /充值|换/],
      deny: [/Free usage quota/i, /审核/],
    },
    {
      name: "x.ai 每秒限流：要留下 实际/上限 两个数",
      code: undefined,
      message:
        "Too many requests for team 00000000-0000-0000-0000-000000000014 and model grok-imagine-image-quality. Your team's rate limit is — Requests per Second (actual/limit): 2/2. Your rate limit tier is determined based on your historical API spend.",
      status: 429,
      want: [/限流/, /每秒/, /2\/2/],
      deny: [/Too many requests/i, /console\.x\.ai/, /00000000-/],
    },
    {
      name: "x.ai 每分钟限流",
      code: undefined,
      message:
        "Too many requests for team 00000000-0000-0000-0000-000000000014 and model grok-imagine-image-quality. Your team's rate limit is — Requests per Minute (actual/limit): 354/60.",
      status: 429,
      want: [/限流/, /每分钟/, /354\/60/],
      deny: [/Too many requests/i],
    },
    {
      name: "Envoy 连不上后端",
      code: undefined,
      message:
        "upstream connect error or disconnect/reset before headers. reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused",
      status: 503,
      want: [/上游/, /连接|连不上/],
      deny: [/upstream connect error/i],
    },
    {
      name: "只回了状态短语：按状态码给中文",
      code: undefined,
      message: "Bad Gateway",
      status: 502,
      want: [/网关/, /HTTP 502/],
      deny: [/Bad Gateway/],
    },
    {
      name: "空 body + 401：提示去查 Key",
      code: undefined,
      message: "",
      status: 401,
      want: [/API Key/, /HTTP 401/],
      deny: [],
    },
    /* —— 按耗时分流上游 502：响应体完全一样，只有耗时能区分 ——
       2026-08-22 受控实验：16 次成功都在 11–20s；静默审核（Grok 的 Imagine
       WebSocket 不回 content-moderated，挂 ~75s 后 close 1006）三次复现是
       75.6s / 74.1s / 80.1s。所以秒败＝基建故障（重试有意义），
       过一分钟＝静默审核（重试永远不会过，只会一轮烧 75 秒）。 */
    {
      name: "上游 502 吊死 75s：静默审核，别让人守着等重试",
      code: "upstream_unavailable",
      message: "上游服务暂不可用",
      status: 502,
      elapsedMs: 75600,
      want: [/静默拦截/, /76 秒/, /改写提示词/],
      deny: [/暂不可用/, /自动重试即可/, /审核拦截，请改写提示词后重试/, /重试不会通过/, /重试无效/],
    },
    {
      name: "经 Cloudflare 换壳的同一个错误，吊死 80s 也要认出来",
      code: undefined,
      message: "error code: 502",
      status: 502,
      elapsedMs: 80100,
      want: [/静默拦截/, /80 秒/],
      deny: [/Cloudflare/, /自动重试即可/],
    },
    {
      name: "上游 502 秒败：基建故障，文案不变",
      code: "upstream_unavailable",
      message: "上游服务暂不可用",
      status: 502,
      elapsedMs: 180,
      want: [/暂不可用/],
      deny: [/静默/, /改写/],
    },
  ];
  for (const c of cases) {
    const got = describeUpstreamError(c.code, c.message, c.status, c.elapsedMs);
    for (const re of c.want) {
      assert.ok(re.test(got), `${c.name}：结果应含 ${re}，实际：${got}`);
    }
    for (const re of c.deny) {
      assert.ok(!re.test(got), `${c.name}：结果不该含 ${re}，实际：${got}`);
    }
    assert.ok(got.length <= 80, `${c.name}：映射后的提示要短到能进面板，实际 ${got.length} 字`);
  }

  // 没命中规则、但上游原文有内容时：补中文说明 + 保留原文，别吃掉信息
  const unknown400 = describeUpstreamError("invalid_request", "prompt too long", 400);
  assert.ok(/HTTP 400/.test(unknown400) && /prompt too long/.test(unknown400), unknown400);

  // 上游自己给的中文原样透出：按状态码猜的原因经常是错的，别硬加
  // （"模型不存在" 是 404 但问题不在 Base URL；"额度等待恢复" 是 400 但跟参数无关）
  assert.equal(describeUpstreamError(undefined, "上游账号额度等待恢复", 400), "上游账号额度等待恢复");
  assert.equal(describeUpstreamError("model_not_found", "模型不存在", 404), "模型不存在");
  assert.equal(
    describeUpstreamError("invalid_api_key", "客户端 API Key 无效", 401),
    "客户端 API Key 无效",
  );

  // 映射结果不能反过来被当成审核，否则重试判定错位
  for (const c of cases) {
    const got = describeUpstreamError(c.code, c.message, c.status, c.elapsedMs);
    assert.equal(
      isContentModerationCode(undefined, got),
      false,
      `${c.name}：不该被判成审核拦截（${got}）`,
    );
  }

  // 不传耗时 = 老行为，别因为新加的分支改了既有调用点的文案
  assert.equal(
    describeUpstreamError("upstream_unavailable", "上游服务暂不可用", 502),
    "上游服务暂不可用",
  );
  assert.equal(
    describeUpstreamError("upstream_unavailable", "上游服务暂不可用", 502, 180),
    "上游服务暂不可用",
    "秒败是基建故障，文案必须保持原样",
  );
  // 阈值边界：正好 60s 算静默审核，59.9s 还不算
  assert.ok(
    /静默拦截/.test(describeUpstreamError(undefined, "上游服务暂不可用", 502, 60000)),
    "60s 应判为静默审核",
  );
  assert.ok(
    !/静默拦截/.test(describeUpstreamError(undefined, "上游服务暂不可用", 502, 59900)),
    "59.9s 还不到阈值",
  );
  // 只有 502 这一类才按耗时分流：慢的 429/超时不能被说成静默审核
  assert.ok(
    !/静默拦截/.test(describeUpstreamError(undefined, "error code: 524", 502, 100000)),
    "CF 524 是网关超时，不是静默审核",
  );
  assert.ok(
    !/静默拦截/.test(describeUpstreamError(undefined, "上游超时", 504, 240000)),
    "超时不该被当成静默审核",
  );

  // 静默审核文案不能与「自动重试中 · 第 N 次」的前缀自相矛盾：开着自动重试就该
  // 一直重试（无上限重试是需求），所以文案里不能出现「重试不会通过 / 重试无效 /
  // 别再重试」这类劝退话，否则重试开关看着形同虚设。收不收手由用户和超时决定。
  const silentZh = describeUpstreamError("upstream_unavailable", "上游服务暂不可用", 502, 75600);
  assert.ok(/静默拦截/.test(silentZh), `应识别为静默审核，实际：${silentZh}`);
  assert.ok(
    !/重试不会通过|重试无效|不会成功|别再?重试|停止重试/.test(silentZh),
    `静默审核文案不该劝退重试（会和自动重试开关矛盾）：${silentZh}`,
  );

  // —— 两端共用同一份映射：以前是各写一份 + 静态扒源码比字符串，必然漂 ——
  const serverSrc = await readFile(new URL("../server/task-queue.mjs", import.meta.url), "utf8");
  const browserSrc = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.ok(
    /from "\.\/upstream-errors\.mjs"/.test(serverSrc),
    "服务端必须从共用模块取中文映射，别再本地复制一份",
  );
  assert.ok(
    /from "\.\.\/\.\.\/server\/upstream-errors\.mjs"/.test(browserSrc),
    "浏览器端必须从共用模块取中文映射，别再本地复制一份",
  );

  // 耗时要真的透到映射函数里，否则上面那几条按耗时分流的分支永远不会触发
  assert.ok(
    /elapsedMs: Date\.now\(\) - startedAt/.test(serverSrc) &&
      /describeUpstreamError\([^)]*res\.elapsedMs\)/.test(serverSrc),
    "服务端要把 httpRequestJson 的耗时透给映射函数",
  );
  assert.ok(
    /Date\.now\(\) - startedAt/.test(browserSrc),
    "浏览器端要把 fetch 耗时透给映射函数",
  );
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.ok(
    /COPY[^\n]*upstream-errors\.mjs[^\n]*\.\/server\//.test(dockerfile) &&
      /COPY[^\n]*upstream-errors\.mjs[^\n]*\/opt\/ciallo\//.test(dockerfile),
    "共用模块要同时进构建阶段和运行阶段镜像，否则容器一启动就 ERR_MODULE_NOT_FOUND",
  );

  // —— 服务端重试判定不受映射影响 ——
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

  console.log("PASS: upstream error parsing + unbounded moderation retry");
} finally {
  await unlink(outfile).catch(() => undefined);
  await unlink(entry).catch(() => undefined);
}
