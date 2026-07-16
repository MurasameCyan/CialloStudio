# 大厅持久化展示落地实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 大厅支持加载更多、imageUrl→mediaId 图链兜底、图裂占位；持久化链路已在 `c450672` 交付，本计划聚焦展示增强。

**架构：** 新增纯函数 `postImage.ts` 解析展示 URL；`HallPage` 用 `nextCursor` 分页追加；卡片/抽屉图片组件化处理 onError 一次 fallback 与占位。

**技术栈：** React + TypeScript、现有 `communityApi.listPosts`、`getMediaBase()`。

**规格：** `docs/superpowers/specs/2026-07-17-hall-persist-display-design.md`

**已完成（无需再做）：** Docker community-api / volume / nginx / runtime `communityMode=http`（commit `c450672`）。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `src/lib/community/postImage.ts` | `resolvePostImageUrl` / `fallbackPostImageUrl` |
| 修改 `src/components/HallPage.tsx` | 分页状态、加载更多、使用 PostImage |
| 创建或内联 `HallPostImage`（可同文件） | 单图：resolve + 一次 fallback + 占位 |
| 修改 `src/styles/ios26.css` | `.hall-media-placeholder` 等 |

可选：`scripts/test-post-image.mjs` 纯函数单测（若项目习惯用 node 脚本测 lib）。

---

### 任务 1：postImage 纯函数

**文件：**
- 创建：`src/lib/community/postImage.ts`

- [ ] **步骤 1：实现 resolve / fallback**

```ts
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
```

- [ ] **步骤 2：Commit + push**

```bash
git add src/lib/community/postImage.ts
git commit -m "feat: resolve hall post image url with mediaId fallback"
git push
```

---

### 任务 2：HallPostImage + CSS 占位

**文件：**
- 修改：`src/components/HallPage.tsx`（可同文件定义小组件）
- 修改：`src/styles/ios26.css`

- [ ] **步骤 1：在 HallPage 同文件增加 `HallPostImage`**

```tsx
import { useState } from "react";
import { fallbackPostImageUrl, resolvePostImageUrl } from "@/lib/community/postImage";
import type { GalleryPost } from "@/lib/community/types";

function HallPostImage({
  post,
  alt,
  className,
}: {
  post: Pick<GalleryPost, "imageUrl" | "mediaId" | "prompt">;
  alt: string;
  className?: string;
}) {
  const initial = resolvePostImageUrl(post);
  const [src, setSrc] = useState(initial);
  const [failed, setFailed] = useState(!initial);
  const [triedFallback, setTriedFallback] = useState(false);

  // post 切换时重置（抽屉换帖）
  // 可用 key={post.id + initial} 由父级强制 remount，或 useEffect 同步

  if (failed || !src) {
    return (
      <div className={`hall-media-placeholder ${className || ""}`} role="img" aria-label="图不可用">
        图不可用
      </div>
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => {
        if (!triedFallback) {
          const next = fallbackPostImageUrl(post, src);
          setTriedFallback(true);
          if (next) {
            setSrc(next);
            return;
          }
        }
        setFailed(true);
      }}
    />
  );
}
```

注意：当 `active` / 列表项 `imageUrl` 更新时，用 `key={post.id}` 或 `key={\`${post.id}:${resolvePostImageUrl(post)}\`}` 避免陈旧 src。

- [ ] **步骤 2：CSS**

在 `ios26.css` 大厅样式附近增加：

```css
.hall-media-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 120px;
  background: rgba(120, 120, 128, 0.16);
  color: var(--text-secondary, #8e8e93);
  font-size: 13px;
  border-radius: inherit;
}
.hall-drawer-media .hall-media-placeholder {
  min-height: 200px;
  aspect-ratio: 1;
}
```

（按现有变量微调，保持与 `.hall-media img` 同尺寸习惯。）

- [ ] **步骤 3：Commit + push**

```bash
git add src/components/HallPage.tsx src/styles/ios26.css
git commit -m "feat: hall image fallback and broken-image placeholder"
git push
```

若本任务只加组件未替换调用点，可与任务 3 合并 commit；推荐本任务完成替换调用。

- [ ] **步骤 4：替换网格与抽屉 img**

网格：

```tsx
<button type="button" className="hall-media" onClick={() => void openPost(post)}>
  <HallPostImage key={post.id} post={post} alt={post.prompt} />
</button>
```

抽屉：

```tsx
<div className="hall-drawer-media">
  <HallPostImage key={active.id} post={active} alt={active.prompt} />
</div>
```

---

### 任务 3：加载更多分页

**文件：**
- 修改：`src/components/HallPage.tsx`

- [ ] **步骤 1：扩展列表状态**

```tsx
const PAGE_SIZE = 24;
const [posts, setPosts] = useState<GalleryPost[]>([]);
const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
const [listLoading, setListLoading] = useState(true);
const [loadingMore, setLoadingMore] = useState(false);
// q, error 等同前
```

- [ ] **步骤 2：重写 load（首屏）与 loadMore**

```tsx
const load = useCallback(async () => {
  setListLoading(true);
  setError("");
  try {
    const res = await communityApi.listPosts({
      limit: PAGE_SIZE,
      q: q.trim() || undefined,
    });
    setPosts(res.items);
    setNextCursor(res.nextCursor);
  } catch (e) {
    setError(e instanceof Error ? e.message : "加载失败");
  } finally {
    setListLoading(false);
  }
}, [q]);

const loadMore = useCallback(async () => {
  if (!nextCursor || loadingMore) return;
  setLoadingMore(true);
  setError("");
  try {
    const res = await communityApi.listPosts({
      limit: PAGE_SIZE,
      cursor: nextCursor,
      q: q.trim() || undefined,
    });
    setPosts((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      const appended = res.items.filter((p) => !seen.has(p.id));
      return [...prev, ...appended];
    });
    setNextCursor(res.nextCursor);
  } catch (e) {
    setError(e instanceof Error ? e.message : "加载更多失败");
  } finally {
    setLoadingMore(false);
  }
}, [nextCursor, loadingMore, q]);
```

`useEffect` 仍只依赖 `load`（首屏/搜索）。搜索按钮与 Enter 调用 `load()`（重置）。

- [ ] **步骤 3：UI「加载更多」**

在 `hall-grid` 之后（同 section，有 posts 时）：

```tsx
{nextCursor ? (
  <div className="btn-row" style={{ marginTop: 16, justifyContent: "center" }}>
    <button
      type="button"
      className="btn btn-secondary"
      disabled={loadingMore}
      onClick={() => void loadMore()}
    >
      {loadingMore ? "加载中…" : "加载更多"}
    </button>
  </div>
) : null}
```

- [ ] **步骤 4：Commit + push**

```bash
git add src/components/HallPage.tsx
git commit -m "feat: hall list load-more via cursor pagination"
git push
```

---

### 任务 4：构建验证

- [ ] **步骤 1：构建**

```bash
npm run build
```

预期：exit 0。

- [ ] **步骤 2：手动验收清单**

| # | 场景 | 期望 |
|---|------|------|
| 1 | mock 大厅 | seed 帖可见 |
| 2 | 临时把 PAGE_SIZE=2 或造多帖 | 出现「加载更多」，追加无丢首屏 |
| 3 | 坏 imageUrl + 有效 mediaId + mediaBase | onError 后显示媒体图 |
| 4 | 双坏 | 「图不可用」占位 |
| 5 | 搜索 | 列表重置，cursor 清 |

- [ ] **步骤 3：若有小修则 commit；否则结束**

```bash
git push  # 确保已推送
```

---

## 自检对照规格

| 规格项 | 任务 |
|--------|------|
| 持久化交付 | 已完成 c450672，本计划不重复 |
| 加载更多 | 任务 3 |
| 图链兜底 | 任务 1–2 |
| 图裂占位 | 任务 2 |
| 不做自动刷新 | 未实现 |
| build | 任务 4 |

无占位符；API 形状与 `ListPostsResult.nextCursor` 一致。
