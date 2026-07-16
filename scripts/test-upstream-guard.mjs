/**
 * SSRF guard for custom upstream origins (+ env allowlist).
 * Run: node scripts/test-upstream-guard.mjs
 */
import {
  parseUpstreamAllowlist,
  validateUpstreamOrigin,
} from "../server/upstream-guard.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

async function expectOk(raw, note, options) {
  const r = await validateUpstreamOrigin(raw, options);
  assert(r.ok === true, `${note}: expected ok for ${raw}, got ${JSON.stringify(r)}`);
  assert(typeof r.origin === "string" && r.origin.length > 0, `${note}: missing origin`);
  return r;
}

async function expectDeny(raw, note, options) {
  const r = await validateUpstreamOrigin(raw, options);
  assert(r.ok === false, `${note}: expected deny for ${raw}, got ${JSON.stringify(r)}`);
  assert(typeof r.message === "string" && r.message.length > 0, `${note}: missing message`);
  return r;
}

// --- allowlist parser ---
{
  const empty = parseUpstreamAllowlist("");
  assert(Array.isArray(empty) && empty.length === 0, "empty allowlist");
  const list = parseUpstreamAllowlist(
    "http://127.0.0.1:8000, host.docker.internal ,192.168.1.10:9000\nlocalhost",
  );
  assert(list.length === 4, `expected 4 entries, got ${list.length}: ${JSON.stringify(list)}`);
  assert(list.includes("http://127.0.0.1:8000"), "origin entry");
  assert(list.includes("host.docker.internal"), "host entry");
  assert(list.includes("192.168.1.10:9000"), "host:port entry");
  assert(list.includes("localhost"), "localhost entry");
}

// --- public HTTPS / HTTP allowed (use resolvable hosts) ---
await expectOk("https://example.com", "public https");
await expectOk("https://example.com/v1", "path stripped to origin");
await expectOk("http://example.com:8080", "public http with port");
{
  const r = await expectOk("https://example.com/v1/images", "origin only");
  assert(r.origin === "https://example.com", `origin should strip path, got ${r.origin}`);
}

// --- protocol ---
await expectDeny("ftp://api.example.com", "ftp blocked");
await expectDeny("file:///etc/passwd", "file blocked");
await expectDeny("javascript:alert(1)", "javascript blocked");
await expectDeny("", "empty blocked");
await expectDeny("not-a-url", "garbage blocked");

// --- loopback / wildcard (no allowlist) ---
await expectDeny("http://127.0.0.1", "loopback v4");
await expectDeny("http://127.0.0.1:8090", "loopback with port");
await expectDeny("http://localhost", "localhost");
await expectDeny("http://LOCALHOST:8000", "localhost case");
await expectDeny("http://0.0.0.0", "0.0.0.0");
await expectDeny("http://[::1]", "loopback v6");
await expectDeny("http://[::1]:8090", "loopback v6 port");

// --- private RFC1918 ---
await expectDeny("http://10.0.0.1", "10/8");
await expectDeny("http://172.16.5.1", "172.16/12");
await expectDeny("http://172.31.255.255", "172.31");
await expectDeny("http://192.168.1.1", "192.168/16");

// --- link-local / metadata ---
await expectDeny("http://169.254.169.254", "AWS/GCP metadata");
await expectDeny("http://169.254.169.254/latest/meta-data/", "metadata path");
await expectDeny("http://metadata.google.internal", "GCP metadata host");
await expectDeny("http://metadata", "metadata short host");

// --- CGNAT / special ---
await expectDeny("http://100.64.0.1", "CGNAT 100.64/10");

// --- IPv6 ULA / link-local / mapped ---
await expectDeny("http://[fc00::1]", "ULA fc00");
await expectDeny("http://[fe80::1]", "link-local fe80");
await expectDeny("http://[::ffff:127.0.0.1]", "ipv4-mapped loopback");
await expectDeny("http://[::ffff:10.0.0.1]", "ipv4-mapped private");

// --- decimal / weird IP forms that parse as private ---
{
  const r = await validateUpstreamOrigin("http://2130706433");
  assert(r.ok === false, `decimal loopback should deny or fail parse: ${JSON.stringify(r)}`);
}

// --- credentials in URL should not be required; still validate host ---
await expectDeny("http://user:pass@127.0.0.1/", "creds + loopback");

// ========== allowlist (CIALLO_UPSTREAM_ALLOWLIST) ==========
const allowLoopback = { allowlist: parseUpstreamAllowlist("http://127.0.0.1:8000") };
await expectOk("http://127.0.0.1:8000", "allowlisted exact origin", allowLoopback);
await expectOk("http://127.0.0.1:8000/v1", "allowlisted origin with path", allowLoopback);
await expectDeny("http://127.0.0.1:8001", "wrong port not allowlisted", allowLoopback);
await expectDeny("http://127.0.0.1", "loopback no port not matching :8000", allowLoopback);

const allowHost = { allowlist: parseUpstreamAllowlist("127.0.0.1") };
await expectOk("http://127.0.0.1:8000", "host allowlist any port", allowHost);
await expectOk("http://127.0.0.1", "host allowlist default port", allowHost);

const allowHostPort = { allowlist: parseUpstreamAllowlist("192.168.1.10:9000") };
await expectOk("http://192.168.1.10:9000", "host:port allowlist", allowHostPort);
await expectDeny("http://192.168.1.10:9001", "wrong port host:port", allowHostPort);

const allowLocalhost = { allowlist: parseUpstreamAllowlist("localhost") };
await expectOk("http://localhost:8000", "localhost host allowlist", allowLocalhost);

// metadata must NEVER be allowlisted
const allowMeta = {
  allowlist: parseUpstreamAllowlist("http://169.254.169.254,metadata.google.internal,metadata"),
};
await expectDeny("http://169.254.169.254", "metadata hard-blocked despite allowlist", allowMeta);
await expectDeny("http://metadata.google.internal", "metadata host hard-blocked", allowMeta);

// env string path (simulate process.env)
{
  const prev = process.env.CIALLO_UPSTREAM_ALLOWLIST;
  process.env.CIALLO_UPSTREAM_ALLOWLIST = "http://127.0.0.1:8000";
  try {
    await expectOk("http://127.0.0.1:8000", "env allowlist via default options");
    await expectDeny("http://10.0.0.1", "env allowlist does not open other private");
  } finally {
    if (prev === undefined) delete process.env.CIALLO_UPSTREAM_ALLOWLIST;
    else process.env.CIALLO_UPSTREAM_ALLOWLIST = prev;
  }
}

console.log("upstream-guard: all assertions passed");
