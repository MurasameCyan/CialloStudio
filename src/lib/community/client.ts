/**
 * 社区 API 客户端。
 * - 模式仅由 env / runtime-config 决定（CIALLO_COMMUNITY_MODE，默认 http）
 * - 不再提供 UI / localStorage 切换
 * - mock：浏览器 localStorage（仅 CIALLO_COMMUNITY_MODE=mock）
 * - http：/api/community → Docker 或本机 community-api（/data volume）
 */
import {
  getRuntimeCommunityApiBase,
  getRuntimeCommunityMode,
} from "@/lib/runtimeConfig";
import { mockCommunity } from "./mockStore";
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
  ShareCooldownConfig,
  ShareStatus,
  UserRole,
} from "./types";

const TOKEN_KEY = "ciallo-studio.community.token.v1";
/** 旧版 UI 切换写入的 key，读取时清掉，避免卡在 mock */
const LEGACY_MODE_KEY = "ciallo-studio.community.mode";
const BASE_KEY = "ciallo-studio.community.apiBase"; // e.g. /api/community

export function getCommunityMode(): "mock" | "http" {
  try {
    // 清除历史 Mock/HTTP 切换残留
    if (localStorage.getItem(LEGACY_MODE_KEY) != null) {
      localStorage.removeItem(LEGACY_MODE_KEY);
    }
  } catch {
    // ignore
  }
  return getRuntimeCommunityMode();
}

export function getCommunityApiBase(): string {
  try {
    const override = localStorage.getItem(BASE_KEY);
    if (override && override.trim()) return override.trim();
  } catch {
    // ignore
  }
  return getRuntimeCommunityApiBase();
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = getCommunityApiBase().replace(/\/+$/, "");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const msg =
      payload &&
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof (payload as { error?: { message?: string } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload as T;
}

export const communityApi = {
  mode: getCommunityMode,

  async register(input: RegisterInput): Promise<AuthSession> {
    if (getCommunityMode() === "http") {
      const session = await http<AuthSession>("/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setToken(session.token);
      return session;
    }
    const session = await mockCommunity.register(input);
    setToken(session.token);
    return session;
  },

  async login(input: LoginInput): Promise<AuthSession> {
    if (getCommunityMode() === "http") {
      const session = await http<AuthSession>("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setToken(session.token);
      return session;
    }
    const session = await mockCommunity.login(input);
    setToken(session.token);
    return session;
  },

  async logout(): Promise<void> {
    const token = getToken();
    if (getCommunityMode() === "http") {
      try {
        await http("/auth/logout", { method: "POST", body: "{}" });
      } catch {
        // ignore
      }
    } else {
      await mockCommunity.logout(token);
    }
    setToken(null);
  },

  async me(): Promise<CommunityUser | null> {
    if (getCommunityMode() === "http") {
      try {
        return await http<CommunityUser>("/auth/me");
      } catch {
        setToken(null);
        return null;
      }
    }
    return mockCommunity.me(getToken());
  },

  async listPosts(query: ListPostsQuery = {}): Promise<ListPostsResult> {
    if (getCommunityMode() === "http") {
      const qs = new URLSearchParams();
      if (query.cursor) qs.set("cursor", query.cursor);
      if (query.limit) qs.set("limit", String(query.limit));
      if (query.q) qs.set("q", query.q);
      const s = qs.toString();
      return http<ListPostsResult>(`/posts${s ? `?${s}` : ""}`);
    }
    return mockCommunity.listPosts(query, getToken());
  },

  async getPost(id: string): Promise<GalleryPost | null> {
    if (getCommunityMode() === "http") {
      try {
        return await http<GalleryPost>(`/posts/${encodeURIComponent(id)}`);
      } catch {
        return null;
      }
    }
    return mockCommunity.getPost(id, getToken());
  },

  async createPost(input: CreatePostInput): Promise<GalleryPost> {
    if (getCommunityMode() === "http") {
      return http<GalleryPost>("/posts", { method: "POST", body: JSON.stringify(input) });
    }
    return mockCommunity.createPost(input, getToken());
  },

  async toggleLike(postId: string): Promise<GalleryPost> {
    if (getCommunityMode() === "http") {
      return http<GalleryPost>(`/posts/${encodeURIComponent(postId)}/like`, {
        method: "POST",
        body: "{}",
      });
    }
    return mockCommunity.toggleLike(postId, getToken());
  },

  async listComments(postId: string): Promise<Comment[]> {
    if (getCommunityMode() === "http") {
      return http<Comment[]>(`/posts/${encodeURIComponent(postId)}/comments`);
    }
    return mockCommunity.listComments(postId);
  },

  async addComment(postId: string, input: CreateCommentInput): Promise<Comment> {
    if (getCommunityMode() === "http") {
      return http<Comment>(`/posts/${encodeURIComponent(postId)}/comments`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    }
    return mockCommunity.addComment(postId, input, getToken());
  },

  async listUsers(): Promise<CommunityUser[]> {
    if (getCommunityMode() === "http") {
      return http<CommunityUser[]>("/admin/users");
    }
    return mockCommunity.listUsers(getToken());
  },

  async setBanned(userId: string, banned: boolean): Promise<CommunityUser> {
    if (getCommunityMode() === "http") {
      return http<CommunityUser>(`/admin/users/${encodeURIComponent(userId)}/ban`, {
        method: "POST",
        body: JSON.stringify({ banned }),
      });
    }
    return mockCommunity.setBanned(userId, banned, getToken());
  },

  async setUserRole(userId: string, role: UserRole): Promise<CommunityUser> {
    if (getCommunityMode() === "http") {
      return http<CommunityUser>(`/admin/users/${encodeURIComponent(userId)}/role`, {
        method: "POST",
        body: JSON.stringify({ role }),
      });
    }
    return mockCommunity.setUserRole(userId, role, getToken());
  },

  async getShareCooldown(): Promise<ShareCooldownConfig> {
    if (getCommunityMode() === "http") {
      return http<ShareCooldownConfig>("/admin/share-cooldown");
    }
    return mockCommunity.getShareCooldown(getToken());
  },

  async setShareCooldown(cfg: Partial<ShareCooldownConfig>): Promise<ShareCooldownConfig> {
    if (getCommunityMode() === "http") {
      return http<ShareCooldownConfig>("/admin/share-cooldown", {
        method: "PUT",
        body: JSON.stringify(cfg),
      });
    }
    return mockCommunity.setShareCooldown(cfg, getToken());
  },

  /** 当前登录用户的分享冷却（任意登录用户） */
  async getShareStatus(): Promise<ShareStatus> {
    if (getCommunityMode() === "http") {
      return http<ShareStatus>("/me/share-status");
    }
    return mockCommunity.getShareStatus(getToken());
  },

  async deleteUser(userId: string): Promise<void> {
    if (getCommunityMode() === "http") {
      await http(`/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      return;
    }
    return mockCommunity.deleteUser(userId, getToken());
  },

  async deletePost(postId: string): Promise<void> {
    if (getCommunityMode() === "http") {
      await http(`/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
      return;
    }
    return mockCommunity.deletePost(postId, getToken());
  },
};
