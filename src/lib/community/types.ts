/** 社区 API 契约类型（前后端共用形状；本阶段 mock 实现） */

export type UserRole = "user" | "admin";

export type CommunityUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
  banned?: boolean;
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
