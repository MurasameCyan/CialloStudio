import {
  getMasterPasswordSha256,
  getMasterUsername,
  isMasterConfigured,
  verifyMasterPassword,
} from "@/lib/runtimeConfig";
import type {
  AuthSession,
  Comment,
  CommunityUser,
  CreateCommentInput,
  CreatePostInput,
  GalleryPost,
  ListPostsQuery,
  ListPostsResult,
  LoginInput,
  MyQueuePolicy,
  QueuePolicyConfig,
  RegisterInput,
  ShareCooldownConfig,
  ShareStatus,
  UserRole,
} from "./types";
import {
  DEFAULT_QUEUE_POLICY,
  DEFAULT_SHARE_COOLDOWN,
  canUseBackgroundTasks,
  computeShareRemainSec,
  concurrencyLimitForRole,
  normalizeQueuePolicy,
  normalizeShareCooldown,
  queueLimitForRole,
  shareCooldownForRole,
} from "./types";

const STORAGE_KEY = "ciallo-studio.community.mock.v1";
const COOLDOWN_KEY = "ciallo-studio.community.shareCooldown.v1";
const QUEUE_POLICY_KEY = "ciallo-studio.community.queuePolicy.v1";
/** 密码由 .env 哈希校验，不存明文 */
const ENV_PASSWORD_MARKER = "__env_master__";
/** 本地未配置 .env 时的 Mock 站长密码 */
const FALLBACK_MASTER_PASSWORD = "admin123";

type StoreUser = CommunityUser & { password: string };

type Store = {
  users: StoreUser[];
  sessions: Record<string, string>; // token -> userId
  posts: GalleryPost[];
  comments: Comment[];
  likes: Record<string, string[]>; // postId -> userIds
};

function uid(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function masterUsername(): string {
  return getMasterUsername().trim().toLowerCase() || "admin";
}

function seed(): Store {
  const adminId = "user-admin";
  const demoId = "user-demo";
  const postId = "post-seed-1";
  const masterUser = masterUsername();
  const useEnv = isMasterConfigured();
  return {
    users: [
      {
        id: adminId,
        username: masterUser,
        password: useEnv ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD,
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
            `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
              <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop stop-color="#7aa2ff"/><stop offset="1" stop-color="#c7a0ff"/>
              </linearGradient></defs>
              <rect width="640" height="640" fill="url(#g)"/>
              <text x="50%" y="48%" text-anchor="middle" fill="white" font-size="28" font-family="sans-serif">Ciallo Hall</text>
              <text x="50%" y="56%" text-anchor="middle" fill="white" font-size="16" font-family="sans-serif" opacity="0.85">Mock 示例图</text>
            </svg>`,
          ),
        prompt: "a soft gradient abstract, iOS glass, minimal studio mock",
        model: "grok-imagine-image",
        aspectRatio: "1:1",
        resolution: "1k",
        caption: "欢迎来到分享大厅（Mock 数据，可注册后发布）",
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

/** 把 .env 站长同步进 mock 用户表（改用户名 / 提权 / 密码标记） */
function syncMasterUser(store: Store): boolean {
  const name = masterUsername();
  const useEnv = isMasterConfigured();
  let changed = false;

  // 只有一个 admin：非站长用户名的 admin 降级
  for (const u of store.users) {
    if (u.role === "admin" && u.username !== name) {
      u.role = "user";
      changed = true;
    }
  }

  let master = store.users.find((u) => u.username === name);
  if (!master) {
    // 优先复用 id=user-admin，避免旧会话断掉
    const legacy = store.users.find((u) => u.id === "user-admin");
    if (legacy) {
      legacy.username = name;
      legacy.displayName = legacy.displayName || "站长";
      legacy.role = "admin";
      legacy.password = useEnv ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD;
      master = legacy;
      changed = true;
    } else {
      store.users.unshift({
        id: "user-admin",
        username: name,
        password: useEnv ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD,
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
    const nextPass = useEnv ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD;
    if (useEnv && master.password !== ENV_PASSWORD_MARKER) {
      master.password = ENV_PASSWORD_MARKER;
      changed = true;
    } else if (!useEnv && master.password === ENV_PASSWORD_MARKER) {
      master.password = nextPass;
      changed = true;
    }
  }
  return changed;
}

function load(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let store: Store;
    if (!raw) {
      store = seed();
      save(store);
      return store;
    }
    store = JSON.parse(raw) as Store;
    if (syncMasterUser(store)) save(store);
    return store;
  } catch {
    const s = seed();
    save(s);
    return s;
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // quota — ignore
  }
}

function loadShareCooldown(): ShareCooldownConfig {
  try {
    const raw = localStorage.getItem(COOLDOWN_KEY);
    if (!raw) return { ...DEFAULT_SHARE_COOLDOWN };
    return normalizeShareCooldown(JSON.parse(raw) as Partial<ShareCooldownConfig>);
  } catch {
    return { ...DEFAULT_SHARE_COOLDOWN };
  }
}

function saveShareCooldown(cfg: ShareCooldownConfig): void {
  try {
    localStorage.setItem(COOLDOWN_KEY, JSON.stringify(normalizeShareCooldown(cfg)));
  } catch {
    // ignore
  }
}

function loadQueuePolicy(): QueuePolicyConfig {
  try {
    const raw = localStorage.getItem(QUEUE_POLICY_KEY);
    if (!raw) return { ...DEFAULT_QUEUE_POLICY };
    return normalizeQueuePolicy(JSON.parse(raw) as Partial<QueuePolicyConfig>);
  } catch {
    return { ...DEFAULT_QUEUE_POLICY };
  }
}

function saveQueuePolicy(cfg: QueuePolicyConfig): void {
  try {
    localStorage.setItem(QUEUE_POLICY_KEY, JSON.stringify(normalizeQueuePolicy(cfg)));
  } catch {
    // ignore
  }
}

function normalizeRole(role: unknown): UserRole {
  if (role === "admin" || role === "vip" || role === "user") return role;
  return "user";
}

function publicUser(u: CommunityUser & { password?: string }): CommunityUser {
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

function requireAdmin(token: string | null): { store: Store; admin: StoreUser } {
  const store = load();
  const adminId = token ? store.sessions[token] : null;
  const admin = store.users.find((u) => u.id === adminId);
  if (!admin || admin.role !== "admin" || admin.banned) {
    throw new Error("需要管理员权限");
  }
  return { store, admin };
}

function withLiked(post: GalleryPost, userId?: string, store?: Store): GalleryPost {
  const s = store ?? load();
  const likers = s.likes[post.id] ?? [];
  return {
    ...post,
    likeCount: likers.length,
    likedByMe: userId ? likers.includes(userId) : false,
    commentCount: s.comments.filter((c) => c.postId === post.id).length,
  };
}

export const mockCommunity = {
  async register(input: RegisterInput): Promise<AuthSession> {
    const store = load();
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw new Error("用户名需 3–20 位字母数字或下划线");
    }
    if (username === masterUsername()) {
      throw new Error("该用户名为站长保留，请换一个");
    }
    if (input.password.length < 6) throw new Error("密码至少 6 位");
    if (store.users.some((u) => u.username === username)) throw new Error("用户名已存在");
    const user: StoreUser = {
      id: uid("user-"),
      username,
      password: input.password,
      displayName: (input.displayName || username).trim().slice(0, 32),
      role: "user",
      createdAt: Date.now(),
    };
    store.users.push(user);
    const token = uid("tok-");
    store.sessions[token] = user.id;
    save(store);
    return { token, user: publicUser(user) };
  },

  async login(input: LoginInput): Promise<AuthSession> {
    const store = load();
    const username = input.username.trim().toLowerCase();
    const master = masterUsername();
    let user = store.users.find((u) => u.username === username);

    if (username === master) {
      // 站长：优先 .env 密码哈希；未配置时用 mock 明文 admin123
      const envHash = getMasterPasswordSha256();
      let ok = false;
      if (envHash) {
        ok = await verifyMasterPassword(input.password);
      } else {
        ok = input.password === FALLBACK_MASTER_PASSWORD || user?.password === input.password;
      }
      if (!ok) throw new Error("用户名或密码错误");
      if (!user) {
        user = {
          id: "user-admin",
          username: master,
          password: envHash ? ENV_PASSWORD_MARKER : FALLBACK_MASTER_PASSWORD,
          displayName: "站长",
          role: "admin",
          createdAt: Date.now(),
        };
        store.users.unshift(user);
      } else {
        user.role = "admin";
        if (envHash) user.password = ENV_PASSWORD_MARKER;
      }
    } else {
      user = store.users.find((u) => u.username === username && u.password === input.password);
      if (!user) throw new Error("用户名或密码错误");
    }

    if (user.banned) throw new Error("账号已被禁用");
    const token = uid("tok-");
    store.sessions[token] = user.id;
    save(store);
    return { token, user: publicUser(user) };
  },

  async me(token: string | null): Promise<CommunityUser | null> {
    if (!token) return null;
    const store = load();
    const userId = store.sessions[token];
    if (!userId) return null;
    const user = store.users.find((u) => u.id === userId);
    if (!user) return null;
    // 被禁用后会话失效，前端 me() 会回到未登录
    if (user.banned) {
      delete store.sessions[token];
      save(store);
      return null;
    }
    return publicUser(user);
  },

  async logout(token: string | null): Promise<void> {
    if (!token) return;
    const store = load();
    delete store.sessions[token];
    save(store);
  },

  async listPosts(query: ListPostsQuery, token: string | null): Promise<ListPostsResult> {
    const store = load();
    const userId = token ? store.sessions[token] : undefined;
    let items = [...store.posts].sort((a, b) => b.createdAt - a.createdAt);
    if (query.q?.trim()) {
      const q = query.q.trim().toLowerCase();
      items = items.filter(
        (p) =>
          p.prompt.toLowerCase().includes(q) ||
          p.caption?.toLowerCase().includes(q) ||
          p.authorName.toLowerCase().includes(q),
      );
    }
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const start = query.cursor ? Math.max(0, items.findIndex((p) => p.id === query.cursor) + 1) : 0;
    const slice = items.slice(start, start + limit).map((p) => withLiked(p, userId, store));
    const next = items[start + limit];
    return { items: slice, nextCursor: next?.id };
  },

  async getPost(id: string, token: string | null): Promise<GalleryPost | null> {
    const store = load();
    const userId = token ? store.sessions[token] : undefined;
    const post = store.posts.find((p) => p.id === id);
    return post ? withLiked(post, userId, store) : null;
  },

  async createPost(input: CreatePostInput, token: string | null): Promise<GalleryPost> {
    const store = load();
    const userId = token ? store.sessions[token] : null;
    if (!userId) throw new Error("请先登录");
    const user = store.users.find((u) => u.id === userId);
    if (!user || user.banned) throw new Error("无法发帖");
    if (!input.imageUrl?.trim()) throw new Error("缺少图片");

    // 分享冷却：按用户组（user / vip；admin 不限）
    const cooldownCfg = loadShareCooldown();
    const role = normalizeRole(user.role);
    const cooldownSec = shareCooldownForRole(role, cooldownCfg);
    const remain = computeShareRemainSec(cooldownSec, user.lastShareAt);
    if (remain > 0) {
      throw new Error(`分享冷却中，请 ${remain} 秒后再试`);
    }

    const post: GalleryPost = {
      id: uid("post-"),
      authorId: user.id,
      authorName: user.displayName,
      imageUrl: input.imageUrl.trim(),
      mediaId: input.mediaId,
      prompt: input.prompt.trim() || "(无 prompt)",
      model: input.model,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      caption: input.caption?.trim() || undefined,
      likeCount: 0,
      commentCount: 0,
      createdAt: Date.now(),
      likedByMe: false,
    };
    store.posts.unshift(post);
    store.likes[post.id] = [];
    user.lastShareAt = Date.now();
    save(store);
    return post;
  },

  async toggleLike(postId: string, token: string | null): Promise<GalleryPost> {
    const store = load();
    const userId = token ? store.sessions[token] : null;
    if (!userId) throw new Error("请先登录");
    const actor = store.users.find((u) => u.id === userId);
    if (!actor || actor.banned) throw new Error("账号已被禁用");
    const post = store.posts.find((p) => p.id === postId);
    if (!post) throw new Error("帖子不存在");
    const set = new Set(store.likes[postId] ?? []);
    if (set.has(userId)) set.delete(userId);
    else set.add(userId);
    store.likes[postId] = [...set];
    save(store);
    return withLiked(post, userId, store);
  },

  async listComments(postId: string): Promise<Comment[]> {
    const store = load();
    return store.comments
      .filter((c) => c.postId === postId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async addComment(postId: string, input: CreateCommentInput, token: string | null): Promise<Comment> {
    const store = load();
    const userId = token ? store.sessions[token] : null;
    if (!userId) throw new Error("请先登录");
    const user = store.users.find((u) => u.id === userId);
    if (!user || user.banned) throw new Error("无法评论");
    if (!store.posts.some((p) => p.id === postId)) throw new Error("帖子不存在");
    const body = input.body.trim();
    if (!body) throw new Error("评论不能为空");
    const rating =
      typeof input.rating === "number" && input.rating >= 1 && input.rating <= 5
        ? Math.round(input.rating)
        : undefined;
    const cmt: Comment = {
      id: uid("cmt-"),
      postId,
      authorId: user.id,
      authorName: user.displayName,
      body: body.slice(0, 500),
      rating,
      createdAt: Date.now(),
    };
    store.comments.push(cmt);
    save(store);
    return cmt;
  },

  async listUsers(token: string | null): Promise<CommunityUser[]> {
    const { store } = requireAdmin(token);
    return store.users
      .map(publicUser)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async setBanned(userId: string, banned: boolean, token: string | null): Promise<CommunityUser> {
    const { store, admin } = requireAdmin(token);
    const user = store.users.find((u) => u.id === userId);
    if (!user) throw new Error("用户不存在");
    if (user.role === "admin") throw new Error("不能禁用管理员");
    if (user.id === admin.id) throw new Error("不能禁用自己");
    user.banned = banned;
    // 禁用时吊销该用户全部会话，避免已登录状态继续发帖/评论
    if (banned) {
      for (const [tok, uid] of Object.entries(store.sessions)) {
        if (uid === user.id) delete store.sessions[tok];
      }
    }
    save(store);
    return publicUser(user);
  },

  /** 设置用户分组：user | vip（不可改站长） */
  async setUserRole(userId: string, role: UserRole, token: string | null): Promise<CommunityUser> {
    const { store, admin } = requireAdmin(token);
    if (role !== "user" && role !== "vip") {
      throw new Error("仅可设为普通用户或 VIP");
    }
    const user = store.users.find((u) => u.id === userId);
    if (!user) throw new Error("用户不存在");
    if (user.role === "admin" || user.id === admin.id) {
      throw new Error("不能修改站长分组");
    }
    user.role = role;
    save(store);
    return publicUser(user);
  },

  async getShareCooldown(token: string | null): Promise<ShareCooldownConfig> {
    requireAdmin(token);
    return loadShareCooldown();
  },

  async setShareCooldown(
    cfg: Partial<ShareCooldownConfig>,
    token: string | null,
  ): Promise<ShareCooldownConfig> {
    requireAdmin(token);
    const next = normalizeShareCooldown({
      ...loadShareCooldown(),
      ...cfg,
    });
    saveShareCooldown(next);
    return next;
  },

  async getQueuePolicy(token: string | null): Promise<QueuePolicyConfig> {
    requireAdmin(token);
    return loadQueuePolicy();
  },

  async setQueuePolicy(
    cfg: Partial<QueuePolicyConfig>,
    token: string | null,
  ): Promise<QueuePolicyConfig> {
    requireAdmin(token);
    const next = normalizeQueuePolicy({
      ...loadQueuePolicy(),
      ...cfg,
    });
    saveQueuePolicy(next);
    return next;
  },

  async getMyQueuePolicy(token: string | null): Promise<MyQueuePolicy> {
    if (!token) throw new Error("请先登录");
    const store = load();
    const userId = store.sessions[token];
    if (!userId) throw new Error("请先登录");
    const user = store.users.find((u) => u.id === userId);
    if (!user || user.banned) throw new Error("请先登录");
    const role = normalizeRole(user.role);
    const policy = loadQueuePolicy();
    return {
      ...policy,
      canBackground: canUseBackgroundTasks(role, policy),
      myLimit: queueLimitForRole(role, policy),
      myConcurrency: concurrencyLimitForRole(role, policy),
    };
  },

  /** 当前用户分享冷却状态（登录即可；供工作台展示倒计时） */
  async getShareStatus(token: string | null): Promise<ShareStatus> {
    if (!token) throw new Error("请先登录");
    const store = load();
    const userId = store.sessions[token];
    if (!userId) throw new Error("请先登录");
    const user = store.users.find((u) => u.id === userId);
    if (!user || user.banned) throw new Error("请先登录");
    const role = normalizeRole(user.role);
    const cooldownSec = shareCooldownForRole(role, loadShareCooldown());
    const lastShareAt = typeof user.lastShareAt === "number" ? user.lastShareAt : undefined;
    return {
      role,
      cooldownSec,
      lastShareAt,
      remainSec: computeShareRemainSec(cooldownSec, lastShareAt),
    };
  },

  /** 删除用户：吊销会话、移除账号；保留其帖子/评论（作者名仍可见） */
  async deleteUser(userId: string, token: string | null): Promise<void> {
    const { store, admin } = requireAdmin(token);
    const user = store.users.find((u) => u.id === userId);
    if (!user) throw new Error("用户不存在");
    if (user.role === "admin") throw new Error("不能删除站长/管理员");
    if (user.id === admin.id) throw new Error("不能删除自己");
    for (const [tok, uid] of Object.entries(store.sessions)) {
      if (uid === user.id) delete store.sessions[tok];
    }
    // 点赞关系去掉该用户
    for (const postId of Object.keys(store.likes)) {
      store.likes[postId] = (store.likes[postId] ?? []).filter((id) => id !== user.id);
    }
    store.users = store.users.filter((u) => u.id !== user.id);
    save(store);
  },

  async deletePost(postId: string, token: string | null): Promise<void> {
    const store = load();
    const userId = token ? store.sessions[token] : null;
    const me = store.users.find((u) => u.id === userId);
    if (!me) throw new Error("请先登录");
    const post = store.posts.find((p) => p.id === postId);
    if (!post) throw new Error("帖子不存在");
    if (post.authorId !== me.id && me.role !== "admin") throw new Error("无权删除");
    store.posts = store.posts.filter((p) => p.id !== postId);
    store.comments = store.comments.filter((c) => c.postId !== postId);
    delete store.likes[postId];
    save(store);
  },
};
