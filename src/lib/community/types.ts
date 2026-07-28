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

/**
 * 服务端任务队列策略（站长在用户池配置）。
 * - userLimit / vipLimit：该角色同时排队中（queued+running）上限；站长排队不限
 * - user/vip/admin Concurrency：灵感创作台可选并发上限（普通默认2 / VIP3 / 站长5）
 * - userBackgroundEnabled：普通用户是否可用后台队列（默认关）
 */
export type QueuePolicyConfig = {
  userLimit: number;
  vipLimit: number;
  userConcurrency: number;
  vipConcurrency: number;
  adminConcurrency: number;
  userBackgroundEnabled: boolean;
};

/** 当前登录用户可见的队列策略（含本人权限） */
export type MyQueuePolicy = QueuePolicyConfig & {
  canBackground: boolean;
  /** null = 不限制（站长排队） */
  myLimit: number | null;
  /** 本人创作台并发可选上限 */
  myConcurrency: number;
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

export const DEFAULT_QUEUE_POLICY: QueuePolicyConfig = {
  userLimit: 1,
  vipLimit: 3,
  userConcurrency: 2,
  vipConcurrency: 3,
  adminConcurrency: 5,
  userBackgroundEnabled: false,
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

/**
 * 后台任务（跨页续跑 / 关页提示）：
 * - 站长 / VIP 始终可用
 * - 普通用户取决于站长「普通用户后台队列」开关
 */
export function canUseBackgroundTasks(
  role: UserRole | null | undefined,
  policy?: Pick<QueuePolicyConfig, "userBackgroundEnabled"> | null,
): boolean {
  if (role === "admin" || role === "vip") return true;
  if (role === "user") return policy?.userBackgroundEnabled === true;
  return false;
}

/** 按角色取排队上限；站长 null=不限 */
export function queueLimitForRole(
  role: UserRole | null | undefined,
  policy?: QueuePolicyConfig | null,
): number | null {
  const cfg = normalizeQueuePolicy(policy);
  if (role === "admin") return null;
  if (role === "vip") return cfg.vipLimit;
  return cfg.userLimit;
}

/** 按角色取创作台并发上限 */
export function concurrencyLimitForRole(
  role: UserRole | null | undefined,
  policy?: QueuePolicyConfig | null,
): number {
  const cfg = normalizeQueuePolicy(policy);
  if (role === "admin") return cfg.adminConcurrency;
  if (role === "vip") return cfg.vipConcurrency;
  return cfg.userConcurrency;
}

export function clampQueueLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/** 并发上限配置：1–8 */
export function clampConcurrencyCap(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(8, Math.max(1, Math.round(n)));
}

export function normalizeQueuePolicy(raw?: Partial<QueuePolicyConfig> | null): QueuePolicyConfig {
  return {
    userLimit: clampQueueLimit(raw?.userLimit, DEFAULT_QUEUE_POLICY.userLimit),
    vipLimit: clampQueueLimit(raw?.vipLimit, DEFAULT_QUEUE_POLICY.vipLimit),
    userConcurrency: clampConcurrencyCap(raw?.userConcurrency, DEFAULT_QUEUE_POLICY.userConcurrency),
    vipConcurrency: clampConcurrencyCap(raw?.vipConcurrency, DEFAULT_QUEUE_POLICY.vipConcurrency),
    adminConcurrency: clampConcurrencyCap(
      raw?.adminConcurrency,
      DEFAULT_QUEUE_POLICY.adminConcurrency,
    ),
    userBackgroundEnabled: raw?.userBackgroundEnabled === true,
  };
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
