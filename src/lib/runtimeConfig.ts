export type CialloRuntime = {
  /** 站长用户名（社区 admin）；空 = 使用 Mock 默认 admin */
  masterUsername: string;
  /** 站长密码 SHA-256 hex；空 = 未从 .env 注入 */
  masterPasswordSha256: string;
};

declare global {
  interface Window {
    __CIALLO_RUNTIME__?: Partial<CialloRuntime> & {
      /** 旧字段兼容，已废弃 */
      adminGateEnabled?: boolean;
      adminPasswordSha256?: string;
    };
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
  // 兼容旧 Docker runtime：adminPasswordSha256 → 站长密码哈希，用户名默认 admin
  if (!hash && typeof raw?.adminPasswordSha256 === "string") {
    hash = raw.adminPasswordSha256.trim();
  }
  hash = hash.toLowerCase();
  if (hash && !isSha256Hex(hash)) hash = "";
  return {
    masterUsername: username || (hash ? "admin" : ""),
    masterPasswordSha256: hash,
  };
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
