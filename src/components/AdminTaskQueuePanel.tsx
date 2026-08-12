import { useCallback, useEffect, useMemo, useState } from "react";
import { communityApi } from "@/lib/community/client";
import type { CommunityUser } from "@/lib/community/types";
import { DEFAULT_QUEUE_POLICY } from "@/lib/community/types";
import { isLoopbackUrl, rewriteMediaUrlToSiteBase } from "@/lib/media/client";
import { log } from "@/lib/logger";
import {
  cancelServerTask,
  clearAdminServerTasks,
  listAdminServerTasks,
  type AdminTaskListResult,
  type ServerQueueClearMode,
  type ServerTask,
  type ServerTaskStatus,
  TaskQueueError,
} from "@/lib/taskQueue";

type Props = {
  communityUser: CommunityUser | null;
  communityLoading?: boolean;
  onNeedLogin?: () => void;
};

const PAGE_SIZE = 20;

const STATUS_FILTERS: Array<{ id: "all" | ServerTaskStatus; label: string }> = [
  { id: "all", label: "全部" },
  { id: "queued", label: "排队" },
  { id: "running", label: "生成中" },
  { id: "done", label: "完成" },
  { id: "failed", label: "失败" },
  { id: "cancelled", label: "已取消" },
];

function statusLabel(status: ServerTaskStatus): string {
  if (status === "queued") return "排队";
  if (status === "running") return "生成中";
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return status;
}

function formatTime(ts?: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

function resolveImage(url?: string): string | undefined {
  if (!url) return undefined;
  // 与 useStudioQueue 的 resolveServerTaskImageUrl 同源：服务端已固化好地址，
  // 只给 loopback 兜底。按 media 路径一律改写会把 Worker 链换成 Site Base 而 404。
  if (!isLoopbackUrl(url)) return url;
  const rewritten = rewriteMediaUrlToSiteBase(url);
  return rewritten || url;
}

function promptPreview(text: string, max = 72): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 站长：全站后台任务分页管理 */
export function AdminTaskQueuePanel({
  communityUser,
  communityLoading,
  onNeedLogin,
}: Props) {
  const isAdmin = communityUser?.role === "admin";
  const [items, setItems] = useState<ServerTask[]>([]);
  const [meta, setMeta] = useState<Pick<
    AdminTaskListResult,
    "total" | "limit" | "offset" | "hasMore" | "byStatus" | "stats"
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ServerTaskStatus>("all");
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [globalConcurrency, setGlobalConcurrency] = useState(
    DEFAULT_QUEUE_POLICY.globalConcurrency,
  );
  const [globalConcurrencyDraft, setGlobalConcurrencyDraft] = useState(
    DEFAULT_QUEUE_POLICY.globalConcurrency,
  );
  const [globalBusy, setGlobalBusy] = useState(false);

  const loadGlobalConcurrency = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const policy = await communityApi.getQueuePolicy();
      setGlobalConcurrency(policy.globalConcurrency);
      setGlobalConcurrencyDraft(policy.globalConcurrency);
    } catch (e) {
      log("warn", "拉取全局并发失败", e instanceof Error ? e.message : String(e));
    }
  }, [isAdmin]);

  const saveGlobalConcurrency = useCallback(async () => {
    if (!isAdmin || globalBusy) return;
    setGlobalBusy(true);
    setMessage("");
    setOk(null);
    try {
      const next = await communityApi.setQueuePolicy({
        globalConcurrency: globalConcurrencyDraft,
      });
      setGlobalConcurrency(next.globalConcurrency);
      setGlobalConcurrencyDraft(next.globalConcurrency);
      setOk(true);
      setMessage(`已保存全局并发：${next.globalConcurrency}`);
      log("ok", "全局并发已保存", next.globalConcurrency);
      // 刷新列表以同步 KPI 顶棚
      const res = await listAdminServerTasks({
        status: statusFilter === "all" ? undefined : statusFilter,
        q: query,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setItems(res.items);
      setMeta({
        total: res.total,
        limit: res.limit,
        offset: res.offset,
        hasMore: res.hasMore,
        byStatus: res.byStatus,
        stats: res.stats,
      });
    } catch (e) {
      setOk(false);
      setMessage(e instanceof Error ? e.message : "保存全局并发失败");
    } finally {
      setGlobalBusy(false);
    }
  }, [globalBusy, globalConcurrencyDraft, isAdmin, page, query, statusFilter]);

  const load = useCallback(async () => {
    if (!isAdmin) {
      setItems([]);
      setMeta(null);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await listAdminServerTasks({
        status: statusFilter === "all" ? undefined : statusFilter,
        q: query,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setItems(res.items);
      setMeta({
        total: res.total,
        limit: res.limit,
        offset: res.offset,
        hasMore: res.hasMore,
        byStatus: res.byStatus,
        stats: res.stats,
      });
      void loadGlobalConcurrency();
    } catch (e) {
      const msg =
        e instanceof TaskQueueError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      setItems([]);
      setMeta(null);
      log("error", "加载全站后台任务失败", msg);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, statusFilter, query, page, loadGlobalConcurrency]);

  useEffect(() => {
    void load();
  }, [load]);

  // 有进行中任务时轻量轮询
  useEffect(() => {
    if (!isAdmin) return;
    const active =
      (meta?.byStatus.queued || 0) + (meta?.byStatus.running || 0) > 0 ||
      items.some((t) => t.status === "queued" || t.status === "running");
    if (!active) return;
    const timer = window.setInterval(() => {
      void load();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [isAdmin, meta?.byStatus.queued, meta?.byStatus.running, items, load]);

  const pageCount = useMemo(() => {
    const total = meta?.total ?? 0;
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
  }, [meta?.total]);

  const canPrev = page > 0;
  const canNext = Boolean(meta?.hasMore);

  function applySearch() {
    setPage(0);
    setQuery(queryDraft.trim());
  }

  async function handleCancel(id: string) {
    if (busyId || bulkBusy) return;
    setBusyId(id);
    setMessage("");
    setOk(null);
    try {
      await cancelServerTask(id);
      setOk(true);
      setMessage("已取消任务");
      log("ok", "站长取消后台任务", id);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOk(false);
      setMessage(msg);
      log("error", "取消后台任务失败", msg);
    } finally {
      setBusyId(null);
    }
  }

  async function handleBulk(mode: ServerQueueClearMode) {
    if (busyId || bulkBusy) return;
    const labels: Record<ServerQueueClearMode, string> = {
      cancel_all: "取消全部进行中",
      clear_failed: "清除失败/取消",
      clear_done: "清除已完成",
      clear_all: "清除全部任务",
    };
    if (mode === "clear_all" && !window.confirm("确定清除全站全部后台任务？此操作不可恢复。")) {
      return;
    }
    setBulkBusy(mode);
    setMessage("");
    setOk(null);
    try {
      const res = await clearAdminServerTasks(mode);
      setOk(true);
      const parts = [
        labels[mode],
        res.cancelled ? `取消 ${res.cancelled}` : "",
        res.removed ? `删除 ${res.removed}` : "",
      ].filter(Boolean);
      setMessage(parts.join(" · "));
      log("ok", "站长批量处理后台任务", res);
      setPage(0);
      // load 依赖 page/query；强制刷新
      const next = await listAdminServerTasks({
        status: statusFilter === "all" ? undefined : statusFilter,
        q: query,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setItems(next.items);
      setMeta({
        total: next.total,
        limit: next.limit,
        offset: next.offset,
        hasMore: next.hasMore,
        byStatus: next.byStatus,
        stats: next.stats,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOk(false);
      setMessage(msg);
      log("error", "批量处理后台任务失败", msg);
    } finally {
      setBulkBusy(null);
    }
  }

  if (communityLoading) {
    return (
      <section className="panel user-admin-panel">
        <p className="footer-note">校验登录状态…</p>
      </section>
    );
  }

  if (!communityUser) {
    return (
      <section className="panel user-admin-panel">
        <div className="user-admin-head">
          <div>
            <div className="section-card-title">Tasks</div>
            <h3 className="admin-section-title">后台任务</h3>
            <p className="panel-desc">请先登录站长账号。</p>
          </div>
        </div>
        {onNeedLogin ? (
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-secondary" onClick={onNeedLogin}>
              去登录
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  if (!isAdmin) {
    return (
      <section className="panel user-admin-panel">
        <div className="user-admin-head">
          <div>
            <div className="section-card-title">Tasks</div>
            <h3 className="admin-section-title">后台任务</h3>
            <p className="panel-desc">仅站长可管理全站后台任务。</p>
          </div>
        </div>
      </section>
    );
  }

  const by = meta?.byStatus;
  const activeCount = (by?.queued || 0) + (by?.running || 0);

  return (
    <section className="panel user-admin-panel">
      <div className="user-admin-head">
        <div>
          <div className="section-card-title">Tasks</div>
          <h3 className="admin-section-title">后台任务</h3>
          <p className="panel-desc">全站服务端队列：查看、取消、清理。分页 {PAGE_SIZE} 条/页。</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={loading || Boolean(bulkBusy)}
          onClick={() => void load()}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      <div className="admin-status-row admin-task-stats">
        <div className="admin-status-card">
          <span className="admin-status-label">全部</span>
          <strong className="admin-status-value">{meta?.total ?? "—"}</strong>
        </div>
        <div className="admin-status-card">
          <span className="admin-status-label">进行中</span>
          <strong className="admin-status-value">{activeCount}</strong>
        </div>
        <div className="admin-status-card">
          <span className="admin-status-label">完成</span>
          <strong className="admin-status-value">{by?.done ?? 0}</strong>
        </div>
        <div className="admin-status-card">
          <span className="admin-status-label">失败</span>
          <strong className="admin-status-value">{(by?.failed || 0) + (by?.cancelled || 0)}</strong>
        </div>
        <div className="admin-status-card">
          <span className="admin-status-label">运行 / 上限</span>
          <strong
            className="admin-status-value"
            title="当前 running / 全站顶棚（下方「并发上限」可改）"
          >
            {meta?.stats?.runningCount ?? 0}/
            {meta?.stats?.concurrencyLimit ?? globalConcurrency ?? "—"}
          </strong>
        </div>
      </div>

      <div className="admin-task-bar">
        <form
          className="admin-task-search"
          onSubmit={(e) => {
            e.preventDefault();
            applySearch();
          }}
        >
          <input
            className="control"
            type="search"
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            placeholder="搜索用户 / 提示词 / 任务 id"
            aria-label="搜索后台任务"
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={loading}>
            搜索
          </button>
        </form>
        {/* 全局并发顶棚：KPI 卡已显示 当前/上限，这里只留可改的那个数 */}
        <div className="admin-task-concurrency">
          <label htmlFor="admin-qc-global">并发上限</label>
          <input
            id="admin-qc-global"
            className="control"
            type="number"
            min={1}
            max={32}
            value={globalConcurrencyDraft}
            title={`全站同时 running 的后台任务顶棚，范围 1–32，默认 8。当前生效：${globalConcurrency}`}
            onChange={(e) => setGlobalConcurrencyDraft(Number(e.target.value))}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={globalBusy || loading}
            onClick={() => void saveGlobalConcurrency()}
          >
            {globalBusy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <div className="admin-task-bar">
        <div className="segmented admin-task-status-seg" role="group" aria-label="状态筛选">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip ${statusFilter === f.id ? "active" : ""}`}
              onClick={() => {
                setStatusFilter(f.id);
                setPage(0);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="admin-task-bulk" role="group" aria-label="批量操作">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={Boolean(bulkBusy) || activeCount === 0}
            onClick={() => void handleBulk("cancel_all")}
          >
            {bulkBusy === "cancel_all" ? "取消中…" : "取消全部进行中"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={Boolean(bulkBusy) || ((by?.failed || 0) + (by?.cancelled || 0) === 0)}
            onClick={() => void handleBulk("clear_failed")}
          >
            {bulkBusy === "clear_failed" ? "清理中…" : "清除失败/取消"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={Boolean(bulkBusy) || (by?.done || 0) === 0}
            onClick={() => void handleBulk("clear_done")}
          >
            {bulkBusy === "clear_done" ? "清理中…" : "清除已完成"}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={Boolean(bulkBusy) || (meta?.total || 0) === 0}
            onClick={() => void handleBulk("clear_all")}
          >
            {bulkBusy === "clear_all" ? "清理中…" : "清除全部"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="status err" role="alert">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className={`status ${ok ? "ok" : "err"}`} role="status">
          {message}
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="footer-note">加载任务列表…</p>
      ) : items.length === 0 ? (
        <p className="footer-note">暂无匹配的后台任务</p>
      ) : (
        <div className="user-table admin-task-table" role="list">
          {items.map((t) => {
            const img = resolveImage(t.imageUrl);
            const canCancel = t.status === "queued" || t.status === "running";
            const badge =
              t.status === "done"
                ? "vip"
                : t.status === "running" || t.status === "queued"
                  ? "admin"
                  : "user";
            return (
              <div key={t.id} className="user-row admin-task-row" role="listitem">
                <div className="admin-task-thumb" aria-hidden>
                  {img && t.status === "done" ? (
                    <a
                      href={img}
                      target="_blank"
                      rel="noreferrer"
                      title={t.kind === "video" ? "打开视频" : "打开图片"}
                    >
                      {/* 视频用 <img> 是空白：走 <video> 取首帧 */}
                      {t.kind === "video" ? (
                        <video src={img} muted playsInline preload="metadata" />
                      ) : (
                        <img src={img} alt="" loading="lazy" />
                      )}
                    </a>
                  ) : (
                    <span className="admin-task-thumb-empty">{statusLabel(t.status)}</span>
                  )}
                </div>
                <div className="user-row-main admin-task-main">
                  <div className="user-row-title">
                    <strong title={t.ownerName}>@{t.ownerName || t.ownerId}</strong>
                    <span className={`user-role-badge ${badge}`}>{statusLabel(t.status)}</span>
                    {t.attempt > 1 ? (
                      <span className="footer-note">重试 {t.attempt}</span>
                    ) : null}
                  </div>
                  <p className="admin-task-prompt" title={t.prompt}>
                    {promptPreview(t.prompt)}
                  </p>
                  <div className="user-row-meta footer-note">
                    <span title={t.model}>{t.model || "—"}</span>
                    <span>
                      {t.aspectRatio || "—"} · {t.resolution || "—"}
                    </span>
                    <span>{formatTime(t.createdAt)}</span>
                    <span className="mono-tight" title={t.id}>
                      {t.id.slice(0, 12)}…
                    </span>
                  </div>
                  {t.error ? (
                    <p className="footer-note admin-task-error" title={t.error}>
                      {t.error}
                    </p>
                  ) : null}
                </div>
                <div className="user-row-actions">
                  {canCancel ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busyId === t.id || Boolean(bulkBusy)}
                      onClick={() => void handleCancel(t.id)}
                    >
                      {busyId === t.id ? "取消中…" : "取消"}
                    </button>
                  ) : img ? (
                    <a
                      className="btn btn-ghost btn-sm"
                      href={img}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="admin-task-pager">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!canPrev || loading}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          上一页
        </button>
        <span className="footer-note">
          第 {page + 1} / {pageCount} 页
          {meta ? ` · 共 ${meta.total} 条` : ""}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!canNext || loading}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );
}
