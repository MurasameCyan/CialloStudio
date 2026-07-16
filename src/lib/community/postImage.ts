import { getMediaBase } from "@/lib/media/client";

export type PostImageFields = {
  imageUrl?: string;
  mediaId?: string;
};

function mediaUrlFromId(mediaId: string): string | null {
  const id = mediaId.trim();
  if (!id) return null;
  const base = getMediaBase();
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/v1/media/${encodeURIComponent(id)}`;
}

/** 优先 imageUrl，否则 mediaBase + mediaId */
export function resolvePostImageUrl(post: PostImageFields): string {
  const url = typeof post.imageUrl === "string" ? post.imageUrl.trim() : "";
  if (url) return url;
  const mid = typeof post.mediaId === "string" ? post.mediaId : "";
  return mediaUrlFromId(mid) || "";
}

/** imageUrl 失败后尝试与 failedUrl 不同的 media URL */
export function fallbackPostImageUrl(post: PostImageFields, failedUrl: string): string | null {
  const mid = typeof post.mediaId === "string" ? post.mediaId : "";
  const media = mediaUrlFromId(mid);
  if (!media) return null;
  if (media === failedUrl) return null;
  return media;
}
