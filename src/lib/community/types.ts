/** 社区 API 契约类型（前后端共用形状；本阶段 mock 实现） */

/** user=普通 · vip=VIP · admin=站长 */
export type UserRole = "user" | "vip" | "admin";

export type CommunityUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
  banned?: boolean;
  /** 上次成功分享到大厅的时间戳（ms），用于冷却 */
  lastShareAt?: number;
};

/** 各组「分享到大厅」最小间隔（秒）。admin 固定 0。 */
export type ShareCooldownConfig = {
  user: number;
  vip: number;
};

/** 当前登录用户的分享冷却状态（任意登录用户可读） */
export type ShareStatus = {
  role: UserRole;
  /** 本组配置的间隔秒数；站长为 0 */
  cooldownSec: number;
  lastShareAt?: number;
  /** 还需等待的秒数；0 表示可立即分享 */
  remainSec: number;
};

export function computeShareRemainSec(
  cooldownSec: number,
  lastShareAt: number | undefined,
  now = Date.now(),
): number {
  if (cooldownSec <= 0 || typeof lastShareAt !== "number" || lastShareAt <= 0) return 0;
  return Math.max(0, Math.ceil(cooldownSec - (now - lastShareAt) / 1000));
}

export const DEFAULT_SHARE_COOLDOWN: ShareCooldownConfig = {
  user: 60,
  vip: 15,
};

export type AuthSession = {
  token: string;
  user: CommunityUser;
};

export type GalleryPost = {
  id: string;
  authorId: string;
  authorName: string;
  /** 展示用图片 URL（mock 可用 data URL / 外部 URL；生产为 CF Worker 媒体 URL） */
  imageUrl: string;
  /** 后端/Worker 侧媒体 id，可选 */
  mediaId?: string;
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  caption?: string;
  likeCount: number;
  commentCount: number;
  createdAt: number;
  /** 当前登录用户是否已点赞 */
  likedByMe?: boolean;
};

export type Comment = {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  body: string;
  rating?: number; // 1-5 可选星级
  createdAt: number;
};

export type ListPostsQuery = {
  cursor?: string;
  limit?: number;
  q?: string;
};

export type ListPostsResult = {
  items: GalleryPost[];
  nextCursor?: string;
};

export type CreatePostInput = {
  imageUrl: string;
  mediaId?: string;
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  caption?: string;
};

export type CreateCommentInput = {
  body: string;
  rating?: number;
};

export type RegisterInput = {
  username: string;
  password: string;
  displayName?: string;
};

export type LoginInput = {
  username: string;
  password: string;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export function roleLabel(role: UserRole): string {
  if (role === "admin") return "站长";
  if (role === "vip") return "VIP";
  return "用户";
}

/** 后台任务（跨页续跑 / 关页提示）：仅站长与 VIP */
export function canUseBackgroundTasks(role: UserRole | null | undefined): boolean {
  return role === "admin" || role === "vip";
}

export function clampShareCooldownSec(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(86400, Math.max(0, Math.round(n)));
}

export function normalizeShareCooldown(raw?: Partial<ShareCooldownConfig> | null): ShareCooldownConfig {
  return {
    user: clampShareCooldownSec(raw?.user, DEFAULT_SHARE_COOLDOWN.user),
    vip: clampShareCooldownSec(raw?.vip, DEFAULT_SHARE_COOLDOWN.vip),
  };
}

/** 按角色取冷却秒数；站长 0 */
export function shareCooldownForRole(role: UserRole, cfg: ShareCooldownConfig): number {
  if (role === "admin") return 0;
  if (role === "vip") return Math.max(0, cfg.vip);
  return Math.max(0, cfg.user);
}
