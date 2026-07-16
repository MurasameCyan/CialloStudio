import { useCallback, useEffect, useState } from "react";
import { HallAuthPanel } from "@/components/HallAuthPanel";
import { communityApi } from "@/lib/community/client";
import type { Comment, CommunityUser, GalleryPost } from "@/lib/community/types";
import { log } from "@/lib/logger";

type Props = {
  user: CommunityUser | null;
  loading?: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string, displayName?: string) => Promise<void>;
  onLogout: () => Promise<void>;
};

export function HallPage({ user, loading, onLogin, onRegister, onLogout }: Props) {
  const [posts, setPosts] = useState<GalleryPost[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [active, setActive] = useState<GalleryPost | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [rating, setRating] = useState(5);
  const [busy, setBusy] = useState(false);
  const [forceAuth, setForceAuth] = useState(false);

  const needLogin = useCallback(() => {
    setForceAuth(true);
  }, []);

  const load = useCallback(async () => {
    setListLoading(true);
    setError("");
    try {
      const res = await communityApi.listPosts({ limit: 40, q: q.trim() || undefined });
      setPosts(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setListLoading(false);
    }
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openPost(post: GalleryPost) {
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
            <p className="panel-desc">
              浏览大家分享的作品，点赞与点评。当前为{" "}
              <strong>{communityApi.mode() === "mock" ? "Mock（本地）" : "HTTP API"}</strong>{" "}
              模式。
            </p>
          </div>
          <div className="hall-search">
            <input
              className="control"
              placeholder="搜索 prompt / 作者 / 说明"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
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
          <div className="hall-grid">
            {posts.map((post) => (
              <article key={post.id} className="hall-card">
                <button type="button" className="hall-media" onClick={() => void openPost(post)}>
                  <img src={post.imageUrl} alt={post.prompt} loading="lazy" />
                </button>
                <div className="hall-card-body">
                  <div className="hall-meta">
                    <strong>{post.authorName}</strong>
                    <span>{new Date(post.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="hall-prompt" title={post.prompt}>
                    {post.caption || post.prompt}
                  </p>
                  <div className="hall-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleLike(post)}>
                      {post.likedByMe ? "已赞" : "赞"} {post.likeCount}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openPost(post)}>
                      评 {post.commentCount}
                    </button>
                    {user && (user.id === post.authorId || user.role === "admin") ? (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => void handleDelete(post)}
                      >
                        删
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {active ? (
        <div className="hall-drawer-backdrop" role="presentation" onClick={() => setActive(null)}>
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
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActive(null)}>
                关闭
              </button>
            </div>
            <div className="hall-drawer-media">
              <img src={active.imageUrl} alt={active.prompt} />
            </div>
            <p className="hall-prompt-full">{active.prompt}</p>
            {active.caption ? <p className="panel-desc">{active.caption}</p> : null}
            <div className="hall-meta">
              <span>{active.model || "—"}</span>
              <span>
                {active.aspectRatio || ""} {active.resolution || ""}
              </span>
            </div>

            <div className="hall-comments">
              <h4 className="admin-section-title">点评</h4>
              {comments.length === 0 ? (
                <p className="footer-note">还没有评论，来写第一条吧。</p>
              ) : (
                <ul className="hall-comment-list">
                  {comments.map((c) => (
                    <li key={c.id}>
                      <div className="hall-meta">
                        <strong>{c.authorName}</strong>
                        {c.rating ? <span>{"★".repeat(c.rating)}</span> : null}
                        <span>{new Date(c.createdAt).toLocaleString()}</span>
                      </div>
                      <p>{c.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="cmt">写评论</label>
                <textarea
                  id="cmt"
                  className="textarea"
                  rows={3}
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  placeholder={user ? "友善点评…" : "登录后可评论"}
                  disabled={!user || busy}
                />
                <div className="hall-actions" style={{ marginTop: 8 }}>
                  <label className="footer-note">
                    星级{" "}
                    <select
                      className="control"
                      style={{ width: "auto", display: "inline-block" }}
                      value={rating}
                      onChange={(e) => setRating(Number(e.target.value))}
                      disabled={!user || busy}
                    >
                      {[5, 4, 3, 2, 1].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!user || busy || !commentBody.trim()}
                    onClick={() => void handleComment()}
                  >
                    {user ? "发送" : "请先登录"}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleLike(active)}>
                    {active.likedByMe ? "取消赞" : "点赞"} {active.likeCount}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
