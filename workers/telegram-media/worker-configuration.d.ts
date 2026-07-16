interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  /** 可选：上传鉴权 Bearer token */
  UPLOAD_TOKEN?: string;
  /** 可选：CORS 白名单，逗号分隔 */
  ALLOWED_ORIGINS?: string;
  /** 最大上传字节，默认 20MB */
  MAX_UPLOAD_BYTES?: string;
}
