/**
 * 上游错误 → 中文提示：全站唯一的一份映射。
 *
 * 浏览器端（src/lib/api.ts）和后台队列（server/task-queue.mjs）都从这里取。
 * 以前两边各写一份 MODERATION_NOTICE + isContentModerationCode，靠测试静态
 * 扒源码比对字符串来防漂移；映射表一变多就必然漂，所以合并成一个模块。
 *
 * 纯字符串逻辑、不 import 任何 node 内置，所以能被 Vite 直接打进浏览器包。
 *
 * 表里每条都对应线上真实出现过的错误体（取自容器 10 天日志的去重统计），
 * 不是凭空猜的格式：
 *   25211  imagine:content-moderated / Generated image rejected by content moderation.
 *   23479  Free usage quota exceeded. Purchase credits or provision an API key at https://console.x.ai
 *   18393  Too many requests for team <uuid> and model ... Requests per Second (actual/limit): 2/2. ...
 *    3460  上游账号额度等待恢复（grok2api 自己给的中文，原样透出）
 *     642  error code: 502 / error code: 520（Cloudflare 的 text/plain 错误体）
 *       4  upstream connect error or disconnect/reset before headers. reset reason: ...
 */

export const MODERATION_NOTICE = "提示词或生成结果被上游内容审核拦截，请改写提示词后重试";

/**
 * 审核拦截识别。图片走 code（grokb 用 imagine:content-moderated），
 * 但视频异步失败时上游把 code 写成 internal_error，审核信息只在 message 里：
 *   {"error":{"code":"internal_error","message":"Console 媒体上游返回 400: Generated video rejected by content moderation."}}
 * 所以两边都要看。已映射成中文的提示也要认，否则翻译后重试判定会失效。
 */
export function isContentModerationCode(code, message) {
  const text = `${code || ""} ${message || ""}`;
  if (!text.trim()) return false;
  return /content[-_\s]?moderat/i.test(text) || text.includes(MODERATION_NOTICE);
}

/** Cloudflare 自己生成的错误码；不在表里的走通用文案 */
const CLOUDFLARE_CODES = {
  502: "未能从上游取到有效响应",
  520: "上游返回了网关无法识别的响应",
  521: "上游拒绝连接，可能已停机",
  522: "连接上游超时",
  523: "路由不到上游",
  524: "上游处理超时",
  525: "与上游的 TLS 握手失败",
  1015: "被 Cloudflare 限流",
  1101: "Cloudflare Worker 执行异常",
};

/**
 * 按顺序匹配上游错误（code 与 message 拼在一起匹配，因为同一类错误
 * 在图片链路里藏在 code、在视频链路里藏在 message）。第一条命中即返回。
 */
const RULES = [
  // 审核：出图结果被拦，不是提示词语法问题
  { match: /content[-_\s]?moderat/i, zh: () => MODERATION_NOTICE },

  // x.ai 账号免费额度用尽（grok2api 把上游原文整句透传出来）
  {
    match: /free usage quota exceeded|purchase credits or provision an api key/i,
    zh: () => "上游账号的免费额度已用尽，需要在 x.ai 充值或换一个上游账号",
  },

  // x.ai 限流：原文 350+ 字全英文且含团队 uuid，只留「窗口 + 实际/上限」两个有用数字
  {
    match: /too many requests/i,
    zh: (text) => {
      const hit = /requests per (second|minute)[^(]*\(actual\/limit\):\s*(\d+)\s*\/\s*(\d+)/i.exec(text);
      if (!hit) return "上游限流：请求过于频繁，请降低并发或等自动重试";
      const unit = /second/i.test(hit[1]) ? "每秒" : "每分钟";
      return `上游限流：${unit}请求数已达上限（${hit[2]}/${hit[3]}），请降低并发或等自动重试`;
    },
  },

  // Cloudflare 的 text/plain 错误体，整个 body 就一行 "error code: 502"。
  // 这条不是我们的服务在报错，是 CF 边缘没能从上游拿到响应，跟提示词无关。
  {
    match: /(?:^|\s)error code:\s*(\d+)/i,
    zh: (_text, m) => {
      const reason = CLOUDFLARE_CODES[Number(m[1])];
      return `上游网关 ${m[1]} 错误（Cloudflare）${reason ? `：${reason}` : ""}，通常是上游临时故障，自动重试即可`;
    },
  },

  // Envoy / 反代连不上后端
  {
    match: /upstream connect error|disconnect\/reset before headers|econnreset|econnrefused|socket hang up|connection (?:refused|reset)/i,
    zh: () => "上游网关连不上后端服务（连接被重置），通常是上游临时故障，自动重试即可",
  },

  // 各层的超时
  {
    match: /etimedout|timed?\s?out|timeout/i,
    zh: () => "上游响应超时，自动重试即可",
  },
];

/**
 * 静默审核：上游 502，但**耗时超过一分钟**。
 *
 * 基建故障（比如没有可用出口节点）是 100–300ms 秒败，自动重试有意义。
 * 而 Grok 的 Imagine WebSocket 撞上内容审核时不回 imagine:content-moderated，
 * 而是挂起 ~75s 后 close 1006 unexpected EOF，上游同样吐 502 upstream_unavailable
 * （经 Cloudflare 再被换成 text/plain 的 "error code: 502"）。两者响应体一模一样，
 * **只有耗时能区分**：2026-08-22 受控实验里 16 次成功都在 11–20s，静默审核三次
 * 复现是 75.6s / 74.1s / 80.1s，60s 阈值正好落在两者中间。
 *
 * 只换文案、不动重试（无上限重试是需求，开着自动重试就一直重试）：文案只点出
 * 大概率是静默审核、并提示「改写更快出图」，不写「重试不会通过」这类劝退话——
 * 那会和前端「自动重试中 · 第 N 次」的前缀自相矛盾，让重试开关看着没意义。
 * 何时收手由停止按钮和任务超时决定，不由这句提示替用户拍板。
 */
const SILENT_MODERATION_MS = 60000;

/** 上游 502 的两张皮：源站原文 / Cloudflare 换壳后的 error code: 502|520 */
const UPSTREAM_502 = /upstream_unavailable|上游服务暂不可用|(?:^|\s)error code:\s*5(?:02|20)\b/i;

/** 只回了个状态码/状态短语、没带任何上游说明的错误体 */
const STATUS_ECHO_ONLY =
  /^(?:上游\s*)?(?:HTTP\s*\d{3}|bad gateway|service unavailable|gateway\s?time-?out|internal server error|unauthorized|forbidden|not found|too many requests|bad request)\.?$/i;

/** 上游自己就给了中文（grok2api 的「上游账号额度等待恢复」「模型不存在」等） */
const ALREADY_CHINESE = /[一-鿿]/;

const STATUS_NOTICE = {
  400: "上游拒绝了这次请求，参数或提示词不合法",
  401: "上游不认这个 API Key，请到管理页检查",
  403: "上游拒绝了访问，Key 可能无权限或已被封",
  404: "上游没有这个接口，请检查 Base URL 是否以 /v1 结尾",
  408: "上游响应超时",
  413: "请求体过大，参考图可能太大",
  429: "上游限流，请降低并发或稍后重试",
  500: "上游服务内部错误",
  502: "上游网关错误，网关未能从上游取到有效响应",
  503: "上游服务暂时不可用，可能过载或在维护",
  504: "上游响应超时，网关等待超时",
};

/**
 * 上游错误转中文。命中规则表就整句换成中文（原文是纯样板话，留着只会
 * 把面板顶变形）；没命中就按状态码补一句中文说明并**保留原文**——上游
 * 原文哪怕是英文，也比一句笼统的中文有用，别吃掉信息。
 *
 * elapsedMs 是这次请求从发出到拿到错误的耗时，可不传；只用来把「上游 502」
 * 拆成秒败的基建故障和吊死一分多钟的静默审核两种。
 */
export function describeUpstreamError(code, message, status, elapsedMs) {
  const raw = String(message ?? "").trim();
  const text = `${code ?? ""} ${raw}`;
  const took = Number(elapsedMs) || 0;
  if (took >= SILENT_MODERATION_MS && UPSTREAM_502.test(text)) {
    return `疑似提示词被上游静默拦截：上游挂起 ${Math.round(took / 1000)} 秒后断开连接，改写提示词可更快出图（照片级真人全身、年龄或身材描述最容易触发）`;
  }
  for (const rule of RULES) {
    const m = rule.match.exec(text);
    if (m) return rule.zh(text, m);
  }
  // 上游已经给了中文就别再套状态码说明：按状态码猜的原因经常是错的
  // （"模型不存在" 是 404，但问题不在 Base URL；"额度等待恢复" 是 400，但跟参数无关）
  if (ALREADY_CHINESE.test(raw)) return raw;
  const st = Number(status) || 0;
  const notice = STATUS_NOTICE[st];
  if (!notice) return raw;
  if (!raw || STATUS_ECHO_ONLY.test(raw)) return `${notice}（HTTP ${st}）`;
  return `${notice}（HTTP ${st}）：${raw}`;
}
