/**
 * 校验客户端自定义上游 origin，拦截 SSRF（私网 / loopback / metadata 等）。
 * 仍允许任意公网 http(s) 上游；内网需 CIALLO_UPSTREAM_ALLOWLIST 显式放行。
 *
 * @typedef {{ ok: true, origin: string } | { ok: false, code: string, message: string }} UpstreamResult
 * @typedef {{ allowlist?: string[] }} ValidateOptions
 */

import dns from "node:dns/promises";
import net from "node:net";

/** 永不放行的主机（即使在 allowlist 里） */
const HARD_BLOCK_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

const SOFT_BLOCK_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

/**
 * @param {string} hostname
 */
function normalizeHost(hostname) {
  let h = String(hostname || "")
    .trim()
    .toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * @param {string} ip
 * @returns {number | null}
 */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

/**
 * 云 metadata / 特殊保留：不可被 allowlist 覆盖
 * @param {string} ip
 */
export function isHardBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    // 169.254.0.0/16 link-local / metadata
    if ((n >>> 16) === 0xa9fe) return true;
    // 0.0.0.0/8
    if ((n >>> 24) === 0) return true;
    // 224.0.0.0/4 multicast
    if ((n >>> 28) === 0xe) return true;
    // 240.0.0.0/4 reserved
    if ((n >>> 28) === 0xf) return true;
    if (n === 0xffffffff) return true;
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::") return true;
    // multicast
    if (lower.startsWith("ff")) return true;
    return false;
  }
  return true;
}

/**
 * 默认拦截的私网/loopback（可被 allowlist 覆盖，除 hard-block）
 * @param {string} ip IPv4 or IPv6 (no brackets)
 */
export function isBlockedIp(ip) {
  if (isHardBlockedIp(ip)) return true;

  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    // 10.0.0.0/8
    if ((n >>> 24) === 10) return true;
    // 127.0.0.0/8
    if ((n >>> 24) === 127) return true;
    // 172.16.0.0/12
    if ((n >>> 16) >= 0xac10 && (n >>> 16) <= 0xac1f) return true;
    // 192.168.0.0/16
    if ((n >>> 16) === 0xc0a8) return true;
    // 100.64.0.0/10 CGNAT
    if ((n >>> 22) === (0x64400000 >>> 22)) return true;
    // 192.0.0.0/24 IETF
    if ((n >>> 8) === 0xc00000) return true;
    // 192.0.2.0/24 TEST-NET-1
    if ((n >>> 8) === 0xc00002) return true;
    // 198.18.0.0/15 benchmark
    if ((n >>> 15) === (0xc6120000 >>> 15)) return true;
    // 198.51.100.0/24 TEST-NET-2
    if ((n >>> 8) === 0xc63364) return true;
    // 203.0.113.0/24 TEST-NET-3
    if ((n >>> 8) === 0xcb0071) return true;
    return false;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isBlockedIp(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const a = (hi >>> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >>> 8) & 0xff;
      const d = lo & 0xff;
      return isBlockedIp(`${a}.${b}.${c}.${d}`);
    }
    if (/^fe[89ab][0-9a-f]:/i.test(lower) || lower.startsWith("fe80:")) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
    return false;
  }

  return true;
}

/**
 * @param {string} hostname
 */
function isHardBlockedHostname(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return true;
  if (HARD_BLOCK_HOSTNAMES.has(h)) return true;
  if (h.includes("metadata.google")) return true;
  if (net.isIP(h)) return isHardBlockedIp(h);
  return false;
}

/**
 * @param {string} hostname
 */
function isSoftBlockedHostname(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return true;
  if (isHardBlockedHostname(h)) return true;
  if (SOFT_BLOCK_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIP(h)) return isBlockedIp(h);
  return false;
}

/**
 * 解析 CIALLO_UPSTREAM_ALLOWLIST：逗号/换行分隔。
 * 条目可为：
 * - 完整 origin：http://127.0.0.1:8000
 * - host:port：192.168.1.10:9000
 * - host：localhost / 127.0.0.1 / host.docker.internal
 *
 * @param {string} [raw]
 * @returns {string[]}
 */
export function parseUpstreamAllowlist(raw) {
  const text = String(raw ?? process.env.CIALLO_UPSTREAM_ALLOWLIST ?? "").trim();
  if (!text) return [];
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      if (/^https?:\/\//i.test(entry)) {
        try {
          const u = new URL(entry);
          return `${u.protocol}//${u.host}`.toLowerCase();
        } catch {
          return entry.toLowerCase();
        }
      }
      return entry.toLowerCase();
    });
}

/**
 * @param {string} origin e.g. http://127.0.0.1:8000
 * @param {string} hostname
 * @param {string[]} allowlist
 */
export function isOriginAllowlisted(origin, hostname, allowlist) {
  if (!allowlist?.length) return false;
  const originNorm = String(origin || "").toLowerCase();
  const hostNorm = normalizeHost(hostname);
  let port = "";
  try {
    const u = new URL(originNorm);
    port = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    // ignore
  }

  for (const entry of allowlist) {
    const e = String(entry).toLowerCase().trim();
    if (!e) continue;
    if (e === originNorm) return true;
    // host only
    if (e === hostNorm) return true;
    // host:port
    if (port && e === `${hostNorm}:${port}`) return true;
  }
  return false;
}

/**
 * @param {string} raw
 * @returns {{ ok: true, origin: string, hostname: string } | { ok: false, code: string, message: string }}
 */
export function parseUpstreamCandidate(raw) {
  const input = String(raw || "").trim();
  if (!input) {
    return { ok: false, code: "missing_upstream", message: "缺少上游地址" };
  }
  let url;
  try {
    if (!/^https?:\/\//i.test(input)) {
      return {
        ok: false,
        code: "invalid_upstream_scheme",
        message: "上游必须是 http:// 或 https:// 开头的完整地址",
      };
    }
    url = new URL(input);
  } catch {
    return { ok: false, code: "invalid_upstream", message: "上游 URL 无效" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      code: "invalid_upstream_scheme",
      message: "仅允许 http 或 https 上游",
    };
  }

  const hostname = normalizeHost(url.hostname);
  if (!hostname) {
    return { ok: false, code: "invalid_upstream", message: "上游主机名为空" };
  }

  const origin = `${url.protocol}//${url.host}`;
  return { ok: true, origin, hostname };
}

/**
 * @param {string} hostname
 * @param {{ allowlisted: boolean }} opts
 */
async function resolveAndCheck(hostname, opts) {
  if (net.isIP(hostname)) {
    if (isHardBlockedIp(hostname)) {
      return {
        ok: false,
        code: "upstream_blocked",
        message: "不允许指向 metadata / 保留地址的上游",
      };
    }
    if (!opts.allowlisted && isBlockedIp(hostname)) {
      return {
        ok: false,
        code: "upstream_blocked",
        message: "不允许指向内网 / 本机 / 链路本地地址的上游（可在 CIALLO_UPSTREAM_ALLOWLIST 放行）",
      };
    }
    return { ok: true };
  }

  if (isHardBlockedHostname(hostname)) {
    return {
      ok: false,
      code: "upstream_blocked",
      message: "不允许使用 metadata / 集群内部主机名作为上游",
    };
  }

  if (!opts.allowlisted && isSoftBlockedHostname(hostname)) {
    return {
      ok: false,
      code: "upstream_blocked",
      message: "不允许使用该主机名作为上游（本机 / 内网；可在 CIALLO_UPSTREAM_ALLOWLIST 放行）",
    };
  }

  // allowlisted private hostnames：跳过 DNS 私网检查（本机 API 常解析到 127/内网）
  if (opts.allowlisted) {
    return { ok: true };
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return {
      ok: false,
      code: "upstream_dns_failed",
      message: "无法解析上游主机名",
    };
  }

  if (!records?.length) {
    return {
      ok: false,
      code: "upstream_dns_failed",
      message: "上游主机名无解析结果",
    };
  }

  for (const rec of records) {
    const addr = rec.address;
    if (isHardBlockedIp(addr)) {
      return {
        ok: false,
        code: "upstream_blocked",
        message: "上游解析到了 metadata / 保留地址，已拦截",
      };
    }
    if (isBlockedIp(addr)) {
      return {
        ok: false,
        code: "upstream_blocked",
        message: "上游解析到了内网 / 本机 / 保留地址，已拦截（可在 CIALLO_UPSTREAM_ALLOWLIST 放行）",
      };
    }
  }
  return { ok: true };
}

/**
 * @param {string} raw
 * @param {ValidateOptions} [options]
 * @returns {Promise<UpstreamResult>}
 */
export async function validateUpstreamOrigin(raw, options = {}) {
  const parsed = parseUpstreamCandidate(raw);
  if (!parsed.ok) return parsed;

  const allowlist =
    options.allowlist !== undefined
      ? options.allowlist
      : parseUpstreamAllowlist(process.env.CIALLO_UPSTREAM_ALLOWLIST);

  // hard block always
  if (isHardBlockedHostname(parsed.hostname)) {
    return {
      ok: false,
      code: "upstream_blocked",
      message: "不允许指向 metadata / 保留地址的上游",
    };
  }
  if (net.isIP(parsed.hostname) && isHardBlockedIp(parsed.hostname)) {
    return {
      ok: false,
      code: "upstream_blocked",
      message: "不允许指向 metadata / 保留地址的上游",
    };
  }

  const allowlisted = isOriginAllowlisted(parsed.origin, parsed.hostname, allowlist);

  if (!allowlisted) {
    if (net.isIP(parsed.hostname) && isBlockedIp(parsed.hostname)) {
      return {
        ok: false,
        code: "upstream_blocked",
        message: "不允许指向内网 / 本机 / 链路本地 / metadata 的上游",
      };
    }
    if (isSoftBlockedHostname(parsed.hostname)) {
      return {
        ok: false,
        code: "upstream_blocked",
        message: "不允许指向内网 / 本机 / 链路本地 / metadata 的上游",
      };
    }
  }

  const resolved = await resolveAndCheck(parsed.hostname, { allowlisted });
  if (!resolved.ok) return resolved;

  return { ok: true, origin: parsed.origin };
}

/**
 * 调试：返回校验详情（不含请求头敏感信息）。
 * @param {string} raw
 * @param {ValidateOptions} [options]
 */
export async function debugValidateUpstream(raw, options = {}) {
  const allowlist =
    options.allowlist !== undefined
      ? options.allowlist
      : parseUpstreamAllowlist(process.env.CIALLO_UPSTREAM_ALLOWLIST);
  const parsed = parseUpstreamCandidate(raw);
  const result = await validateUpstreamOrigin(raw, { allowlist });
  return {
    input: String(raw || "").trim() || null,
    parsed: parsed.ok
      ? { origin: parsed.origin, hostname: parsed.hostname }
      : { error: parsed },
    allowlist,
    allowlisted:
      parsed.ok && isOriginAllowlisted(parsed.origin, parsed.hostname, allowlist),
    result,
  };
}

/**
 * @param {import("node:http").IncomingMessage} req
 */
export function readUpstreamRawFromRequest(req) {
  const raw = req.headers["x-ciallo-upstream"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header && String(header).trim()) return String(header).trim();

  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)ciallo_upstream=([^;]+)/);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]).trim();
    } catch {
      return m[1].trim();
    }
  }
  return "";
}
