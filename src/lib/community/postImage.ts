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

/**
 * 新标签页以「图片页」展示，而不是直接打开媒体二进制。
 * 媒体 Worker / 上游常返回 application/octet-stream，浏览器会当附件下载；
 * 用 blob HTML + <img> 可稳定预览（兼容 noopener）。
 */
export function openOriginalImageInNewTab(
  postOrUrl: PostImageFields | string,
  title = "原图预览",
): boolean {
  const url =
    typeof postOrUrl === "string"
      ? postOrUrl.trim()
      : resolvePostImageUrl(postOrUrl);
  if (!url) return false;

  // data:image 可直接开
  if (/^data:image\//i.test(url)) {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    return Boolean(win);
  }

  const safeSrc = url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const safeTitle = String(title || "原图预览")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: #0b0b0f; color: #f5f5f7; }
    body { display: grid; place-items: center; min-height: 100dvh; }
    img { max-width: min(100vw, 100%); max-height: 100dvh; width: auto; height: auto; object-fit: contain; }
    .err { font: 14px/1.5 system-ui, sans-serif; opacity: .8; padding: 24px; text-align: center; }
  </style>
</head>
<body>
  <img src="${safeSrc}" alt="${safeTitle}" decoding="async"
    onerror="this.replaceWith(Object.assign(document.createElement('p'),{className:'err',textContent:'原图加载失败'}))" />
</body>
</html>`;

  try {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, "_blank", "noopener,noreferrer");
    // 延迟 revoke，给新标签加载时间
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    return Boolean(win);
  } catch {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    return Boolean(win);
  }
}
