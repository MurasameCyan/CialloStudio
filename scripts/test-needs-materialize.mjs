/**
 * needsMediaMaterialize 判定：哪些媒体地址必须 blob 化才能被 <img>/<video> 渲染。
 *
 * 回归背景：刷新页面后 serializeJobs 会把 blob: 换回 openUrl（同源 /v1/... 路径），
 * 而浏览器给媒体元素发的是裸 GET —— 带不上 Authorization，代理也不补 API key，
 * 上游遂返回 invalid_api_key。方案 1 在加载时按此判定重新拉取并转 blob。
 *
 * 与 src/lib/api.ts 的 needsMediaMaterialize 保持同步。
 */

function isSameOriginMediaPath(url) {
  return url.startsWith("/v1/") || url.startsWith("/media/");
}

function needsMediaMaterialize(url) {
  if (!url || /^(blob|data):/i.test(url)) return false;
  return (
    isSameOriginMediaPath(url) ||
    url.includes("/v1/videos/") ||
    url.includes("/v1/media/") ||
    /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\//i.test(url)
  );
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// —— 必须 blob 化：需认证或不可直连 ——
assert(
  needsMediaMaterialize("/v1/videos/video_ncxBM5o9PieaJIZHIu5gmsjX/content"),
  "同源视频路径需 blob 化（裸 GET 无 Authorization → invalid_api_key）",
);
assert(needsMediaMaterialize("/v1/media/images/img_abc"), "同源图片路径需 blob 化");
assert(needsMediaMaterialize("/media/images/img_abc"), "/media 前缀需 blob 化");
assert(
  needsMediaMaterialize("https://grokb.yuzu.gv.uy/v1/videos/video_x/content"),
  "上游绝对视频地址需 blob 化",
);
assert(
  needsMediaMaterialize("https://img.yuzu.gv.uy/v1/videos/video_sYqoD21HDQT3f8TmR7mf6xeb/content"),
  "Site Base 改写后的视频地址仍需 blob 化（用户实际报错的那条）",
);
assert(
  needsMediaMaterialize("http://127.0.0.1:8000/v1/media/images/img_x"),
  "loopback 地址需 blob 化（浏览器会打到用户本机）",
);
assert(needsMediaMaterialize("http://localhost:8000/anything"), "localhost 一律 blob 化");

// —— 无需处理：已是可直连数据源 ——
assert(!needsMediaMaterialize("blob:http://localhost:5173/abc-123"), "blob: 已是本地对象，不重复拉");
assert(!needsMediaMaterialize("data:image/png;base64,iVBORw0KGgo="), "data: 自带内容，不需拉取");
assert(!needsMediaMaterialize(""), "空字符串不处理");
assert(!needsMediaMaterialize("https://cdn.example.com/images/pic.jpg"), "公网 CDN 图可直连，省一次拉取");

// 大小写兜底：协议/前缀不区分大小写时也别漏判
assert(needsMediaMaterialize("HTTP://127.0.0.1:8000/v1/media/x"), "loopback 判定忽略协议大小写");
assert(!needsMediaMaterialize("BLOB:http://localhost/abc"), "blob 判定忽略大小写");

console.log("PASS: needs-materialize (14 cases)");
