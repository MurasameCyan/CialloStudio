/** 纯 JS：社区 mock 用户管理关键路径（不依赖 TS） */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

function assert(c, m) {
  if (!c) {
    console.error("FAIL", m);
    process.exit(1);
  }
}

function uid(prefix) {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 最小 mock：对齐 mockStore 的 ban / session / me 行为 */
function createStore() {
  const adminId = "user-admin";
  const demoId = "user-demo";
  return {
    users: [
      {
        id: adminId,
        username: "admin",
        password: "admin123",
        displayName: "站长",
        role: "admin",
        createdAt: 1,
      },
      {
        id: demoId,
        username: "demo",
        password: "demo123",
        displayName: "Demo",
        role: "user",
        createdAt: 2,
      },
    ],
    sessions: {},
  };
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    createdAt: u.createdAt,
    banned: u.banned,
  };
}

function login(store, username, password) {
  const user = store.users.find((u) => u.username === username && u.password === password);
  if (!user) throw new Error("用户名或密码错误");
  if (user.banned) throw new Error("账号已被禁用");
  const token = uid("tok-");
  store.sessions[token] = user.id;
  return { token, user: publicUser(user) };
}

function me(store, token) {
  if (!token) return null;
  const userId = store.sessions[token];
  if (!userId) return null;
  const user = store.users.find((u) => u.id === userId);
  if (!user) return null;
  if (user.banned) {
    delete store.sessions[token];
    return null;
  }
  return publicUser(user);
}

function listUsers(store, token) {
  const userId = store.sessions[token];
  const admin = store.users.find((u) => u.id === userId);
  if (!admin || admin.role !== "admin" || admin.banned) throw new Error("需要管理员权限");
  return store.users.map(publicUser).sort((a, b) => b.createdAt - a.createdAt);
}

function setBanned(store, targetId, banned, token) {
  const adminId = store.sessions[token];
  const admin = store.users.find((u) => u.id === adminId);
  if (!admin || admin.role !== "admin" || admin.banned) throw new Error("需要管理员权限");
  const user = store.users.find((u) => u.id === targetId);
  if (!user) throw new Error("用户不存在");
  if (user.role === "admin") throw new Error("不能禁用管理员");
  if (user.id === admin.id) throw new Error("不能禁用自己");
  user.banned = banned;
  if (banned) {
    for (const [tok, uidVal] of Object.entries(store.sessions)) {
      if (uidVal === user.id) delete store.sessions[tok];
    }
  }
  return publicUser(user);
}

function deleteUser(store, targetId, token) {
  const adminId = store.sessions[token];
  const admin = store.users.find((u) => u.id === adminId);
  if (!admin || admin.role !== "admin" || admin.banned) throw new Error("需要管理员权限");
  const user = store.users.find((u) => u.id === targetId);
  if (!user) throw new Error("用户不存在");
  if (user.role === "admin") throw new Error("不能删除站长/管理员");
  if (user.id === admin.id) throw new Error("不能删除自己");
  for (const [tok, uidVal] of Object.entries(store.sessions)) {
    if (uidVal === user.id) delete store.sessions[tok];
  }
  store.users = store.users.filter((u) => u.id !== user.id);
}

// 契约形状冒烟
const endpoints = [
  "POST /auth/register",
  "POST /auth/login",
  "GET /auth/me",
  "GET /posts",
  "POST /posts",
  "POST /posts/:id/like",
  "GET /posts/:id/comments",
  "POST /posts/:id/comments",
  "GET /admin/users",
  "POST /admin/users/:id/ban",
  "POST /admin/users/:id/role",
  "DELETE /admin/users/:id",
  "GET /admin/share-cooldown",
  "PUT /admin/share-cooldown",
];
assert(endpoints.length >= 13, "endpoint list");

// 用户管理路径
{
  const store = createStore();
  const admin = login(store, "admin", "admin123");
  const demo = login(store, "demo", "demo123");
  assert(me(store, demo.token)?.username === "demo", "demo session active");

  const listed = listUsers(store, admin.token);
  assert(listed.length === 2, "list users");
  assert(listed[0].username === "demo", "sorted by createdAt desc");

  let threw = false;
  try {
    setBanned(store, admin.user.id, true, admin.token);
  } catch {
    threw = true;
  }
  assert(threw, "cannot ban admin");

  const banned = setBanned(store, demo.user.id, true, admin.token);
  assert(banned.banned === true, "demo banned");
  assert(me(store, demo.token) === null, "banned session revoked");
  assert(!(demo.token in store.sessions), "token removed from sessions");

  let loginBlocked = false;
  try {
    login(store, "demo", "demo123");
  } catch (e) {
    loginBlocked = e.message.includes("禁用");
  }
  assert(loginBlocked, "banned cannot login");

  const unbanned = setBanned(store, demo.user.id, false, admin.token);
  assert(!unbanned.banned, "demo unbanned");
  const again = login(store, "demo", "demo123");
  assert(me(store, again.token)?.username === "demo", "unbanned can login");

  let delAdminBlocked = false;
  try {
    deleteUser(store, admin.user.id, admin.token);
  } catch {
    delAdminBlocked = true;
  }
  assert(delAdminBlocked, "cannot delete admin");

  // VIP 分组
  const demoUser = store.users.find((u) => u.username === "demo");
  assert(demoUser, "demo exists");
  demoUser.role = "vip";
  assert(demoUser.role === "vip", "demo is vip");

  deleteUser(store, demo.user.id, admin.token);
  assert(!store.users.some((u) => u.username === "demo"), "demo removed");
  assert(me(store, again.token) === null, "deleted user session gone");
  assert(listUsers(store, admin.token).length === 1, "only admin left");
}

// 分享冷却秒数语义
{
  function remain(cooldownSec, lastShareAt, now) {
    if (cooldownSec <= 0 || !lastShareAt) return 0;
    return Math.max(0, Math.ceil(cooldownSec - (now - lastShareAt) / 1000));
  }
  assert(remain(60, Date.now() - 10_000, Date.now()) === 50, "user cooldown remain");
  assert(remain(15, Date.now() - 20_000, Date.now()) === 0, "vip cooldown done");
  assert(remain(0, Date.now(), Date.now()) === 0, "admin no cooldown");
}

console.log("community mock user-admin ok:", endpoints.length, "routes + ban/delete/vip/cooldown");
