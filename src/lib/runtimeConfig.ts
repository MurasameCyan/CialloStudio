export type CialloRuntime = {
  /** 站长用户名（社区 admin）；空 = 使用 Mock 默认 admin */
  masterUsername: string;
  /** 站长密码 SHA-256 hex；空 = 未从 .env 注入 */
  masterPasswordSha256: string;
  /** CF Worker / Pages 媒体根域名 */
  mediaBase: string;
  /** 可选：媒体上传 Bearer token（非 Bot Token） */
  mediaUploadToken: string;
  /** 上游图片站公网根域名（Site Base） */
  siteBase: string;
  /** 后台队列储存：media=TG / site=改写 */
  queueStorageMode: string;
  /** 社区 API：mock（浏览器 localStorage）| http（Docker /data 持久化） */
  communityMode: "mock" | "http";
  /** 社区 API base，默认 /api/community */
  communityApiBase: string;
  /** 构建 SHA（短或全长）；空 = 用 Vite define / unknown */
  buildId: string;
  /** GitHub owner/repo，版本检测用 */
  githubRepo: string;
  /** 跟踪分支（默认 beta） */
  trackRef: string;
  /** 默认提示词词库 URL；空 = 用约定路径 DEFAULT_PROMPT_TEMPLATES_URL */
  promptTemplatesUrl: string;
};

/**
 * 默认词库的约定路径。挂到 nginx 根目录即生效，不必再设环境变量——
 * 原先两步缺一步就静默失败，这是当时最常踩的坑。
 */
export const DEFAULT_PROMPT_TEMPLATES_URL = "/prompt-templates.json";

declare global {
  interface Window {
    __CIALLO_RUNTIME__?: Partial<CialloRuntime>;
  }
}

function isSha256Hex(value: string): boolean {
  return value.length === 64 && /^[a-f0-9]+$/i.test(value);
}

function readRuntime(): CialloRuntime {
  const raw = typeof window !== "undefined" ? window.__CIALLO_RUNTIME__ : undefined;
  const username =
    typeof raw?.masterUsername === "string" ? raw.masterUsername.trim().toLowerCase() : "";
  let hash = typeof raw?.masterPasswordSha256 === "string" ? raw.masterPasswordSha256.trim() : "";
  hash = hash.toLowerCase();
  if (hash && !isSha256Hex(hash)) hash = "";
  const mediaBase = typeof raw?.mediaBase === "string" ? raw.mediaBase.trim() : "";
  const mediaUploadToken =
    typeof raw?.mediaUploadToken === "string" ? raw.mediaUploadToken.trim() : "";
  const siteBase = typeof raw?.siteBase === "string" ? raw.siteBase.trim() : "";
  const queueStorageMode =
    typeof raw?.queueStorageMode === "string" ? raw.queueStorageMode.trim() : "";
  const modeRaw =
    typeof raw?.communityMode === "string" ? raw.communityMode.trim().toLowerCase() : "";
  // 默认 http；仅显式 mock 走浏览器 localStorage
  const communityMode: "mock" | "http" = modeRaw === "mock" ? "mock" : "http";
  const communityApiBase =
    typeof raw?.communityApiBase === "string" && raw.communityApiBase.trim()
      ? raw.communityApiBase.trim()
      : "/api/community";
  const buildId = typeof raw?.buildId === "string" ? raw.buildId.trim() : "";
  const githubRepo =
    typeof raw?.githubRepo === "string" && raw.githubRepo.trim()
      ? raw.githubRepo.trim()
      : "MurasameCyan/CialloStudio";
  const trackRef =
    typeof raw?.trackRef === "string" && raw.trackRef.trim() ? raw.trackRef.trim() : "beta";
  const promptTemplatesUrl =
    typeof raw?.promptTemplatesUrl === "string" ? raw.promptTemplatesUrl.trim() : "";
  return {
    masterUsername: username || (hash ? "admin" : ""),
    masterPasswordSha256: hash,
    mediaBase,
    mediaUploadToken,
    siteBase,
    queueStorageMode,
    communityMode,
    communityApiBase,
    buildId,
    githubRepo,
    trackRef,
    promptTemplatesUrl,
  };
}

/** 默认词库来源 */
export type PromptTemplatesSource = {
  url: string;
  /**
   * true = 站长显式配了地址，拉不到就是配错了，要报错让他知道；
   * false = 走约定路径的探测，拉不到只说明没提供词库，不该当成故障吓用户。
   */
  explicit: boolean;
};

export function getPromptTemplatesSource(): PromptTemplatesSource {
  const configured = readRuntime().promptTemplatesUrl;
  return configured
    ? { url: configured, explicit: true }
    : { url: DEFAULT_PROMPT_TEMPLATES_URL, explicit: false };
}

/** env / runtime-config 注入的社区模式（默认 http） */
export function getRuntimeCommunityMode(): "mock" | "http" {
  return readRuntime().communityMode;
}

export function getRuntimeCommunityApiBase(): string {
  return readRuntime().communityApiBase || "/api/community";
}

export function getRuntimeConfig(): CialloRuntime {
  return readRuntime();
}

/** 是否配置了 .env 站长账号（密码哈希） */
export function isMasterConfigured(): boolean {
  const r = readRuntime();
  return Boolean(r.masterUsername && r.masterPasswordSha256);
}

export function getMasterUsername(): string {
  const r = readRuntime();
  if (r.masterUsername) return r.masterUsername;
  return "admin";
}

export function getMasterPasswordSha256(): string {
  return readRuntime().masterPasswordSha256;
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 校验明文密码是否匹配 .env 站长密码 */
export async function verifyMasterPassword(password: string): Promise<boolean> {
  const expected = getMasterPasswordSha256();
  if (!expected) return false;
  const input = password.trim();
  if (!input) return false;
  const hash = await sha256Hex(input);
  return hash === expected;
}
