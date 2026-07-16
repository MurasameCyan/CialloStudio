/* 本地 dev 默认：无 .env 站长注入时用 mock 默认站长 admin/admin123。
 * Docker 启动时由 entrypoint 覆盖本文件（只写入用户名 + 密码 sha256）。 */
window.__CIALLO_RUNTIME__ = {
  masterUsername: "",
  masterPasswordSha256: "",
  mediaBase: "",
  mediaUploadToken: ""
};
