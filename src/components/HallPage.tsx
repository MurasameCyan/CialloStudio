import { useCallback, useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { HallAuthPanel } from "@/components/HallAuthPanel";
import { communityApi } from "@/lib/community/client";
import { fallbackPostImageUrl, resolvePostImageUrl } from "@/lib/community/postImage";
import type { Comment, CommunityUser, GalleryPost } from "@/lib/community/types";
import { log } from "@/lib/logger";

function openOriginalImage(post: Pick<GalleryPost, "imageUrl" | "mediaId">) {
  const url = resolvePostImageUrl(post);
  if (!url) {
    log("warn", "原图地址不可用");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function CommentIcon() {
  return (
    <span className="hall-chip-icon" aria-hidden>
      <MessageCircle size={14} strokeWidth={2.2} />
    </span>
  );
}

async function copyText(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const PAGE_SIZE = 24;

type Props = {
  user: CommunityUser | null;
  loading?: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string, displayName?: string) => Promise<void>;
  onLogout: () => Promise<void>;
};

function HallPostImage({
  post,
  alt,
}: {
  post: Pick<GalleryPost, "imageUrl" | "mediaId" | "prompt">;
  alt: string;
}) {
  const initial = resolvePostImageUrl(post);
  const [src, setSrc] = useState(initial);
  const [failed, setFailed] = useState(!initial);
  const [triedFallback, setTriedFallback] = useState(false);

  if (failed || !src) {
    return (
      <div className="hall-media-placeholder" role="img" aria-label="图不可用">
        图不可用
      </div>
    );
  }

  return (
    <img
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

export function HallPage({ user, loading, onLogin, onRegister, onLogout }: Props) {
  const [posts, setPosts] = useState<GalleryPost[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState("");
  /** 已提交搜索词：仅点搜索 / Enter 时更新，避免输入框每个字都打 listPosts */
  const [appliedQ, setAppliedQ] = useState("");
  const [error, setError] = useState("");
  const [active, setActive] = useState<GalleryPost | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [rating, setRating] = useState(5);
  const [busy, setBusy] = useState(false);
  const [forceAuth, setForceAuth] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  /** 详情内大图预览（页内 lightbox，不离开大厅） */
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const needLogin = useCallback(() => {
    setForceAuth(true);
  }, []);

  const load = useCallback(async () => {
    setListLoading(true);
    setError("");
    try {
      const res = await communityApi.listPosts({
        limit: PAGE_SIZE,
        q: appliedQ.trim() || undefined,
      });
      setPosts(res.items);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setListLoading(false);
    }
  }, [appliedQ]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const res = await communityApi.listPosts({
        limit: PAGE_SIZE,
        cursor: nextCursor,
        q: appliedQ.trim() || undefined,
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
  }, [nextCursor, loadingMore, appliedQ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!lightboxSrc) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxSrc(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightboxSrc]);

  function submitSearch() {
    setAppliedQ(q.trim());
  }

  async function openPost(post: GalleryPost) {
    setPromptCopied(false);
    setPromptExpanded(false);
    setLightboxSrc(null);
    setActive(post);
    setCommentBody("");
    try {
      const list = await communityApi.listComments(post.id);
      setComments(list);
      const fresh = await communityApi.getPost(post.id);
      if (fresh) setActive(fresh);
    } catch (e) {
      log("error", "加载评论失败", e instanceof Error ? e.message : String(e));
    }
  }

  function closeActive() {
    setLightboxSrc(null);
    setActive(null);
  }

  function openDetailLightbox(post: GalleryPost) {
    const url = resolvePostImageUrl(post);
    if (!url) {
      log("warn", "大图地址不可用");
      return;
    }
    setLightboxSrc(url);
  }

  async function handleLike(post: GalleryPost) {
    if (!user) {
      needLogin();
      return;
    }
    try {
      const next = await communityApi.toggleLike(post.id);
      setPosts((prev) => prev.map((p) => (p.id === next.id ? next : p)));
      if (active?.id === next.id) setActive(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "点赞失败");
    }
  }

  async function handleComment() {
    if (!user) {
      needLogin();
      return;
    }
    if (!active) return;
    setBusy(true);
    try {
      const cmt = await communityApi.addComment(active.id, {
        body: commentBody,
        rating,
      });
      setComments((prev) => [...prev, cmt]);
      setCommentBody("");
      const fresh = await communityApi.getPost(active.id);
      if (fresh) {
        setActive(fresh);
        setPosts((prev) => prev.map((p) => (p.id === fresh.id ? fresh : p)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "评论失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(post: GalleryPost) {
    if (!user) return;
    if (!confirm("确定删除这条分享？")) return;
    try {
      await communityApi.deletePost(post.id);
      setPosts((prev) => prev.filter((p) => p.id !== post.id));
      if (active?.id === post.id) setActive(null);
      log("ok", "已删除分享");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  }

  return (
    <div className="page hall-layout">
      <HallAuthPanel
        user={user}
        loading={loading}
        forceAuth={forceAuth}
        onForceAuthHandled={() => setForceAuth(false)}
        onLogin={onLogin}
        onRegister={onRegister}
        onLogout={onLogout}
      />

      <section className="panel">
        <div className="panel-head hall-head">
          <div>
            <div className="panel-kicker">Hall</div>
            <h2 className="panel-title">分享大厅</h2>
            <p className="panel-desc">浏览大家分享的作品，点赞与点评。</p>
          </div>
          <div className="hall-search">
            <input
              className="control"
              placeholder="搜索 prompt / 作者 / 说明"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSearch();
              }}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={submitSearch}>
              搜索
            </button>
          </div>
        </div>

        {error ? (
          <div className="status err" style={{ marginBottom: 12 }}>
            {error}
          </div>
        ) : null}

        {listLoading ? (
          <div className="empty empty-compact">
            <span className="empty-title">加载中…</span>
          </div>
        ) : posts.length === 0 ? (
          <div className="empty empty-compact">
            <span className="empty-title">暂无分享</span>
            <p className="empty-text">在生图结果里点「分享到大厅」，或登录后从详情发布。</p>
          </div>
        ) : (
          <>
            <div className="hall-grid">
              {posts.map((post) => (
                <article key={post.id} className="hall-card">
                  <button type="button" className="hall-media" onClick={() => void openPost(post)}>
                    <HallPostImage key={post.id} post={post} alt={post.prompt} />
                  </button>
                  <div className="hall-card-body">
                    <div className="hall-meta">
                      <strong>{post.authorName}</strong>
                      <span>{new Date(post.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="hall-prompt" title={post.prompt}>
                      {post.caption || post.prompt}
                    </p>
                    <div className="hall-chip-row" role="group" aria-label="互动">
                      <button
                        type="button"
                        className={`hall-chip ${post.likedByMe ? "active" : ""}`}
                        onClick={() => void handleLike(post)}
                        title={post.likedByMe ? "取消点赞" : "点赞"}
                      >
                        <span className="hall-chip-icon" aria-hidden>
                          {post.likedByMe ? "♥" : "♡"}
                        </span>
                        <span>{post.likeCount}</span>
                      </button>
                      <button
                        type="button"
                        className="hall-chip"
                        title="查看点评"
                        aria-label={`点评 ${post.commentCount}`}
                        onClick={() => void openPost(post)}
                      >
                        <CommentIcon />
                        <span>{post.commentCount}</span>
                      </button>
                      <button
                        type="button"
                        className="hall-chip"
                        title="新标签打开原图"
                        aria-label="原图"
                        disabled={!resolvePostImageUrl(post)}
                        onClick={(e) => {
                          e.stopPropagation();
                          openOriginalImage(post);
                        }}
                      >
                        <span className="hall-chip-label">原图</span>
                      </button>
                      {user && (user.id === post.authorId || user.role === "admin") ? (
                        <button
                          type="button"
                          className="hall-chip hall-chip-danger"
                          onClick={() => void handleDelete(post)}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
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
          </>
        )}
      </section>

      {active ? (
        <div className="hall-drawer-backdrop" role="presentation" onClick={closeActive}>
          <aside
            className="panel hall-drawer"
            role="dialog"
            aria-label="作品详情"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="hall-drawer-top">
              <h3 className="panel-title" style={{ fontSize: 18, margin: 0 }}>
                {active.authorName}
              </h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeActive}>
                关闭
              </button>
            </div>
            <button
              type="button"
              className="hall-drawer-media"
              title="点击展开大图"
              aria-label="展开大图"
              disabled={!resolvePostImageUrl(active)}
              onClick={() => openDetailLightbox(active)}
            >
              <HallPostImage key={active.id} post={active} alt={active.prompt} />
            </button>
            <div className="hall-prompt-block">
              <div className="hall-prompt-head">
                <span className="hall-prompt-label">提示词</span>
                <div className="hall-prompt-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!active.prompt?.trim()}
                    aria-expanded={promptExpanded}
                    onClick={() => setPromptExpanded((v) => !v)}
                  >
                    {promptExpanded ? "收起" : "展开"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm hall-prompt-copy"
                    disabled={!active.prompt?.trim()}
                    onClick={() => {
                      void (async () => {
                        const ok = await copyText(active.prompt || "");
                        if (ok) {
                          setPromptCopied(true);
                          log("ok", "提示词已复制");
                          window.setTimeout(() => setPromptCopied(false), 1800);
                        } else {
                          log("error", "复制提示词失败");
                        }
                      })();
                    }}
                  >
                    {promptCopied ? "已复制" : "复制"}
                  </button>
                </div>
              </div>
              <p className={`hall-prompt-full ${promptExpanded ? "is-expanded" : "is-collapsed"}`}>
                {active.prompt}
              </p>
            </div>
            {active.caption ? <p className="panel-desc">{active.caption}</p> : null}
            <div className="hall-meta">
              <span>{active.model || "—"}</span>
              <span>
                {active.aspectRatio || ""} {active.resolution || ""}
              </span>
            </div>

            <div className="hall-comments">
              <div className="hall-comments-head">
                <h4 className="admin-section-title">点评</h4>
                <div className="hall-chip-row hall-chip-row-inline" role="group" aria-label="互动">
                  <button
                    type="button"
                    className={`hall-chip ${active.likedByMe ? "active" : ""}`}
                    onClick={() => void handleLike(active)}
                    title={active.likedByMe ? "取消点赞" : "点赞"}
                  >
                    <span className="hall-chip-icon" aria-hidden>
                      {active.likedByMe ? "♥" : "♡"}
                    </span>
                    <span>{active.likeCount}</span>
                  </button>
                  <span className="hall-chip hall-chip-static" title="评论数" aria-label={`点评 ${active.commentCount ?? comments.length}`}>
                    <CommentIcon />
                    <span>{active.commentCount ?? comments.length}</span>
                  </span>
                  <button
                    type="button"
                    className="hall-chip"
                    title="新标签打开原图"
                    aria-label="原图"
                    disabled={!resolvePostImageUrl(active)}
                    onClick={() => openOriginalImage(active)}
                  >
                    <span className="hall-chip-label">原图</span>
                  </button>
                </div>
              </div>

              {comments.length === 0 ? (
                <p className="footer-note">还没有评论，来写第一条吧。</p>
              ) : (
                <ul className="hall-comment-list">
                  {comments.map((c) => (
                    <li key={c.id}>
                      <div className="hall-meta">
                        <strong>{c.authorName}</strong>
                        {c.rating ? (
                          <span className="hall-stars" aria-label={`${c.rating} 星`}>
                            {"★".repeat(c.rating)}
                            <span className="hall-stars-empty">{"★".repeat(Math.max(0, 5 - c.rating))}</span>
                          </span>
                        ) : null}
                        <span>{new Date(c.createdAt).toLocaleString()}</span>
                      </div>
                      <p>{c.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              <div className="hall-composer">
                <label htmlFor="cmt" className="hall-composer-label">
                  写评论
                </label>
                <textarea
                  id="cmt"
                  className="textarea hall-composer-input"
                  rows={3}
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  placeholder={user ? "友善点评…" : "登录后可评论"}
                  disabled={!user || busy}
                />
                <div className="hall-composer-footer">
                  <div className="hall-rating" role="group" aria-label="星级">
                    <span className="hall-rating-label">星级</span>
                    <div className="segmented hall-rating-segmented">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          className={`chip hall-rating-chip ${rating === n ? "active" : ""}`}
                          disabled={!user || busy}
                          aria-pressed={rating === n}
                          aria-label={`${n} 星`}
                          onClick={() => setRating(n)}
                        >
                          {n}★
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="hall-composer-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm hall-composer-submit"
                      disabled={!user || busy || !commentBody.trim()}
                      onClick={() => void handleComment()}
                    >
                      {user ? "发送" : "请先登录"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {active && lightboxSrc ? (
        <div
          className="studio-lightbox-backdrop hall-lightbox-backdrop"
          role="presentation"
          onClick={() => setLightboxSrc(null)}
        >
          <div
            className="studio-lightbox hall-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="大图预览"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="studio-lightbox-media">
              <img src={lightboxSrc} alt={active.prompt || "大图预览"} decoding="async" />
            </div>
            <div className="studio-lightbox-bottom">
              <div className="studio-lightbox-meta" title={active.prompt}>
                <strong>{active.authorName}</strong>
                <span>{active.prompt}</span>
              </div>
              <div className="studio-lightbox-actions">
                <a
                  className="btn btn-secondary btn-sm"
                  href={lightboxSrc}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开原图
                </a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLightboxSrc(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
