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
  RegisterInput,
} from "./types";

const STORAGE_KEY = "ciallo-studio.community.mock.v1";

type Store = {
  users: Array<CommunityUser & { password: string }>;
  sessions: Record<string, string>; // token -> userId
  posts: GalleryPost[];
  comments: Comment[];
  likes: Record<string, string[]>; // postId -> userIds
};

function uid(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function seed(): Store {
  const adminId = "user-admin";
  const demoId = "user-demo";
  const postId = "post-seed-1";
  return {
    users: [
      {
        id: adminId,
        username: "admin",
        password: "admin123",
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

function load(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const s = seed();
      save(s);
      return s;
    }
    return JSON.parse(raw) as Store;
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

function publicUser(u: CommunityUser & { password?: string }): CommunityUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    createdAt: u.createdAt,
    banned: u.banned,
  };
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
    if (input.password.length < 6) throw new Error("密码至少 6 位");
    if (store.users.some((u) => u.username === username)) throw new Error("用户名已存在");
    const user: CommunityUser & { password: string } = {
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
    const user = store.users.find((u) => u.username === username && u.password === input.password);
    if (!user) throw new Error("用户名或密码错误");
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
    return user ? publicUser(user) : null;
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
    save(store);
    return post;
  },

  async toggleLike(postId: string, token: string | null): Promise<GalleryPost> {
    const store = load();
    const userId = token ? store.sessions[token] : null;
    if (!userId) throw new Error("请先登录");
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
    const store = load();
    const userId = token ? store.sessions[token] : null;
    const me = store.users.find((u) => u.id === userId);
    if (!me || me.role !== "admin") throw new Error("需要管理员权限");
    return store.users.map(publicUser);
  },

  async setBanned(userId: string, banned: boolean, token: string | null): Promise<CommunityUser> {
    const store = load();
    const adminId = token ? store.sessions[token] : null;
    const admin = store.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== "admin") throw new Error("需要管理员权限");
    const user = store.users.find((u) => u.id === userId);
    if (!user) throw new Error("用户不存在");
    if (user.role === "admin") throw new Error("不能禁用管理员");
    user.banned = banned;
    save(store);
    return publicUser(user);
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
