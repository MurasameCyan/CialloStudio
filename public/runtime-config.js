/* 默认 communityMode=http（/api/community）。
 * Docker 启动时由 entrypoint 按 CIALLO_COMMUNITY_MODE 覆盖本文件。
 * 本地无社区后端时可设 mock，或在 .env 写 CIALLO_COMMUNITY_MODE=mock 后由部署注入。
 * buildId / githubRepo / trackRef：版本检测；dev 时前端优先用 Vite define 的 git SHA。 */
window.__CIALLO_RUNTIME__ = {
  masterUsername: "",
  masterPasswordSha256: "",
  mediaBase: "",
  mediaUploadToken: "",
  siteBase: "",
  queueStorageMode: "",
  communityMode: "http",
  communityApiBase: "/api/community",
  buildId: "",
  githubRepo: "MurasameCyan/CialloStudio",
  trackRef: "beta"
};
