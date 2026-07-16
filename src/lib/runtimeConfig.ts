export type CialloRuntime = {
  adminGateEnabled: boolean;
  adminPasswordSha256: string;
};

declare global {
  interface Window {
    __CIALLO_RUNTIME__?: Partial<CialloRuntime>;
  }
}

const SESSION_KEY = "ciallo-studio.adminUnlocked.v1";

function readRuntime(): CialloRuntime {
  const raw = typeof window !== "undefined" ? window.__CIALLO_RUNTIME__ : undefined;
  const hash = typeof raw?.adminPasswordSha256 === "string" ? raw.adminPasswordSha256.trim() : "";
  const enabled =
    raw?.adminGateEnabled === true ||
    (raw?.adminGateEnabled !== false && hash.length === 64 && /^[a-f0-9]+$/i.test(hash));
  return {
    adminGateEnabled: Boolean(enabled && hash),
    adminPasswordSha256: hash.toLowerCase(),
  };
}

export function getRuntimeConfig(): CialloRuntime {
  return readRuntime();
}

export function isAdminGateEnabled(): boolean {
  return readRuntime().adminGateEnabled;
}

export function isAdminUnlocked(): boolean {
  if (!isAdminGateEnabled()) return true;
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAdminUnlocked(unlocked: boolean): void {
  try {
    if (unlocked) sessionStorage.setItem(SESSION_KEY, "1");
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 校验管理密码；成功则写入 session 解锁 */
export async function tryUnlockAdmin(password: string): Promise<boolean> {
  const runtime = readRuntime();
  if (!runtime.adminGateEnabled) {
    setAdminUnlocked(true);
    return true;
  }
  const input = password.trim();
  if (!input) return false;
  const hash = await sha256Hex(input);
  if (hash === runtime.adminPasswordSha256) {
    setAdminUnlocked(true);
    return true;
  }
  return false;
}

export function lockAdmin(): void {
  setAdminUnlocked(false);
}
