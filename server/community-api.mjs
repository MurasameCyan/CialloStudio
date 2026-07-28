/**
 * 社区 API（Docker 持久化）
 * - 数据目录：CIALLO_DATA_DIR（默认 /data）
 * - 文件：community.json + share-cooldown.json + queue-policy.json
 * - 监听：CIALLO_COMMUNITY_PORT（默认 8090）
 * - 路径前缀：/api/community/*
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.CIALLO_COMMUNITY_PORT || 8090);
const DATA_DIR = process.env.CIALLO_DATA_DIR || "/data";
const STORE_PATH = path.join(DATA_DIR, "community.json");
const COOLDOWN_PATH = path.join(DATA_DIR, "share-cooldown.json");
const QUEUE_POLICY_PATH = path.join(DATA_DIR, "queue-policy.json");

const MASTER_USER = String(process.env.CIALLO_MASTER_USERNAME || "admin")
  .trim()
  .toLowerCase() || "admin";
const MASTER_PASSWORD = String(process.env.CIALLO_MASTER_PASSWORD || "").trim();
const MASTER_HASH = MASTER_PASSWORD
  ? crypto.createHash("sha256").update(MASTER_PASSWORD, "utf8").digest("hex")
  : "";
const FALLBACK_MASTER_PASSWORD = "admin123";
const ENV_PASSWORD_MARKER = "__env_master__";

const DEFAULT_COOLDOWN = { user: 60, vip: 15 };
/** 普通默认 1 · VIP 默认 3 · 站长不限；普通用户后台默认关 */
const DEFAULT_QUEUE_POLICY = {
  userLimit: 1,
  vipLimit: 3,
  userBackgroundEnabled: false,
};

function uid(prefix) {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function seedStore() {
  const adminId = "user-admin";
  const demoId = "user-demo";
  const postId = "post-seed-1";
  return {
    users: [
      {
        id: adminId,
        username: MASTER_USER,
        password: MASTER_HASH ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD,
        displayName: "站长",
        role: "admin",
        createdAt: Date.now() - 86400000 * 30,
      },
      {
        id: demoId,
        username: "demo",
        password: "demo123",
        displayName: "Demo",
        role: "user",
        createdAt: Date.now() - 86400000 * 7,
      },
    ],
    sessions: {},
    posts: [
      {
        id: postId,
        authorId: demoId,
        authorName: "Demo",
        imageUrl:
          "data:image/svg+xml," +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7aa2ff"/><stop offset="1" stop-color="#c7a0ff"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><text x="50%" y="48%" text-anchor="middle" fill="white" font-size="28" font-family="sans-serif">Ciallo Hall</text><text x="50%" y="56%" text-anchor="middle" fill="white" font-size="16" font-family="sans-serif" opacity="0.85">Docker 持久化示例</text></svg>`,
          ),
        prompt: "a soft gradient abstract, iOS glass, minimal studio",
        model: "grok-imagine-image",
        aspectRatio: "1:1",
        resolution: "1k",
        caption: "欢迎来到分享大厅（数据保存在 Docker volume）",
        likeCount: 2,
        commentCount: 1,
        createdAt: Date.now() - 3600000,
      },
    ],
    comments: [
      {
        id: "cmt-seed-1",
        postId,
        authorId: adminId,
        authorName: "站长",
        body: "光影很舒服，欢迎继续分享～",
        rating: 5,
        createdAt: Date.now() - 1800000,
      },
    ],
    likes: {
      [postId]: [adminId, demoId],
    },
  };
}

function normalizeRole(role) {
  if (role === "admin" || role === "vip" || role === "user") return role;
  return "user";
}

function clampCooldownSec(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(86400, Math.max(0, Math.round(n)));
}

function normalizeCooldown(raw) {
  return {
    user: clampCooldownSec(raw?.user, DEFAULT_COOLDOWN.user),
    vip: clampCooldownSec(raw?.vip, DEFAULT_COOLDOWN.vip),
  };
}

function clampQueueLimit(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function normalizeQueuePolicy(raw) {
  return {
    userLimit: clampQueueLimit(raw?.userLimit, DEFAULT_QUEUE_POLICY.userLimit),
    vipLimit: clampQueueLimit(raw?.vipLimit, DEFAULT_QUEUE_POLICY.vipLimit),
    userBackgroundEnabled: raw?.userBackgroundEnabled === true,
  };
}

function canUseBackground(role, policy) {
  if (role === "admin" || role === "vip") return true;
  if (role === "user") return policy?.userBackgroundEnabled === true;
  return false;
}

function queueLimitForRole(role, policy) {
  const cfg = normalizeQueuePolicy(policy);
  if (role === "admin") return null;
  if (role === "vip") return cfg.vipLimit;
  return cfg.userLimit;
}

function shareCooldownForRole(role, cfg) {
  if (role === "admin") return 0;
  if (role === "vip") return Math.max(0, cfg.vip);
  return Math.max(0, cfg.user);
}

function computeShareRemainSec(cooldownSec, lastShareAt, now = Date.now()) {
  if (cooldownSec <= 0 || typeof lastShareAt !== "number" || lastShareAt <= 0) return 0;
  return Math.max(0, Math.ceil(cooldownSec - (now - lastShareAt) / 1000));
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: normalizeRole(u.role),
    createdAt: u.createdAt,
    banned: u.banned,
    lastShareAt: typeof u.lastShareAt === "number" ? u.lastShareAt : undefined,
  };
}

function syncMasterUser(store) {
  let changed = false;
  for (const u of store.users) {
    if (u.role === "admin" && u.username !== MASTER_USER) {
      u.role = "user";
      changed = true;
    }
  }
  let master = store.users.find((u) => u.username === MASTER_USER);
  if (!master) {
    const legacy = store.users.find((u) => u.id === "user-admin");
    if (legacy) {
      legacy.username = MASTER_USER;
      legacy.displayName = legacy.displayName || "站长";
      legacy.role = "admin";
      legacy.password = MASTER_HASH ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD;
      master = legacy;
      changed = true;
    } else {
      store.users.unshift({
        id: "user-admin",
        username: MASTER_USER,
        password: MASTER_HASH ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD,
        displayName: "站长",
        role: "admin",
        createdAt: Date.now() - 86400000 * 30,
      });
      changed = true;
    }
  } else {
    if (master.role !== "admin") {
      master.role = "admin";
      changed = true;
    }
    if (MASTER_HASH && master.password !== ENV_PASSWORD_MARKER) {
      master.password = ENV_PASSWORD_MARKER;
      changed = true;
    } else if (!MASTER_HASH && master.password === ENV_PASSWORD_MARKER) {
      master.password = FALLBACK_MASTER_PASSWORD;
      changed = true;
    }
  }
  return changed;
}

function loadStore() {
  ensureDataDir();
  try {
    if (!fs.existsSync(STORE_PATH)) {
      const store = seedStore();
      saveStore(store);
      return store;
    }
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const store = JSON.parse(raw);
    if (!store.users || !store.sessions || !store.posts || !store.comments || !store.likes) {
      const next = seedStore();
      saveStore(next);
      return next;
    }
    if (syncMasterUser(store)) saveStore(store);
    return store;
  } catch (err) {
    console.error("[community-api] load store failed, reseeding", err);
    const store = seedStore();
    saveStore(store);
    return store;
  }
}

function saveStore(store) {
  ensureDataDir();
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

function loadCooldown() {
  ensureDataDir();
  try {
    if (!fs.existsSync(COOLDOWN_PATH)) {
      const cfg = { ...DEFAULT_COOLDOWN };
      saveCooldown(cfg);
      return cfg;
    }
    return normalizeCooldown(JSON.parse(fs.readFileSync(COOLDOWN_PATH, "utf8")));
  } catch {
    return { ...DEFAULT_COOLDOWN };
  }
}

function saveCooldown(cfg) {
  ensureDataDir();
  const next = normalizeCooldown(cfg);
  const tmp = `${COOLDOWN_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, COOLDOWN_PATH);
  return next;
}

function loadQueuePolicy() {
  ensureDataDir();
  try {
    if (!fs.existsSync(QUEUE_POLICY_PATH)) {
      const cfg = { ...DEFAULT_QUEUE_POLICY };
      saveQueuePolicy(cfg);
      return cfg;
    }
    return normalizeQueuePolicy(JSON.parse(fs.readFileSync(QUEUE_POLICY_PATH, "utf8")));
  } catch {
    return { ...DEFAULT_QUEUE_POLICY };
  }
}

function saveQueuePolicy(cfg) {
  ensureDataDir();
  const next = normalizeQueuePolicy(cfg);
  const tmp = `${QUEUE_POLICY_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, QUEUE_POLICY_PATH);
  return next;
}

function verifyMasterPassword(password) {
  if (MASTER_HASH) {
    const hash = crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");
    return hash === MASTER_HASH;
  }
  return password === FALLBACK_MASTER_PASSWORD;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("请求体过大"));
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
        reject(new Error("无效 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendError(res, status, message, code = "error") {
  sendJson(res, status, { error: { code, message } });
}

function bearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function withLiked(post, userId, store) {
  const likers = store.likes[post.id] ?? [];
  return {
    ...post,
    likeCount: likers.length,
    likedByMe: userId ? likers.includes(userId) : false,
    commentCount: store.comments.filter((c) => c.postId === post.id).length,
  };
}

function requireUser(store, token) {
  if (!token) throw Object.assign(new Error("请先登录"), { status: 401, code: "unauthorized" });
  const userId = store.sessions[token];
  if (!userId) throw Object.assign(new Error("请先登录"), { status: 401, code: "unauthorized" });
  const user = store.users.find((u) => u.id === userId);
  if (!user || user.banned) {
    if (user?.banned) delete store.sessions[token];
    throw Object.assign(new Error("请先登录"), { status: 401, code: "unauthorized" });
  }
  return user;
}

function requireAdmin(store, token) {
  const user = requireUser(store, token);
  if (user.role !== "admin") {
    throw Object.assign(new Error("需要管理员权限"), { status: 403, code: "forbidden" });
  }
  return user;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = url.pathname;
  if (pathname.startsWith("/api/community")) {
    pathname = pathname.slice("/api/community".length) || "/";
  }
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  if (pathname === "/healthz" || pathname === "/health") {
    sendJson(res, 200, { ok: true, dataDir: DATA_DIR, store: fs.existsSync(STORE_PATH) });
    return;
  }

  const token = bearer(req);
  const store = loadStore();

  try {
    // Auth
    if (req.method === "POST" && pathname === "/auth/register") {
      const body = (await readBody(req)) || {};
      const username = String(body.username || "")
        .trim()
        .toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("用户名需 3–20 位字母数字或下划线");
      if (username === MASTER_USER) throw new Error("该用户名为站长保留，请换一个");
      if (String(body.password || "").length < 6) throw new Error("密码至少 6 位");
      if (store.users.some((u) => u.username === username)) throw new Error("用户名已存在");
      const user = {
        id: uid("user-"),
        username,
        password: String(body.password),
        displayName: String(body.displayName || username).trim().slice(0, 32),
        role: "user",
        createdAt: Date.now(),
      };
      store.users.push(user);
      const tok = uid("tok-");
      store.sessions[tok] = user.id;
      saveStore(store);
      sendJson(res, 200, { token: tok, user: publicUser(user) });
      return;
    }

    if (req.method === "POST" && pathname === "/auth/login") {
      const body = (await readBody(req)) || {};
      const username = String(body.username || "")
        .trim()
        .toLowerCase();
      const password = String(body.password || "");
      let user = store.users.find((u) => u.username === username);
      if (username === MASTER_USER) {
        const ok = verifyMasterPassword(password) || (!MASTER_HASH && user?.password === password);
        if (!ok) throw Object.assign(new Error("用户名或密码错误"), { status: 401 });
        if (!user) {
          user = {
            id: "user-admin",
            username: MASTER_USER,
            password: MASTER_HASH ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD,
            displayName: "站长",
            role: "admin",
            createdAt: Date.now(),
          };
          store.users.unshift(user);
        } else {
          user.role = "admin";
          if (MASTER_HASH) user.password = ENV_PASSWORD_MARKER;
        }
      } else {
        user = store.users.find((u) => u.username === username && u.password === password);
        if (!user) throw Object.assign(new Error("用户名或密码错误"), { status: 401 });
      }
      if (user.banned) throw Object.assign(new Error("账号已被禁用"), { status: 403 });
      const tok = uid("tok-");
      store.sessions[tok] = user.id;
      saveStore(store);
      sendJson(res, 200, { token: tok, user: publicUser(user) });
      return;
    }

    if (req.method === "POST" && pathname === "/auth/logout") {
      if (token && store.sessions[token]) {
        delete store.sessions[token];
        saveStore(store);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/auth/me") {
      if (!token) {
        sendJson(res, 200, null);
        return;
      }
      const userId = store.sessions[token];
      if (!userId) {
        sendJson(res, 200, null);
        return;
      }
      const user = store.users.find((u) => u.id === userId);
      if (!user || user.banned) {
        if (user?.banned) {
          delete store.sessions[token];
          saveStore(store);
        }
        sendJson(res, 200, null);
        return;
      }
      sendJson(res, 200, publicUser(user));
      return;
    }

    // Posts
    if (req.method === "GET" && pathname === "/posts") {
      const userId = token ? store.sessions[token] : undefined;
      let items = [...store.posts].sort((a, b) => b.createdAt - a.createdAt);
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q) {
        items = items.filter(
          (p) =>
            p.prompt.toLowerCase().includes(q) ||
            (p.caption || "").toLowerCase().includes(q) ||
            p.authorName.toLowerCase().includes(q),
        );
      }
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20) || 20));
      const cursor = url.searchParams.get("cursor") || "";
      const start = cursor ? Math.max(0, items.findIndex((p) => p.id === cursor) + 1) : 0;
      const slice = items.slice(start, start + limit).map((p) => withLiked(p, userId, store));
      const next = items[start + limit];
      sendJson(res, 200, { items: slice, nextCursor: next?.id });
      return;
    }

    const postMatch = pathname.match(/^\/posts\/([^/]+)(.*)$/);
    if (postMatch) {
      const postId = decodeURIComponent(postMatch[1]);
      const rest = postMatch[2] || "";

      if (req.method === "GET" && rest === "") {
        const userId = token ? store.sessions[token] : undefined;
        const post = store.posts.find((p) => p.id === postId);
        if (!post) throw Object.assign(new Error("帖子不存在"), { status: 404 });
        sendJson(res, 200, withLiked(post, userId, store));
        return;
      }

      if (req.method === "POST" && rest === "" && pathname === "/posts") {
        // handled below
      }

      if (req.method === "DELETE" && rest === "") {
        const me = requireUser(store, token);
        const post = store.posts.find((p) => p.id === postId);
        if (!post) throw Object.assign(new Error("帖子不存在"), { status: 404 });
        if (post.authorId !== me.id && me.role !== "admin") {
          throw Object.assign(new Error("无权删除"), { status: 403 });
        }
        store.posts = store.posts.filter((p) => p.id !== postId);
        store.comments = store.comments.filter((c) => c.postId !== postId);
        delete store.likes[postId];
        saveStore(store);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && rest === "/like") {
        const me = requireUser(store, token);
        const post = store.posts.find((p) => p.id === postId);
        if (!post) throw Object.assign(new Error("帖子不存在"), { status: 404 });
        const set = new Set(store.likes[postId] ?? []);
        if (set.has(me.id)) set.delete(me.id);
        else set.add(me.id);
        store.likes[postId] = [...set];
        saveStore(store);
        sendJson(res, 200, withLiked(post, me.id, store));
        return;
      }

      if (req.method === "GET" && rest === "/comments") {
        const list = store.comments
          .filter((c) => c.postId === postId)
          .sort((a, b) => a.createdAt - b.createdAt);
        sendJson(res, 200, list);
        return;
      }

      if (req.method === "POST" && rest === "/comments") {
        const me = requireUser(store, token);
        if (!store.posts.some((p) => p.id === postId)) throw new Error("帖子不存在");
        const body = (await readBody(req)) || {};
        const text = String(body.body || "").trim();
        if (!text) throw new Error("评论不能为空");
        const rating =
          typeof body.rating === "number" && body.rating >= 1 && body.rating <= 5
            ? Math.round(body.rating)
            : undefined;
        const cmt = {
          id: uid("cmt-"),
          postId,
          authorId: me.id,
          authorName: me.displayName,
          body: text.slice(0, 500),
          rating,
          createdAt: Date.now(),
        };
        store.comments.push(cmt);
        saveStore(store);
        sendJson(res, 200, cmt);
        return;
      }
    }

    if (req.method === "POST" && pathname === "/posts") {
      const me = requireUser(store, token);
      const body = (await readBody(req)) || {};
      if (!String(body.imageUrl || "").trim()) throw new Error("缺少图片");
      const cfg = loadCooldown();
      const role = normalizeRole(me.role);
      const cooldownSec = shareCooldownForRole(role, cfg);
      const remain = computeShareRemainSec(cooldownSec, me.lastShareAt);
      if (remain > 0) throw new Error(`分享冷却中，请 ${remain} 秒后再试`);
      const post = {
        id: uid("post-"),
        authorId: me.id,
        authorName: me.displayName,
        imageUrl: String(body.imageUrl).trim(),
        mediaId: body.mediaId,
        prompt: String(body.prompt || "").trim() || "(无 prompt)",
        model: body.model,
        aspectRatio: body.aspectRatio,
        resolution: body.resolution,
        caption: body.caption ? String(body.caption).trim() : undefined,
        likeCount: 0,
        commentCount: 0,
        createdAt: Date.now(),
        likedByMe: false,
      };
      store.posts.unshift(post);
      store.likes[post.id] = [];
      me.lastShareAt = Date.now();
      saveStore(store);
      sendJson(res, 200, post);
      return;
    }

    // Me share status
    if (req.method === "GET" && pathname === "/me/share-status") {
      const me = requireUser(store, token);
      const cfg = loadCooldown();
      const role = normalizeRole(me.role);
      const cooldownSec = shareCooldownForRole(role, cfg);
      const lastShareAt = typeof me.lastShareAt === "number" ? me.lastShareAt : undefined;
      sendJson(res, 200, {
        role,
        cooldownSec,
        lastShareAt,
        remainSec: computeShareRemainSec(cooldownSec, lastShareAt),
      });
      return;
    }

    // Admin
    if (req.method === "GET" && pathname === "/admin/users") {
      requireAdmin(store, token);
      const users = store.users.map(publicUser).sort((a, b) => b.createdAt - a.createdAt);
      sendJson(res, 200, users);
      return;
    }

    const banMatch = pathname.match(/^\/admin\/users\/([^/]+)\/ban$/);
    if (req.method === "POST" && banMatch) {
      const admin = requireAdmin(store, token);
      const userId = decodeURIComponent(banMatch[1]);
      const body = (await readBody(req)) || {};
      const user = store.users.find((u) => u.id === userId);
      if (!user) throw new Error("用户不存在");
      if (user.role === "admin") throw new Error("不能禁用管理员");
      if (user.id === admin.id) throw new Error("不能禁用自己");
      user.banned = Boolean(body.banned);
      if (user.banned) {
        for (const [tok, uidVal] of Object.entries(store.sessions)) {
          if (uidVal === user.id) delete store.sessions[tok];
        }
      }
      saveStore(store);
      sendJson(res, 200, publicUser(user));
      return;
    }

    const roleMatch = pathname.match(/^\/admin\/users\/([^/]+)\/role$/);
    if (req.method === "POST" && roleMatch) {
      const admin = requireAdmin(store, token);
      const userId = decodeURIComponent(roleMatch[1]);
      const body = (await readBody(req)) || {};
      const role = body.role;
      if (role !== "user" && role !== "vip") throw new Error("仅可设为普通用户或 VIP");
      const user = store.users.find((u) => u.id === userId);
      if (!user) throw new Error("用户不存在");
      if (user.role === "admin" || user.id === admin.id) throw new Error("不能修改站长分组");
      user.role = role;
      saveStore(store);
      sendJson(res, 200, publicUser(user));
      return;
    }

    const delUserMatch = pathname.match(/^\/admin\/users\/([^/]+)$/);
    if (req.method === "DELETE" && delUserMatch) {
      const admin = requireAdmin(store, token);
      const userId = decodeURIComponent(delUserMatch[1]);
      const user = store.users.find((u) => u.id === userId);
      if (!user) throw new Error("用户不存在");
      if (user.role === "admin") throw new Error("不能删除站长/管理员");
      if (user.id === admin.id) throw new Error("不能删除自己");
      for (const [tok, uidVal] of Object.entries(store.sessions)) {
        if (uidVal === user.id) delete store.sessions[tok];
      }
      for (const postId of Object.keys(store.likes)) {
        store.likes[postId] = (store.likes[postId] ?? []).filter((id) => id !== user.id);
      }
      store.users = store.users.filter((u) => u.id !== user.id);
      saveStore(store);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/admin/share-cooldown") {
      requireAdmin(store, token);
      sendJson(res, 200, loadCooldown());
      return;
    }

    if (req.method === "PUT" && pathname === "/admin/share-cooldown") {
      requireAdmin(store, token);
      const body = (await readBody(req)) || {};
      const next = saveCooldown({ ...loadCooldown(), ...body });
      sendJson(res, 200, next);
      return;
    }

    if (req.method === "GET" && pathname === "/admin/queue-policy") {
      requireAdmin(store, token);
      sendJson(res, 200, loadQueuePolicy());
      return;
    }

    if (req.method === "PUT" && pathname === "/admin/queue-policy") {
      requireAdmin(store, token);
      const body = (await readBody(req)) || {};
      const next = saveQueuePolicy({ ...loadQueuePolicy(), ...body });
      sendJson(res, 200, next);
      return;
    }

    // 登录用户可读：自己的后台权限与队列上限
    if (req.method === "GET" && pathname === "/me/queue-policy") {
      const me = requireUser(store, token);
      const role = normalizeRole(me.role);
      const policy = loadQueuePolicy();
      sendJson(res, 200, {
        ...policy,
        canBackground: canUseBackground(role, policy),
        myLimit: queueLimitForRole(role, policy),
      });
      return;
    }

    sendError(res, 404, `未找到 ${req.method} ${pathname}`, "not_found");
  } catch (err) {
    const status = err?.status || 400;
    const message = err instanceof Error ? err.message : String(err);
    const code = err?.code || "error";
    if (status >= 500) console.error("[community-api]", err);
    sendError(res, status, message, code);
  }
}

ensureDataDir();
// touch store on boot
loadStore();
loadCooldown();
loadQueuePolicy();

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[community-api] listening 127.0.0.1:${PORT} data=${DATA_DIR} master=${MASTER_USER} hash=${MASTER_HASH ? "env" : "fallback"}`,
  );
});
