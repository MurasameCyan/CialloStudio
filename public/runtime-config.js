/* 默认 communityMode=http（/api/community）。
 * Docker 启动时由 entrypoint 按 CIALLO_COMMUNITY_MODE 覆盖本文件。
 * 本地无社区后端时可设 mock，或在 .env 写 CIALLO_COMMUNITY_MODE=mock 后由部署注入。 */
window.__CIALLO_RUNTIME__ = {
  masterUsername: "",
  masterPasswordSha256: "",
  mediaBase: "",
  mediaUploadToken: "",
  communityMode: "http",
  communityApiBase: "/api/community"
};
