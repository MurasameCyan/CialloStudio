/**
 * Ciallo 服务端生图任务队列（VIP / 站长）
 *
 * 路径前缀：/api/tasks/*
 * 鉴权：Bearer token → community-api /auth/me（仅 admin|vip）
 * 上游：用户提交的 baseUrl + apiKey，经 SSRF 校验后服务端代发 /images/*
 *
 * 监听：CIALLO_TASK_QUEUE_PORT（默认 8092）
 * 数据：CIALLO_DATA_DIR/tasks.json + CIALLO_DATA_DIR/task-images/
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { validateUpstreamOrigin } from "./upstream-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CIALLO_TASK_QUEUE_PORT || 8092);
const HOST = process.env.CIALLO_TASK_QUEUE_HOST || "127.0.0.1";
const DATA_DIR = process.env.CIALLO_DATA_DIR || path.join(__dirname, "..", ".data");
const STORE_PATH = path.join(DATA_DIR, "tasks.json");
const IMAGE_DIR = path.join(DATA_DIR, "task-images");
const COMMUNITY_BASE = (
  process.env.CIALLO_TASK_COMMUNITY_URL ||
  `http://127.0.0.1:${process.env.CIALLO_COMMUNITY_PORT || 8090}`
).replace(/\/+$/, "");

const MAX_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.CIALLO_TASK_CONCURRENCY || 2) || 2),
);
const MAX_PENDING_PER_USER = Math.max(
  1,
  Math.min(40, Number(process.env.CIALLO_TASK_MAX_PENDING_PER_USER || 12) || 12),
);
const TASK_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.CIALLO_TASK_TTL_MS || 12 * 60 * 60 * 1000) || 12 * 60 * 60 * 1000,
);
const MAX_BODY = 12 * 1024 * 1024;
const POLL_DRAIN_MS = 250;

/** @typedef {'queued'|'running'|'done'|'failed'|'cancelled'} TaskStatus */

/**
 * @typedef {{
 *   id: string,
 *   ownerId: string,
 *   ownerName: string,
 *   status: TaskStatus,
 *   prompt: string,
 *   model: string,
 *   baseUrl: string,
 *   aspectRatio: string,
 *   resolution: string,
 *   imageUrl?: string,
 *   autoRetry: boolean,
 *   attempt: number,
 *   error?: string,
 *   createdAt: number,
 *   updatedAt: number,
 *   finishedAt?: number,
 *   batchId: string,
 *   variant: number,
 *   variants: number,
 *   clientJobId?: string,
 *   hasReference: boolean,
 * }} PublicTask
 */

/** @type {Map<string, any>} */
const tasks = new Map();
/** @type {string[]} */
const queue = [];
/** @type {Set<string>} */
const running = new Set();
/** apiKey 仅内存，不落盘 */
const secrets = new Map();
/** 参考图 data URL 仅内存 */
const references = new Map();

let drainTimer = null;
let persistTimer = null;
let shuttingDown = false;

function uid(prefix = "task-") {
  return `${prefix}${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

function now() {
  return Date.now();
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function sendError(res, status, message, code = "error") {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体过大"), { status: 413, code: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("无效 JSON"), { status: 400, code: "bad_json" }));
      }
    });
    req.on("error", reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function canBackground(role) {
  return role === "admin" || role === "vip";
}

async function requireVipOrAdmin(req) {
  const token = bearer(req);
  if (!token) {
    throw Object.assign(new Error("请先登录"), { status: 401, code: "unauthorized" });
  }
  const url = `${COMMUNITY_BASE}/auth/me`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw Object.assign(new Error("登录校验失败"), { status: 401, code: "unauthorized" });
  }
  const user = await res.json();
  if (!user || !user.id) {
    throw Object.assign(new Error("请先登录"), { status: 401, code: "unauthorized" });
  }
  if (!canBackground(user.role)) {
    throw Object.assign(new Error("后台任务仅对站长与 VIP 开放"), {
      status: 403,
      code: "forbidden",
    });
  }
  return user;
}

function publicTask(task) {
  return {
    id: task.id,
    ownerId: task.ownerId,
    ownerName: task.ownerName,
    status: task.status,
    prompt: task.prompt,
    model: task.model,
    baseUrl: task.baseUrl,
    aspectRatio: task.aspectRatio,
    resolution: task.resolution,
    imageUrl: task.imageUrl,
    autoRetry: task.autoRetry === true,
    attempt: task.attempt || 0,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    batchId: task.batchId,
    variant: task.variant,
    variants: task.variants,
    clientJobId: task.clientJobId,
    hasReference: Boolean(task.hasReference),
  };
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistStore();
  }, 400);
}

function persistStore() {
  try {
    ensureDirs();
    const list = [...tasks.values()].map((t) => ({
      ...publicTask(t),
      // 不落 apiKey / reference
    }));
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: list }, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("[task-queue] persist failed", e);
  }
}

function loadStore() {
  ensureDirs();
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const list = Array.isArray(raw?.tasks) ? raw.tasks : [];
    const t = now();
    for (const item of list) {
      if (!item?.id) continue;
      // 重启后进行中任务标记失败（无密钥无法续跑）
      let status = item.status;
      let error = item.error;
      if (status === "queued" || status === "running") {
        status = "failed";
        error = error || "服务重启，未完成任务已中断，请重新提交";
      }
      if (item.finishedAt && t - item.finishedAt > TASK_TTL_MS) continue;
      tasks.set(item.id, {
        ...item,
        status,
        error,
        updatedAt: t,
        finishedAt: item.finishedAt || (status === "failed" || status === "done" ? t : undefined),
      });
    }
    console.log(`[task-queue] loaded ${tasks.size} tasks from disk`);
  } catch (e) {
    console.error("[task-queue] load store failed", e);
  }
}

function cleanupExpired() {
  const t = now();
  let removed = 0;
  for (const [id, task] of tasks) {
    const anchor = task.finishedAt || task.updatedAt || task.createdAt || 0;
    if (t - anchor > TASK_TTL_MS) {
      tasks.delete(id);
      secrets.delete(id);
      references.delete(id);
      try {
        const img = path.join(IMAGE_DIR, `${id}.img`);
        if (fs.existsSync(img)) fs.unlinkSync(img);
      } catch {
        /* ignore */
      }
      removed += 1;
    }
  }
  if (removed) {
    console.log(`[task-queue] expired cleanup removed=${removed}`);
    schedulePersist();
  }
}

function pendingCountForUser(ownerId) {
  let n = 0;
  for (const task of tasks.values()) {
    if (task.ownerId !== ownerId) continue;
    if (task.status === "queued" || task.status === "running") n += 1;
  }
  return n;
}

function queueStats() {
  let queuedCount = 0;
  let runningCount = 0;
  let doneCount = 0;
  let failedCount = 0;
  for (const task of tasks.values()) {
    if (task.status === "queued") queuedCount += 1;
    else if (task.status === "running") runningCount += 1;
    else if (task.status === "done") doneCount += 1;
    else if (task.status === "failed" || task.status === "cancelled") failedCount += 1;
  }
  return {
    queuedCount,
    runningCount,
    doneCount,
    failedCount,
    concurrencyLimit: MAX_CONCURRENCY,
    acceptingNewTasks: !shuttingDown,
  };
}

function scheduleDrain() {
  if (drainTimer || shuttingDown) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainQueue();
  }, POLL_DRAIN_MS);
}

async function drainQueue() {
  while (!shuttingDown && running.size < MAX_CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    const task = tasks.get(id);
    if (!task || task.status !== "queued") continue;
    running.add(id);
    void runOne(id).finally(() => {
      running.delete(id);
      scheduleDrain();
    });
  }
}

function isRetryableError(err) {
  if (!err) return true;
  const status = Number(err.status || err.statusCode || 0);
  if (status === 401 || status === 403 || status === 400) return false;
  const code = String(err.code || "");
  if (code === "missing_reference_image" || code === "missing_api_key" || code === "upstream_blocked") {
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeBaseUrl(raw) {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    // 保证以 /v1 结尾更贴近本项目约定
    let p = u.pathname.replace(/\/+$/, "");
    if (!p || p === "/") p = "/v1";
    if (!/\/v1$/i.test(p)) p = `${p}/v1`.replace(/\/+/g, "/");
    return `${u.origin}${p}`;
  } catch {
    return s;
  }
}

function httpRequestJson(targetUrl, { method = "GET", headers = {}, body, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {}),
          ...headers,
        },
        timeout: timeoutMs,
        servername: parsed.hostname,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            json,
            raw,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("上游超时"), { status: 504 })));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function callUpstreamGenerate(task) {
  const secret = secrets.get(task.id);
  if (!secret?.apiKey) {
    throw Object.assign(new Error("任务密钥已失效，请重新提交"), {
      status: 400,
      code: "missing_api_key",
    });
  }
  const checked = await validateUpstreamOrigin(task.baseUrl);
  if (!checked.ok) {
    throw Object.assign(new Error(checked.message || "上游被拒绝"), {
      status: 403,
      code: checked.code || "upstream_blocked",
    });
  }
  const base = normalizeBaseUrl(task.baseUrl);
  const ref = references.get(task.id);
  const hasRef = typeof ref === "string" && ref.trim();
  const pathName = hasRef ? "/images/edits" : "/images/generations";
  const url = `${base.replace(/\/+$/, "")}${pathName}`;

  let body;
  if (hasRef) {
    const resolutionRaw = String(task.resolution || "1k").trim().toLowerCase();
    const resolution = resolutionRaw === "2k" ? "2k" : "1k";
    body = {
      model: task.model,
      prompt: task.prompt,
      n: 1,
      resolution,
      response_format: "url",
      image: { url: ref },
    };
  } else {
    body = {
      model: task.model,
      prompt: task.prompt,
      n: 1,
      aspect_ratio: task.aspectRatio || "1:1",
      resolution: task.resolution || "1k",
      response_format: "url",
      stream: false,
    };
  }

  const res = await httpRequestJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret.apiKey}` },
    body,
    timeoutMs: 240000,
  });

  if (res.status < 200 || res.status >= 300) {
    const msg =
      res.json?.error?.message ||
      res.json?.message ||
      res.raw?.slice(0, 200) ||
      `上游 HTTP ${res.status}`;
    throw Object.assign(new Error(msg), {
      status: res.status,
      code: res.json?.error?.code || "upstream_error",
    });
  }

  const data = res.json?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw Object.assign(new Error("生图响应中没有图片"), {
      status: 200,
      code: "invalid_response",
    });
  }
  const first = data[0];
  if (typeof first?.b64_json === "string" && first.b64_json.trim()) {
    const mime =
      typeof first.mime_type === "string" && first.mime_type.trim()
        ? first.mime_type
        : "image/png";
    return `data:${mime};base64,${first.b64_json}`;
  }
  if (typeof first?.url === "string" && first.url.trim()) {
    return first.url.trim();
  }
  throw Object.assign(new Error("未返回图片 URL"), { status: 200, code: "invalid_response" });
}

async function runOne(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.status = "running";
  task.updatedAt = now();
  task.error = undefined;
  schedulePersist();

  let attempt = 0;
  for (;;) {
    attempt += 1;
    task.attempt = attempt;
    task.updatedAt = now();
    try {
      const imageUrl = await callUpstreamGenerate(task);
      task.status = "done";
      task.imageUrl = imageUrl;
      task.error = undefined;
      task.finishedAt = now();
      task.updatedAt = task.finishedAt;
      secrets.delete(taskId);
      references.delete(taskId);
      schedulePersist();
      console.log(`[task-queue] done ${taskId} attempt=${attempt}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = task.autoRetry === true && isRetryableError(err);
      console.warn(`[task-queue] fail ${taskId} attempt=${attempt} retry=${retry}`, message);
      if (!retry) {
        task.status = "failed";
        task.error = message.slice(0, 400);
        task.finishedAt = now();
        task.updatedAt = task.finishedAt;
        secrets.delete(taskId);
        references.delete(taskId);
        schedulePersist();
        return;
      }
      const waitMs = Math.min(8000, 1000 * 2 ** Math.min(attempt - 1, 3));
      task.error = `自动重试中 · 第 ${attempt} 次失败：${message.slice(0, 120)}`;
      task.updatedAt = now();
      schedulePersist();
      await sleep(waitMs);
      // 若期间被取消
      const latest = tasks.get(taskId);
      if (!latest || latest.status === "cancelled") return;
    }
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function createTasks(body, user) {
  if (shuttingDown) {
    throw Object.assign(new Error("服务关闭中，暂不接受新任务"), {
      status: 503,
      code: "not_accepting",
    });
  }
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    throw Object.assign(new Error("缺少 API Key"), { status: 400, code: "missing_api_key" });
  }
  const baseUrl = normalizeBaseUrl(body?.baseUrl);
  if (!baseUrl) {
    throw Object.assign(new Error("缺少 API Base URL"), { status: 400, code: "missing_base_url" });
  }
  const checked = await validateUpstreamOrigin(baseUrl);
  if (!checked.ok) {
    throw Object.assign(new Error(checked.message || "上游被拒绝"), {
      status: 403,
      code: checked.code || "upstream_blocked",
    });
  }

  const model = String(body?.model || "").trim();
  if (!model) {
    throw Object.assign(new Error("缺少模型"), { status: 400, code: "missing_model" });
  }

  /** @type {Array<{prompt:string, clientJobId?:string, variant?:number, variants?:number, batchId?:string}>} */
  let items = [];
  if (Array.isArray(body?.jobs) && body.jobs.length > 0) {
    items = body.jobs
      .map((j) => ({
        prompt: String(j?.prompt || "").trim(),
        clientJobId: typeof j?.clientJobId === "string" ? j.clientJobId : undefined,
        variant: clampInt(j?.variant, 1, 40, 1),
        variants: clampInt(j?.variants, 1, 40, 1),
        batchId: typeof j?.batchId === "string" ? j.batchId : undefined,
      }))
      .filter((j) => j.prompt);
  } else {
    const prompt = String(body?.prompt || "").trim();
    if (!prompt) {
      throw Object.assign(new Error("缺少提示词"), { status: 400, code: "missing_prompt" });
    }
    const count = clampInt(body?.count ?? body?.n, 1, 20, 1);
    for (let i = 1; i <= count; i += 1) {
      items.push({ prompt, variant: i, variants: count });
    }
  }
  if (items.length === 0) {
    throw Object.assign(new Error("没有有效任务"), { status: 400, code: "empty_jobs" });
  }
  if (items.length > 20) {
    throw Object.assign(new Error("单次最多 20 个子任务"), { status: 400, code: "too_many_jobs" });
  }

  const pending = pendingCountForUser(user.id);
  if (pending + items.length > MAX_PENDING_PER_USER) {
    throw Object.assign(
      new Error(`排队中任务过多（上限 ${MAX_PENDING_PER_USER}），请稍后再试`),
      { status: 429, code: "too_many_pending" },
    );
  }

  const aspectRatio = String(body?.aspectRatio || "1:1").trim() || "1:1";
  const resolution = String(body?.resolution || "1k").trim() || "1k";
  const autoRetry = body?.autoRetry === true;
  const ref =
    typeof body?.referenceImageUrl === "string" && body.referenceImageUrl.trim()
      ? body.referenceImageUrl.trim()
      : "";
  if (ref && ref.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error("参考图过大"), { status: 413, code: "reference_too_large" });
  }

  const batchId = typeof body?.batchId === "string" && body.batchId ? body.batchId : uid("batch-");
  const created = [];
  const t = now();
  for (const item of items) {
    const id = uid("task-");
    const task = {
      id,
      ownerId: user.id,
      ownerName: user.displayName || user.username || user.id,
      status: "queued",
      prompt: item.prompt,
      model,
      baseUrl,
      aspectRatio,
      resolution,
      autoRetry,
      attempt: 0,
      createdAt: t,
      updatedAt: t,
      batchId: item.batchId || batchId,
      variant: item.variant || created.length + 1,
      variants: item.variants || items.length,
      clientJobId: item.clientJobId,
      hasReference: Boolean(ref),
    };
    tasks.set(id, task);
    secrets.set(id, { apiKey });
    if (ref) references.set(id, ref);
    queue.push(id);
    created.push(publicTask(task));
  }
  schedulePersist();
  scheduleDrain();
  console.log(
    `[task-queue] enqueue n=${created.length} user=${user.username || user.id} model=${model}`,
  );
  return { batchId, tasks: created, stats: queueStats() };
}

function listTasksForUser(user, { status, limit = 50 } = {}) {
  const lim = clampInt(limit, 1, 100, 50);
  const all = [...tasks.values()]
    .filter((t) => t.ownerId === user.id)
    .filter((t) => (status ? t.status === status : true))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, lim)
    .map(publicTask);
  return all;
}

function getTaskForUser(user, id) {
  const task = tasks.get(id);
  if (!task) return null;
  if (task.ownerId !== user.id && user.role !== "admin") {
    throw Object.assign(new Error("无权查看该任务"), { status: 403, code: "forbidden" });
  }
  return publicTask(task);
}

function cancelTaskForUser(user, id) {
  const task = tasks.get(id);
  if (!task) {
    throw Object.assign(new Error("任务不存在"), { status: 404, code: "not_found" });
  }
  if (task.ownerId !== user.id && user.role !== "admin") {
    throw Object.assign(new Error("无权取消该任务"), { status: 403, code: "forbidden" });
  }
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
    return publicTask(task);
  }
  // 从排队移除
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
  task.status = "cancelled";
  task.error = "已取消";
  task.finishedAt = now();
  task.updatedAt = task.finishedAt;
  secrets.delete(id);
  references.delete(id);
  schedulePersist();
  return publicTask(task);
}

function cancelBatchForUser(user, batchId) {
  const out = [];
  for (const task of tasks.values()) {
    if (task.batchId !== batchId) continue;
    if (task.ownerId !== user.id && user.role !== "admin") continue;
    if (task.status === "queued" || task.status === "running") {
      out.push(cancelTaskForUser(user, task.id));
    }
  }
  return out;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = url.pathname;
  if (pathname.startsWith("/api/tasks")) {
    pathname = pathname.slice("/api/tasks".length) || "/";
  }
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  if (pathname === "/healthz" || pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "ciallo-task-queue",
      ...queueStats(),
      communityBase: COMMUNITY_BASE,
    });
    return;
  }

  try {
    const user = await requireVipOrAdmin(req);

    if (req.method === "GET" && pathname === "/stats") {
      sendJson(res, 200, {
        ...queueStats(),
        minePending: pendingCountForUser(user.id),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/tasks") {
      const status = url.searchParams.get("status") || undefined;
      const limit = url.searchParams.get("limit");
      sendJson(res, 200, {
        items: listTasksForUser(user, { status, limit }),
        stats: queueStats(),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/tasks") {
      const body = (await readBody(req)) || {};
      const result = await createTasks(body, user);
      sendJson(res, 202, result);
      return;
    }

    const one = pathname.match(/^\/tasks\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (req.method === "GET") {
        const task = getTaskForUser(user, id);
        if (!task) {
          sendError(res, 404, "任务不存在", "not_found");
          return;
        }
        sendJson(res, 200, task);
        return;
      }
      if (req.method === "DELETE") {
        sendJson(res, 200, cancelTaskForUser(user, id));
        return;
      }
    }

    const batch = pathname.match(/^\/batches\/([^/]+)\/cancel$/);
    if (batch && req.method === "POST") {
      const batchId = decodeURIComponent(batch[1]);
      sendJson(res, 200, { items: cancelBatchForUser(user, batchId) });
      return;
    }

    sendError(res, 404, "未知路径", "not_found");
  } catch (e) {
    const status = Number(e?.status || e?.statusCode || 500);
    const code = e?.code || "error";
    const message = e instanceof Error ? e.message : String(e);
    if (status >= 500) console.error("[task-queue]", message);
    sendError(res, status, message, code);
  }
}

loadStore();
cleanupExpired();
setInterval(cleanupExpired, 5 * 60 * 1000).unref?.();
scheduleDrain();

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[task-queue] listening ${HOST}:${PORT} data=${DATA_DIR} concurrency=${MAX_CONCURRENCY} community=${COMMUNITY_BASE}`,
  );
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[task-queue] shutting down…");
  persistStore();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
