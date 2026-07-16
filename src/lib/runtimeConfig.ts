export type CialloRuntime = {
  /** 站长用户名（社区 admin）；空 = 使用 Mock 默认 admin */
  masterUsername: string;
  /** 站长密码 SHA-256 hex；空 = 未从 .env 注入 */
  masterPasswordSha256: string;
  /** CF Worker / Pages 媒体基址 */
  mediaBase: string;
  /** 可选：媒体上传 Bearer token（非 Bot Token） */
  mediaUploadToken: string;
  /** 社区 API：mock（浏览器 localStorage）| http（Docker /data 持久化） */
  communityMode: "mock" | "http";
  /** 社区 API base，默认 /api/community */
  communityApiBase: string;
};

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
  const modeRaw =
    typeof raw?.communityMode === "string" ? raw.communityMode.trim().toLowerCase() : "";
  // 默认 http；仅显式 mock 走浏览器 localStorage
  const communityMode: "mock" | "http" = modeRaw === "mock" ? "mock" : "http";
  const communityApiBase =
    typeof raw?.communityApiBase === "string" && raw.communityApiBase.trim()
      ? raw.communityApiBase.trim()
      : "/api/community";
  return {
    masterUsername: username || (hash ? "admin" : ""),
    masterPasswordSha256: hash,
    mediaBase,
    mediaUploadToken,
    communityMode,
    communityApiBase,
  };
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
