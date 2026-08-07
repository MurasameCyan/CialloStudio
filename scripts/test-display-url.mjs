/**
 * displayUrl 选源优先级。
 *
 * 回归背景：旧实现跳过 blob: 开头的 imageUrl，直接返回 openUrl。
 * 视频 blob 化成功后 imageUrl=blob:、openUrl=/v1/videos/xxx/content，
 * 于是 <video src> 拿到的是同源代理路径 —— 而浏览器无法给媒体元素设 Authorization，
 * 代理转发时也不补 API key（cookie 只存上游 origin），上游遂返回 invalid_api_key。
 *
 * 与 src/lib/studioQueue.ts 的 displayUrl 保持同步。
 */

function displayUrl(job) {
  if (!job) return undefined;
  if (typeof job.imageUrl === "string" && job.imageUrl) return job.imageUrl;
  if (typeof job.openUrl === "string" && job.openUrl) return job.openUrl;
  return undefined;
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// —— 核心回归：blob 必须赢过 openUrl ——
assert(
  displayUrl({
    kind: "video",
    imageUrl: "blob:http://localhost:5173/abc-123",
    openUrl: "/v1/videos/video_ncxBM5o9PieaJIZHIu5gmsjX/content",
  }) === "blob:http://localhost:5173/abc-123",
  "blob imageUrl 优先于 openUrl（否则 <video> 打同源代理 → invalid_api_key）",
);

assert(
  displayUrl({
    kind: "image",
    imageUrl: "blob:http://localhost:5173/img-1",
    openUrl: "/v1/media/images/img_abc",
  }) === "blob:http://localhost:5173/img-1",
  "图片同理：blob 优先",
);

// —— data: 同样自带内容，优先 ——
assert(
  displayUrl({ imageUrl: "data:image/png;base64,aaa", openUrl: "/v1/media/x" }).startsWith("data:"),
  "data URL 优先于 openUrl",
);

// —— blob 丢失（刷新后 serializeJobs 把 blob 换成 openUrl）时回落 ——
assert(
  displayUrl({ imageUrl: undefined, openUrl: "/v1/media/images/img_abc" }) ===
    "/v1/media/images/img_abc",
  "无 imageUrl 时回落 openUrl",
);
assert(
  displayUrl({ imageUrl: "", openUrl: "/v1/media/images/img_abc" }) === "/v1/media/images/img_abc",
  "空 imageUrl 视为缺失，回落 openUrl",
);

// —— 非 blob 的绝对地址仍可直接展示 ——
assert(
  displayUrl({ imageUrl: "https://cdn.example.com/a.jpg", openUrl: "/v1/media/x" }) ===
    "https://cdn.example.com/a.jpg",
  "普通 http URL 优先于 openUrl",
);

// —— 边界 ——
assert(displayUrl(null) === undefined, "null job");
assert(displayUrl(undefined) === undefined, "undefined job");
assert(displayUrl({}) === undefined, "两者皆空返回 undefined");

console.log("OK: displayUrl 选源优先级");
